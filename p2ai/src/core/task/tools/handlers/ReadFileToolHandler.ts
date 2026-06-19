import fs from "fs/promises"
import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { recordP2AiDiagnosticEvent } from "@core/observability/p2ai-artifacts"
import { formatResponse } from "@core/prompts/responses"
import { getWorkspaceBasename, resolveWorkspacePath } from "@core/workspace"
import { extractFileContent, getErrorMessage, isFileMissingPathError } from "@integrations/misc/extract-file-content"
import { arePathsEqual, getReadablePath, isLocatedInPath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { ClineSayTool } from "@/shared/ExtensionMessage"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"

type ReadFileRecoveryResult =
	| { kind: "auto_read"; content: ToolResponse }
	| { kind: "suggest"; candidates: string[] }

type ReadFileCandidate = {
	absolutePath: string
	relativePath: string
	score: number
	distance: number
}

export class ReadFileToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.FILE_READ

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPath = block.params.path

		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const sharedMessageProps = {
			tool: "readFile",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", relPath)),
			content: undefined,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		// Handle auto-approval vs manual approval for partial
		if (await uiHelpers.shouldAutoApproveToolWithPath(block.name, relPath)) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
			await uiHelpers.ask("tool", partialMessage, block.partial).catch(() => {})
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relPath: string | undefined = block.params.path

		// Extract provider information for telemetry
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Validate required parameters
		const pathValidation = this.validator.assertRequiredParams(block, "path")
		if (!pathValidation.ok) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "path")
		}

		// Check clineignore access
		const accessValidation = this.validator.checkClineIgnorePath(relPath!)
		if (!accessValidation.ok) {
			if (!config.isSubagentExecution) {
				await config.callbacks.say("clineignore_error", relPath)
			}
			return formatResponse.toolError(formatResponse.clineIgnoreError(relPath!))
		}

		config.taskState.consecutiveMistakeCount = 0

		// Resolve the absolute path based on multi-workspace configuration
		const pathResult = resolveWorkspacePath(config, relPath!, "ReadFileToolHandler.execute")
		const { absolutePath, displayPath, resolvedPath } =
			typeof pathResult === "string"
				? { absolutePath: pathResult, displayPath: relPath!, resolvedPath: relPath! }
				: pathResult

		// Determine workspace context for telemetry
		const fallbackAbsolutePath = path.resolve(config.cwd, relPath ?? "")
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: typeof pathResult !== "string", // multi-root path result indicates hint usage
			resolvedToNonPrimary: !arePathsEqual(absolutePath, fallbackAbsolutePath),
			resolutionMethod: (typeof pathResult !== "string" ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		// Handle approval flow
		const sharedMessageProps = {
			tool: "readFile",
			path: getReadablePath(config.cwd, displayPath),
			content: absolutePath,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath!),
		} satisfies ClineSayTool

		const completeMessage = JSON.stringify(sharedMessageProps)

		const shouldAutoApprove =
			config.isSubagentExecution || (await config.callbacks.shouldAutoApproveToolWithPath(block.name, relPath))
		if (shouldAutoApprove) {
			// Auto-approval flow
			if (!config.isSubagentExecution) {
				await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
				await config.callbacks.say("tool", completeMessage, undefined, undefined, false)
			}

			// Capture telemetry
			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				true,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
		} else {
			// Manual approval flow
			const notificationMessage = `Cline wants to read ${getWorkspaceBasename(absolutePath, "ReadFileToolHandler.notification")}`

			// Show notification
			showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)

			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")

			const didApprove = await ToolResultUtils.askApprovalAndPushFeedback("tool", completeMessage, config)
			if (!didApprove) {
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					false,
					false,
					workspaceContext,
					block.isNativeToolCall,
				)
				return formatResponse.toolDenied()
			}
			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				false,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
		}

		// Run PreToolUse hook after approval but before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		// Execute the actual file read operation
		const supportsImages = config.api.getModel().info.supportsImages ?? false
		try {
			const fileContent = await extractFileContent(absolutePath, supportsImages)

			// Track file read operation
			await config.services.fileContextTracker.trackFileContext(relPath!, "read_tool")

			// Handle image blocks separately - they need to be pushed to userMessageContent
			if (fileContent.imageBlock) {
				config.taskState.userMessageContent.push(fileContent.imageBlock)
			}

			return fileContent.text
		} catch (error) {
			if (!isFileMissingPathError(error)) {
				return formatResponse.toolError(`Error executing read_file: ${getErrorMessage(error)}`)
			}

			const recovery = await this.resolveReadFileMissingPath({
				config,
				requestedRelPath: resolvedPath,
				requestedAbsPath: absolutePath,
				displayPath,
				supportsImages,
				block,
			})

			if (recovery.kind === "auto_read") {
				return recovery.content
			}

			return formatResponse.toolError(
				[
					`Error executing read_file: File not found: ${getReadablePath(config.cwd, displayPath)}`,
					recovery.candidates.length > 0 ? "Closest allowed candidates:" : "No safe candidate found.",
					...recovery.candidates.map((candidate, index) => `${index + 1}) ${candidate}`),
				]
					.filter(Boolean)
					.join("\n"),
			)
		}
	}

	private async resolveReadFileMissingPath(params: {
		config: TaskConfig
		requestedRelPath: string
		requestedAbsPath: string
		displayPath: string
		supportsImages: boolean
		block: ToolUse
	}): Promise<ReadFileRecoveryResult> {
		const { config, requestedRelPath, requestedAbsPath, supportsImages, block } = params
		const workspaceRoot = this.workspaceRootForResolvedPath(config, requestedAbsPath)
		if (!workspaceRoot) {
			this.recordReadFileRecovery("outside_workspace", requestedRelPath, [], 0, 0)
			return { kind: "suggest", candidates: [] }
		}

		const requestedDirRel = path.dirname(requestedRelPath).replaceAll("\\", "/")
		const requestedBase = path.basename(requestedRelPath)
		const requestedExt = path.extname(requestedBase).toLowerCase()
		const requestedDirAbs = path.resolve(workspaceRoot, requestedDirRel)

		if (!isLocatedInPath(workspaceRoot, requestedDirAbs)) {
			this.recordReadFileRecovery("outside_workspace_directory", requestedRelPath, [], 0, 0)
			return { kind: "suggest", candidates: [] }
		}

		const entries = await fs.readdir(requestedDirAbs, { withFileTypes: true }).catch(() => undefined)
		if (!entries) {
			this.recordReadFileRecovery("directory_unreadable", requestedRelPath, [], 0, 0)
			return { kind: "suggest", candidates: [] }
		}

		const ranked = (
			await Promise.all(
				entries
					.filter((entry) => entry.isFile())
					.filter((entry) => path.extname(entry.name).toLowerCase() === requestedExt)
					.map(async (entry) => {
						const candidateAbs = path.join(requestedDirAbs, entry.name)
						const realCandidate = await fs.realpath(candidateAbs).catch(() => undefined)
						if (!realCandidate || !isLocatedInPath(workspaceRoot, realCandidate)) {
							return undefined
						}

						const candidateRel = path.join(requestedDirRel, entry.name).replaceAll("\\", "/")
						if (!this.validator.checkClineIgnorePath(candidateRel).ok) {
							return undefined
						}

						return {
							absolutePath: realCandidate,
							relativePath: candidateRel,
							score: this.scoreFilenameMatch(requestedBase, entry.name),
							distance: this.editDistance(this.canonicalName(requestedBase), this.canonicalName(entry.name)),
						}
					}),
			)
		)
			.filter((candidate): candidate is ReadFileCandidate => Boolean(candidate))
			.sort((a, b) => b.score - a.score || a.distance - b.distance || a.relativePath.localeCompare(b.relativePath))

		const suggestions = ranked.slice(0, 5).map((candidate) => candidate.relativePath)
		const top = ranked[0]
		const second = ranked[1]
		const gap = top && second ? top.score - second.score : top ? top.score : 0
		const canAutoRead = Boolean(top && top.distance <= 3 && top.score >= 80 && gap >= 8)

		this.recordReadFileRecovery(
			canAutoRead ? "same_directory_auto_candidate" : "suggest_only",
			requestedRelPath,
			suggestions,
			top?.score ?? 0,
			gap,
		)

		if (!top || !canAutoRead) {
			return { kind: "suggest", candidates: suggestions }
		}

		if (!config.isSubagentExecution && !(await config.callbacks.shouldAutoApproveToolWithPath(block.name, top.relativePath))) {
			return { kind: "suggest", candidates: suggestions }
		}

		const repairedContent = await extractFileContent(top.absolutePath, supportsImages)
		await config.services.fileContextTracker.trackFileContext(top.relativePath, "read_tool")
		if (repairedContent.imageBlock) {
			config.taskState.userMessageContent.push(repairedContent.imageBlock)
		}

		recordP2AiDiagnosticEvent({
			event: "read_file_missing_path_auto_repaired",
			message: "read_file auto-repaired missing filename in same directory",
			payload: {
				requested_path: requestedRelPath,
				repaired_path: top.relativePath,
				score: top.score,
				distance: top.distance,
			},
		})

		return { kind: "auto_read", content: repairedContent.text }
	}

	private workspaceRootForResolvedPath(config: TaskConfig, absolutePath: string): string | undefined {
		if (config.isMultiRootEnabled && config.workspaceManager) {
			const root = config.workspaceManager.getRoots().find((candidate) => isLocatedInPath(candidate.path, absolutePath))
			return root?.path
		}
		return isLocatedInPath(config.cwd, absolutePath) ? config.cwd : undefined
	}

	private recordReadFileRecovery(
		strategy: string,
		requestedPath: string,
		candidates: string[],
		topScore: number,
		topGap: number,
	): void {
		recordP2AiDiagnosticEvent({
			event: "read_file_missing_path_resolution",
			message: "read_file missing path candidate resolution",
			payload: {
				requested_path: requestedPath,
				strategy,
				top_score: topScore,
				top_gap: topGap,
				candidates,
			},
		})
	}

	private canonicalName(value: string): string {
		return value.toLowerCase().replace(/[^a-z0-9]/g, "")
	}

	private scoreFilenameMatch(requestedBase: string, candidateBase: string): number {
		const requested = this.canonicalName(requestedBase)
		const candidate = this.canonicalName(candidateBase)
		if (!requested || !candidate) {
			return 0
		}
		const distance = this.editDistance(requested, candidate)
		return ((Math.max(requested.length, candidate.length) - distance) / Math.max(requested.length, candidate.length)) * 100
	}

	private editDistance(a: string, b: string): number {
		const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
		for (let i = 0; i <= a.length; i++) {
			dp[i]![0] = i
		}
		for (let j = 0; j <= b.length; j++) {
			dp[0]![j] = j
		}
		for (let i = 1; i <= a.length; i++) {
			for (let j = 1; j <= b.length; j++) {
				dp[i]![j] =
					a[i - 1] === b[j - 1]
						? dp[i - 1]![j - 1]!
						: Math.min(dp[i - 1]![j - 1]!, dp[i - 1]![j]!, dp[i]![j - 1]!) + 1
			}
		}
		return dp[a.length]![b.length]!
	}
}
