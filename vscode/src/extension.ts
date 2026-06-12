// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import assert from "node:assert"
import { DIFF_VIEW_URI_SCHEME } from "@hosts/vscode/VscodeDiffViewProvider"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { sendAccountButtonClickedEvent } from "./core/controller/ui/subscribeToAccountButtonClicked"
import { sendChatButtonClickedEvent } from "./core/controller/ui/subscribeToChatButtonClicked"
import { sendHistoryButtonClickedEvent } from "./core/controller/ui/subscribeToHistoryButtonClicked"
import { sendMcpButtonClickedEvent } from "./core/controller/ui/subscribeToMcpButtonClicked"
import { sendSettingsButtonClickedEvent } from "./core/controller/ui/subscribeToSettingsButtonClicked"
import { sendWorktreesButtonClickedEvent } from "./core/controller/ui/subscribeToWorktreesButtonClicked"
import { WebviewProvider } from "./core/webview"
import { createClineAPI } from "./exports"
import { initializeTestMode } from "./services/test/TestMode"
import "./utils/path" // necessary to have access to String.prototype.toPosix
import path from "node:path"
import type { ExtensionContext } from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { vscodeHostBridgeClient } from "@/hosts/vscode/hostbridge/client/host-grpc-client"
import { readTextFromClipboard, writeTextToClipboard } from "@/utils/env"
import { initialize, tearDown } from "./common"
import { addToCline } from "./core/controller/commands/addToCline"
import { explainWithCline } from "./core/controller/commands/explainWithCline"
import { fixWithCline } from "./core/controller/commands/fixWithCline"
import { improveWithCline } from "./core/controller/commands/improveWithCline"
import { sendAddToInputEvent } from "./core/controller/ui/subscribeToAddToInput"
import { sendShowWebviewEvent } from "./core/controller/ui/subscribeToShowWebview"
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache"
import { recordP2AiDiagnosticEvent } from "./core/observability/p2ai-artifacts"
import { StateManager } from "./core/storage/StateManager"
import {
	cleanupMcpMarketplaceCatalogFromGlobalState,
	cleanupOldApiKey,
	migrateCustomInstructionsToGlobalRules,
	migrateTaskHistoryToFile,
	migrateWelcomeViewCompleted,
	migrateWorkspaceToGlobalStorage,
} from "./core/storage/state-migrations"
import { workspaceResolver } from "./core/workspace"
import { findMatchingNotebookCell, getContextForCommand, showWebview } from "./hosts/vscode/commandUtils"
import { abortCommitGeneration, generateCommitMsg } from "./hosts/vscode/commit-message-generator"
import { registerClineOutputChannel } from "./hosts/vscode/hostbridge/env/debugLog"
import {
	disposeVscodeCommentReviewController,
	getVscodeCommentReviewController,
} from "./hosts/vscode/review/VscodeCommentReviewController"
import { VscodeTerminalManager } from "./hosts/vscode/terminal/VscodeTerminalManager"
import { VscodeDiffViewProvider } from "./hosts/vscode/VscodeDiffViewProvider"
import { VscodeWebviewProvider } from "./hosts/vscode/VscodeWebviewProvider"
import { ExtensionRegistryInfo } from "./registry"
import { AuthService } from "./services/auth/AuthService"
import { LogoutReason } from "./services/auth/types"
import { telemetryService } from "./services/telemetry"
import { SharedUriHandler, TASK_URI_PATH } from "./services/uri/SharedUriHandler"
import { ShowMessageType } from "./shared/proto/host/window"
import { fileExistsAtPath } from "./utils/fs"

let p2aiOutputChannel: vscode.OutputChannel | undefined
let p2aiStatusBarItem: vscode.StatusBarItem | undefined
let p2aiMonitorPanel: vscode.WebviewPanel | undefined
const p2aiMonitorEvents: { event: string; message: string; payload: Record<string, unknown>; at: string }[] = []

function p2aiVisualDiagnosticsEnabled(): boolean {
	return process.env.P2AI_CLINE_VISUAL_DIAGNOSTICS !== "0"
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
}

function renderP2AiMonitorHtml(): string {
	const latest = p2aiMonitorEvents[p2aiMonitorEvents.length - 1]
	const rows = p2aiMonitorEvents
		.slice(-12)
		.reverse()
		.map(
			(item) => `
				<tr>
					<td>${escapeHtml(item.at)}</td>
					<td>${escapeHtml(item.event)}</td>
					<td>${escapeHtml(item.message)}</td>
				</tr>`,
		)
		.join("")
	return `<!doctype html>
	<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<style>
			body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px; }
			h1 { margin: 0 0 8px; font-size: 24px; }
			.badge { display: inline-block; padding: 4px 8px; border: 1px solid var(--vscode-focusBorder); border-radius: 4px; margin-bottom: 16px; }
			.grid { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; max-width: 1100px; }
			.key { color: var(--vscode-descriptionForeground); }
			pre { background: var(--vscode-textCodeBlock-background); padding: 12px; overflow: auto; max-height: 360px; }
			table { border-collapse: collapse; width: 100%; margin-top: 18px; }
			td, th { border-bottom: 1px solid var(--vscode-panel-border); padding: 8px; text-align: left; vertical-align: top; }
		</style>
	</head>
	<body>
		<h1>C2Ai Dev Monitor</h1>
		<div class="badge">${escapeHtml(latest?.message ?? "waiting")}</div>
		<div class="grid">
			<div class="key">Laatste event</div><div>${escapeHtml(latest?.event ?? "-")}</div>
			<div class="key">Tijd</div><div>${escapeHtml(latest?.at ?? "-")}</div>
			<div class="key">Extension</div><div>${escapeHtml(String(latest?.payload?.extension_id ?? "-"))}</div>
			<div class="key">Pad</div><div>${escapeHtml(String(latest?.payload?.extension_path ?? "-"))}</div>
			<div class="key">Sidebar id</div><div>${escapeHtml(String(latest?.payload?.sidebar_id ?? "-"))}</div>
			<div class="key">Model</div><div>${escapeHtml(String(latest?.payload?.lmStudioModelId ?? "-"))}</div>
			<div class="key">Artifact root</div><div>${escapeHtml(String(latest?.payload?.artifact_root ?? process.env.P2AI_CLINE_ARTIFACT_ROOT ?? "-"))}</div>
			<div class="key">Task</div><div>${escapeHtml(String(latest?.payload?.task ?? "-"))}</div>
		</div>
		<h2>Laatste payload</h2>
		<pre>${escapeHtml(JSON.stringify(latest?.payload ?? {}, null, 2))}</pre>
		<h2>Events</h2>
		<table>
			<thead><tr><th>Tijd</th><th>Event</th><th>Status</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>
	</body>
	</html>`
}

function updateP2AiMonitor(context: vscode.ExtensionContext) {
	if (process.env.P2AI_CLINE_DEV_MONITOR === "0") {
		return
	}
	if (!p2aiMonitorPanel) {
		p2aiMonitorPanel = vscode.window.createWebviewPanel("c2aiDevMonitor", "C2Ai Dev Monitor", vscode.ViewColumn.One, {
			enableScripts: false,
			retainContextWhenHidden: true,
		})
		context.subscriptions.push(
			p2aiMonitorPanel.onDidDispose(() => {
				p2aiMonitorPanel = undefined
			}),
		)
	}
	p2aiMonitorPanel.webview.html = renderP2AiMonitorHtml()
	p2aiMonitorPanel.reveal(vscode.ViewColumn.One, false)
}

function p2aiVisualLog(
	context: vscode.ExtensionContext,
	event: string,
	message: string,
	payload: Record<string, unknown> = {},
	notify = false,
) {
	if (!p2aiVisualDiagnosticsEnabled()) {
		return
	}
	if (!p2aiOutputChannel) {
		p2aiOutputChannel = vscode.window.createOutputChannel("C2Ai Dev")
		context.subscriptions.push(p2aiOutputChannel)
	}
	if (!p2aiStatusBarItem) {
		p2aiStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000)
		p2aiStatusBarItem.name = "C2Ai Dev"
		p2aiStatusBarItem.command = `${VscodeWebviewProvider.SIDEBAR_ID}.focus`
		context.subscriptions.push(p2aiStatusBarItem)
	}
	const enrichedPayload = {
		extension_id: ExtensionRegistryInfo.id,
		extension_path: context.extensionPath,
		sidebar_id: VscodeWebviewProvider.SIDEBAR_ID,
		...payload,
	}
	p2aiMonitorEvents.push({ event, message, payload: enrichedPayload, at: new Date().toISOString() })
	p2aiOutputChannel.appendLine(`[${new Date().toISOString()}] ${event}: ${message}`)
	p2aiOutputChannel.appendLine(JSON.stringify(enrichedPayload, null, 2))
	p2aiStatusBarItem.text = `$(hubot) C2Ai: ${message}`
	p2aiStatusBarItem.tooltip = JSON.stringify(enrichedPayload, null, 2).slice(0, 1500)
	p2aiStatusBarItem.show()
	Logger.log(`[P2AI C2Ai] ${event}: ${message}`)
	recordP2AiDiagnosticEvent({ event, message, payload: enrichedPayload })
	updateP2AiMonitor(context)
	if (notify) {
		void vscode.window.showInformationMessage(`C2Ai: ${message}`)
	}
}

// This method is called when the VS Code extension is activated.
// NOTE: This is VS Code specific - services that should be registered
// for all-platform should be registered in common.ts.
export async function activate(context: vscode.ExtensionContext) {
	const activationStartTime = performance.now()

	// 1. Set up HostProvider for VSCode
	// IMPORTANT: This must be done before any service can be registered
	setupHostProvider(context)

	// 2. Register services and perform common initialization
	// IMPORTANT: Must be done after host provider is setup
	const webview = (await initialize(context)) as VscodeWebviewProvider

	// 3. Register services and commands specific to VS Code
	// Initialize test mode and add disposables to context
	const testModeWatchers = await initializeTestMode(webview)
	context.subscriptions.push(...testModeWatchers)

	// Perform storage migrations that does not block extension activation
	performStorageMigrations(context)

	// Initialize hook discovery cache for performance optimization
	HookDiscoveryCache.getInstance().initialize(
		context as any, // Adapt VSCode ExtensionContext to generic interface
		(dir: string) => {
			try {
				const pattern = new vscode.RelativePattern(dir, "*")
				const watcher = vscode.workspace.createFileSystemWatcher(pattern)
				// Ensure watcher is disposed when extension is deactivated
				context.subscriptions.push(watcher)
				// Adapt VSCode FileSystemWatcher to generic interface
				return {
					onDidCreate: (listener: () => void) => watcher.onDidCreate(listener),
					onDidChange: (listener: () => void) => watcher.onDidChange(listener),
					onDidDelete: (listener: () => void) => watcher.onDidDelete(listener),
					dispose: () => watcher.dispose(),
				}
			} catch {
				return null
			}
		},
		(callback: () => void) => {
			// Adapt VSCode Disposable to generic interface
			const disposable = vscode.workspace.onDidChangeWorkspaceFolders(callback)
			context.subscriptions.push(disposable)
			return disposable
		},
	)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VscodeWebviewProvider.SIDEBAR_ID, webview, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)
	p2aiVisualLog(
		context,
		"activation_visible",
		"C2Ai dev extension active",
		{
			activation_elapsed_ms: Math.round(performance.now() - activationStartTime),
			artifact_root: process.env.P2AI_CLINE_ARTIFACT_ROOT || process.env.CLINE_ARTIFACT_ROOT,
		},
		true,
	)
	scheduleP2AiAutostart(context, webview)

	// NOTE: Commands must be added to the internal registry before registering them with VSCode
	const { commands } = ExtensionRegistryInfo

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.PlusButton, async () => {
			const sidebarInstance = WebviewProvider.getInstance()
			await sidebarInstance.controller.clearTask()
			await sidebarInstance.controller.postStateToWebview()
			await sendChatButtonClickedEvent()
		}),
	)
	context.subscriptions.push(vscode.commands.registerCommand(commands.McpButton, () => sendMcpButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.SettingsButton, () => sendSettingsButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.HistoryButton, () => sendHistoryButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.AccountButton, () => sendAccountButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.WorktreesButton, () => sendWorktreesButtonClickedEvent()))

	/*
	We use the text document content provider API to show the left side for diff view by creating a
	virtual document for the original content. This makes it readonly so users know to edit the right
	side if they want to keep their changes.

	- This API allows you to create readonly documents in VSCode from arbitrary sources, and works by
	claiming an uri-scheme for which your provider then returns text contents. The scheme must be
	provided when registering a provider and cannot change afterwards.
	- Note how the provider doesn't create uris for virtual documents - its role is to provide contents
	 given such an uri. In return, content providers are wired into the open document logic so that
	 providers are always considered.
	https://code.visualstudio.com/api/extension-guides/virtual-documents
	*/
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))

	const handleUri = async (uri: vscode.Uri) => {
		const url = decodeURIComponent(uri.toString())
		const isTaskUri = getUriPath(url) === TASK_URI_PATH

		if (isTaskUri) {
			await openClineSidebarForTaskUri()
		}

		let success = await SharedUriHandler.handleUri(url)

		// Task deeplinks can race with first-time sidebar initialization.
		if (!success && isTaskUri) {
			await openClineSidebarForTaskUri()
			success = await SharedUriHandler.handleUri(url)
		}

		if (!success) {
			Logger.warn("Extension URI handler: Failed to process URI:", uri.toString())
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register size testing commands in development mode
	if (IS_DEV) {
		vscode.commands.executeCommand("setContext", "cline.isDevMode", IS_DEV)
		// Use dynamic import to avoid loading the module in production
		import("./dev/commands/tasks")
			.then((module) => {
				const devTaskCommands = module.registerTaskCommands(webview.controller)
				context.subscriptions.push(...devTaskCommands)
				Logger.log("[Cline Dev] Dev mode activated & dev commands registered")
			})
			.catch((error) => {
				Logger.log("[Cline Dev] Failed to register dev commands: " + error)
			})
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.TerminalOutput, async () => {
			const terminal = vscode.window.activeTerminal
			if (!terminal) {
				return
			}

			// Save current clipboard content
			const tempCopyBuffer = await readTextFromClipboard()

			try {
				// Copy the *existing* terminal selection (without selecting all)
				await vscode.commands.executeCommand("workbench.action.terminal.copySelection")

				// Get copied content
				const terminalContents = (await readTextFromClipboard()).trim()

				// Restore original clipboard content
				await writeTextToClipboard(tempCopyBuffer)

				if (!terminalContents) {
					// No terminal content was copied (either nothing selected or some error)
					return
				}
				// Ensure the sidebar view is visible but preserve editor focus
				await showWebview(true)

				await sendAddToInputEvent(`Terminal output:\n\`\`\`\n${terminalContents}\n\`\`\``)

				Logger.log("addSelectedTerminalOutputToChat", terminalContents, terminal.name)
			} catch (error) {
				// Ensure clipboard is restored even if an error occurs
				await writeTextToClipboard(tempCopyBuffer)
				Logger.error("Error getting terminal contents:", error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Failed to get terminal contents",
				})
			}
		}),
	)

	// Register code action provider
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			"*",
			new (class implements vscode.CodeActionProvider {
				public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]

				provideCodeActions(
					document: vscode.TextDocument,
					range: vscode.Range,
					context: vscode.CodeActionContext,
				): vscode.CodeAction[] {
					const CONTEXT_LINES_TO_EXPAND = 3
					const START_OF_LINE_CHAR_INDEX = 0
					const LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING = 1

					const actions: vscode.CodeAction[] = []
					const editor = vscode.window.activeTextEditor // Get active editor for selection check

					// Expand range to include surrounding 3 lines or use selection if broader
					const selection = editor?.selection
					let expandedRange = range
					if (
						editor &&
						selection &&
						!selection.isEmpty &&
						selection.contains(range.start) &&
						selection.contains(range.end)
					) {
						expandedRange = selection
					} else {
						expandedRange = new vscode.Range(
							Math.max(0, range.start.line - CONTEXT_LINES_TO_EXPAND),
							START_OF_LINE_CHAR_INDEX,
							Math.min(
								document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
								range.end.line + CONTEXT_LINES_TO_EXPAND,
							),
							document.lineAt(
								Math.min(
									document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
									range.end.line + CONTEXT_LINES_TO_EXPAND,
								),
							).text.length,
						)
					}

					// Add to Cline (Always available)
					const addAction = new vscode.CodeAction("Add to Cline", vscode.CodeActionKind.QuickFix)
					addAction.command = {
						command: commands.AddToChat,
						title: "Add to Cline",
						arguments: [expandedRange, context.diagnostics],
					}
					actions.push(addAction)

					// Explain with Cline (Always available)
					const explainAction = new vscode.CodeAction("Explain with Cline", vscode.CodeActionKind.RefactorExtract) // Using a refactor kind
					explainAction.command = {
						command: commands.ExplainCode,
						title: "Explain with Cline",
						arguments: [expandedRange],
					}
					actions.push(explainAction)

					// Improve with Cline (Always available)
					const improveAction = new vscode.CodeAction("Improve with Cline", vscode.CodeActionKind.RefactorRewrite) // Using a refactor kind
					improveAction.command = {
						command: commands.ImproveCode,
						title: "Improve with Cline",
						arguments: [expandedRange],
					}
					actions.push(improveAction)

					// Fix with Cline (Only if diagnostics exist)
					if (context.diagnostics.length > 0) {
						const fixAction = new vscode.CodeAction("Fix with Cline", vscode.CodeActionKind.QuickFix)
						fixAction.isPreferred = true
						fixAction.command = {
							command: commands.FixWithCline,
							title: "Fix with Cline",
							arguments: [expandedRange, context.diagnostics],
						}
						actions.push(fixAction)
					}
					return actions
				}
			})(),
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.QuickFix,
					vscode.CodeActionKind.RefactorExtract,
					vscode.CodeActionKind.RefactorRewrite,
				],
			},
		),
	)

	// Register the command handlers
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.AddToChat, async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics)
			if (!context) {
				return
			}
			await addToCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FixWithCline, async (range: vscode.Range, diagnostics: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics)
			if (!context) {
				return
			}
			await fixWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ExplainCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await explainWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ImproveCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await improveWithCline(context.controller, context.commandContext)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FocusChatInput, async (preserveEditorFocus = false) => {
			const webview = WebviewProvider.getInstance() as VscodeWebviewProvider

			// Show the webview
			const webviewView = webview.getWebview()
			if (webviewView) {
				if (preserveEditorFocus) {
					// Only make webview visible without forcing focus
					webviewView.show(false)
				} else {
					// Show and force focus (default behavior for explicit focus actions)
					webviewView.show(true)
				}
			}

			// Send show webview event with preserveEditorFocus flag
			sendShowWebviewEvent(preserveEditorFocus)
			telemetryService.captureButtonClick("command_focusChatInput", webview.controller?.task?.ulid)
		}),
	)

	// Register Jupyter Notebook command handlers
	const NOTEBOOK_EDIT_INSTRUCTIONS = `Special considerations for using replace_in_file on *.ipynb files:
* Jupyter notebook files are JSON format with specific structure for source code cells
* Source code in cells is stored as JSON string arrays ending with explicit \\n characters and commas
* Always match the exact JSON format including quotes, commas, and escaped newlines.`

	// Helper to get notebook context for Jupyter commands
	async function getNotebookCommandContext(range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) {
		const activeNotebook = vscode.window.activeNotebookEditor
		if (!activeNotebook) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "No active Jupyter notebook found. Please open a .ipynb file first.",
			})
			return null
		}

		const ctx = await getContextForCommand(range, diagnostics)
		if (!ctx) {
			return null
		}

		const filePath = ctx.commandContext.filePath || ""
		let cellJson: string | null = null
		if (activeNotebook.notebook.cellCount > 0) {
			const cellIndex = activeNotebook.notebook.cellAt(activeNotebook.selection.start).index
			cellJson = await findMatchingNotebookCell(filePath, cellIndex)
		}

		return { ...ctx, cellJson }
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterGenerateCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Generate Notebook Cell",
					"Enter your prompt for generating notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
Insert a new Jupyter notebook cell above or below the current cell based on user prompt.
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await addToCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterExplainCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = ctx.cellJson
					? `\n\nCurrent Notebook Cell Context (JSON, sanitized of image data):\n\`\`\`json\n${ctx.cellJson}\n\`\`\``
					: undefined

				await explainWithCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterImproveCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Improve Notebook Cell",
					"Enter your prompt for improving the current notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await improveWithCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	// Register the openWalkthrough command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.Walkthrough, async () => {
			await vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#ClineWalkthrough`)
			telemetryService.captureButtonClick("command_openWalkthrough")
		}),
	)

	// Register the reconstructTaskHistory command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ReconstructTaskHistory, async () => {
			const { reconstructTaskHistory } = await import("./core/commands/reconstructTaskHistory")
			await reconstructTaskHistory()
			telemetryService.captureButtonClick("command_reconstructTaskHistory")
		}),
	)

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.GenerateCommit, async (scm) => {
			generateCommitMsg(webview.controller, scm)
		}),
		vscode.commands.registerCommand(commands.AbortCommit, () => {
			abortCommitGeneration()
		}),
	)

	context.subscriptions.push(
		context.secrets.onDidChange(async (event) => {
			if (event.key === "cline:clineAccountId") {
				// Check if the secret was removed (logout) or added/updated (login)
				const secretValue = await context.secrets.get(event.key)
				const activeWebview = WebviewProvider.getVisibleInstance()
				const controller = activeWebview?.controller

				const authService = AuthService.getInstance(controller)
				if (secretValue) {
					// Secret was added or updated - restore auth info (login from another window)
					authService?.restoreRefreshTokenAndRetrieveAuthInfo()
				} else {
					// Secret was removed - handle logout for all windows
					authService?.handleDeauth(LogoutReason.CROSS_WINDOW_SYNC)
				}
			}
		}),
	)

	Logger.log(`[Cline] extension activated in ${performance.now() - activationStartTime} ms`)

	return createClineAPI(webview.controller)
}

function scheduleP2AiAutostart(context: vscode.ExtensionContext, webview: VscodeWebviewProvider) {
	const task = process.env.P2AI_CLINE_AUTOSTART_TASK
	if (!task) {
		return
	}

	const delayMs = Number(process.env.P2AI_CLINE_AUTOSTART_DELAY_MS || "2500")
	p2aiVisualLog(context, "autostart_scheduled", "autostart scheduled", {
		delay_ms: Number.isFinite(delayMs) ? delayMs : 2500,
		task,
	})
	const timer = setTimeout(
		async () => {
			try {
				const controller = webview.controller
				const lmStudioBaseUrl = process.env.P2AI_CLINE_LMSTUDIO_BASE_URL || "http://127.0.0.1:1234"
				const lmStudioModelId = process.env.P2AI_CLINE_LMSTUDIO_MODEL_ID || "gemma-4-E4B-it-GGUF"
				const lmStudioMaxTokens = process.env.P2AI_CLINE_LMSTUDIO_CONTEXT_TOKENS || "16384"
				const useCompactPrompt = process.env.P2AI_CLINE_COMPACT_PROMPT === "1"
				const allowAutostartWrites = process.env.P2AI_CLINE_AUTOSTART_ALLOW_WRITES === "1"
				const allowAutostartSafeCommands = process.env.P2AI_CLINE_AUTOSTART_ALLOW_COMMANDS === "safe"
				const allowAutostartAllCommands = process.env.P2AI_CLINE_AUTOSTART_ALLOW_COMMANDS === "all"
				const currentAutoApproval = controller.stateManager.getGlobalSettingsKey("autoApprovalSettings")
				p2aiVisualLog(context, "autostart_configuring", "configuring LM Studio task", {
					lmStudioBaseUrl,
					lmStudioModelId,
					lmStudioMaxTokens,
					useCompactPrompt,
					allowAutostartWrites,
					allowAutostartCommands: process.env.P2AI_CLINE_AUTOSTART_ALLOW_COMMANDS || "none",
				})

				controller.stateManager.setApiConfiguration({
					...controller.stateManager.getApiConfiguration(),
					planModeApiProvider: "lmstudio",
					actModeApiProvider: "lmstudio",
					planModeLmStudioModelId: lmStudioModelId,
					actModeLmStudioModelId: lmStudioModelId,
					lmStudioBaseUrl,
					lmStudioMaxTokens,
				})
				controller.stateManager.setGlobalState("mode", "act")
				controller.stateManager.setGlobalState("welcomeViewCompleted", true)
				controller.stateManager.setGlobalState("isNewUser", false)
				controller.stateManager.setGlobalState("autoApprovalSettings", {
					...currentAutoApproval,
					version: (currentAutoApproval.version ?? 1) + 1,
					enableNotifications: false,
					actions: {
						...currentAutoApproval.actions,
						readFiles: true,
						readFilesExternally: false,
						editFiles: allowAutostartWrites,
						editFilesExternally: false,
						executeSafeCommands: allowAutostartSafeCommands || allowAutostartAllCommands,
						executeAllCommands: allowAutostartAllCommands,
						useBrowser: false,
						useMcp: false,
					},
				})
				if (useCompactPrompt) {
					controller.stateManager.setGlobalState("customPrompt", "compact")
				}

				await controller.postStateToWebview()
				await vscode.commands.executeCommand("workbench.view.extension.claude-dev-ActivityBar")
				await vscode.commands.executeCommand(`${VscodeWebviewProvider.SIDEBAR_ID}.focus`)
				await showWebview(false)
				await controller.postStateToWebview()
				p2aiVisualLog(
					context,
					"sidebar_focus_requested",
					"C2Ai sidebar focus requested",
					{
						sidebar_id: VscodeWebviewProvider.SIDEBAR_ID,
						visible_instance: !!WebviewProvider.getVisibleInstance(),
					},
					true,
				)
				const taskId = await controller.initTask(task, undefined, undefined, undefined, {
					mode: "act",
					planModeApiProvider: "lmstudio",
					actModeApiProvider: "lmstudio",
					planModeLmStudioModelId: lmStudioModelId,
					actModeLmStudioModelId: lmStudioModelId,
					lmStudioBaseUrl,
					lmStudioMaxTokens,
					...(useCompactPrompt ? { customPrompt: "compact" as const } : {}),
				})
				p2aiVisualLog(
					context,
					"autostart_task_started",
					"Gemma4 prompt submitted",
					{
						task_id: taskId,
						lmStudioBaseUrl,
						lmStudioModelId,
						lmStudioMaxTokens,
						task,
					},
					true,
				)
				Logger.log(`[P2AI Cline] Autostarted VS Code smoke task ${taskId}`)
			} catch (error) {
				p2aiVisualLog(
					context,
					"autostart_failed",
					"autostart failed",
					{
						error: error instanceof Error ? error.message : String(error),
					},
					true,
				)
				Logger.error("[P2AI Cline] Failed to autostart VS Code smoke task:", error)
			}
		},
		Number.isFinite(delayMs) ? delayMs : 2500,
	)
	timer.unref?.()
}

async function showJupyterPromptInput(title: string, placeholder: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick()
		quickPick.title = title
		quickPick.placeholder = placeholder
		quickPick.ignoreFocusOut = true

		// Allow free text input
		quickPick.canSelectMany = false

		let userInput = ""

		quickPick.onDidChangeValue((value) => {
			userInput = value
			// Update items to show the current input
			if (value) {
				quickPick.items = [
					{
						label: "$(check) Use this prompt",
						detail: value,
						alwaysShow: true,
					},
				]
			} else {
				quickPick.items = []
			}
		})

		quickPick.onDidAccept(() => {
			if (userInput) {
				resolve(userInput)
				quickPick.hide()
			}
		})

		quickPick.onDidHide(() => {
			if (!userInput) {
				resolve(undefined)
			}
			quickPick.dispose()
		})

		quickPick.show()
	})
}

function setupHostProvider(context: ExtensionContext) {
	const outputChannel = registerClineOutputChannel(context)
	outputChannel.appendLine("[Cline] Setting up VS Code host...")

	const createWebview = () => new VscodeWebviewProvider(context)
	const createDiffView = () => new VscodeDiffViewProvider()
	const createCommentReview = () => getVscodeCommentReviewController()
	const createTerminalManager = () => new VscodeTerminalManager()

	const getCallbackUrl = async (path: string) => {
		const scheme = vscode.env.uriScheme || "vscode"
		const callbackUri = vscode.Uri.parse(`${scheme}://${context.extension.id}${path}`)

		if (vscode.env.uiKind === vscode.UIKind.Web) {
			// In VS Code Web (Codespaces, code serve-web), vscode:// URIs redirect to the
			// desktop app instead of staying in the browser. Use asExternalUri to convert
			// to a web-reachable HTTPS URL that routes back to the extension's URI handler.
			const externalUri = await vscode.env.asExternalUri(callbackUri)
			return externalUri.toString(true)
		}

		// In regular desktop VS Code, use the vscode:// URI protocol handler directly.
		return callbackUri.toString(true)
	}
	HostProvider.initialize(
		createWebview,
		createDiffView,
		createCommentReview,
		createTerminalManager,
		vscodeHostBridgeClient,
		() => {}, // No-op logger, logging is handled via HostProvider.env.debugLog
		getCallbackUrl,
		getBinaryLocation,
		context.extensionUri.fsPath,
		context.globalStorageUri.fsPath,
	)
}

function getUriPath(url: string): string | undefined {
	try {
		return new URL(url).pathname
	} catch {
		return undefined
	}
}

async function openClineSidebarForTaskUri(): Promise<void> {
	const sidebarWaitTimeoutMs = 3000
	const sidebarWaitIntervalMs = 50

	await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)

	const startedAt = Date.now()
	while (Date.now() - startedAt < sidebarWaitTimeoutMs) {
		if (WebviewProvider.getVisibleInstance()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, sidebarWaitIntervalMs))
	}

	Logger.warn("Task URI handling timed out waiting for Cline sidebar visibility")
}

async function getBinaryLocation(name: string): Promise<string> {
	// The only binary currently supported is the rg binary from the VSCode installation.
	if (!name.startsWith("rg")) {
		throw new Error(`Binary '${name}' is not supported`)
	}

	const checkPath = async (pkgFolder: string) => {
		const fullPathResult = workspaceResolver.resolveWorkspacePath(
			vscode.env.appRoot,
			path.join(pkgFolder, name),
			"Services.ripgrep.getBinPath",
		)
		const fullPath = typeof fullPathResult === "string" ? fullPathResult : fullPathResult.absolutePath
		return (await fileExistsAtPath(fullPath)) ? fullPath : undefined
	}

	const binPath =
		(await checkPath("node_modules/@vscode/ripgrep/bin/")) ||
		(await checkPath("node_modules/vscode-ripgrep/bin")) ||
		(await checkPath("node_modules.asar.unpacked/vscode-ripgrep/bin/")) ||
		(await checkPath("node_modules.asar.unpacked/@vscode/ripgrep/bin/"))
	if (!binPath) {
		throw new Error("Could not find ripgrep binary")
	}
	return binPath
}

// This method is called when your extension is deactivated
export async function deactivate() {
	// Dispose Non-VSCode-specific services
	tearDown()

	// VSCode-specific services
	disposeVscodeCommentReviewController()
}

// TODO: Find a solution for automatically removing DEV related content from production builds.
//  This type of code is fine in production to keep. We just will want to remove it from production builds
//  to bring down built asset sizes.
//
// This is a workaround to reload the extension when the source code changes
// since vscode doesn't support hot reload for extensions
const IS_DEV = process.env.IS_DEV === "true"
const DEV_WORKSPACE_FOLDER = process.env.DEV_WORKSPACE_FOLDER

// Set up development mode file watcher
if (IS_DEV) {
	assert(DEV_WORKSPACE_FOLDER, "DEV_WORKSPACE_FOLDER must be set in development")
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(DEV_WORKSPACE_FOLDER, "src/**/*"))

	watcher.onDidChange(({ scheme, path }) => {
		Logger.info(`${scheme} ${path} changed. Reloading VSCode...`)

		vscode.commands.executeCommand("workbench.action.reloadWindow")
	})
}

// VSCode-specific storage migrations
async function performStorageMigrations(context: ExtensionContext): Promise<void> {
	try {
		cleanupOldApiKey()
		// Migrate is not done if the new storage does not have the lastShownAnnouncementId flag
		const hasMigrated = StateManager.get().getGlobalStateKey("lastShownAnnouncementId")
		if (hasMigrated !== undefined) {
			return
		}

		Logger.info("[VS Code Storage Migrations] Starting")

		// Migrate custom instructions to global Cline rules (one-time cleanup)
		await migrateCustomInstructionsToGlobalRules(context)

		// Migrate welcomeViewCompleted setting based on existing API keys (one-time cleanup)
		await migrateWelcomeViewCompleted(context)

		// Migrate workspace storage values back to global storage (reverting previous migration)
		await migrateWorkspaceToGlobalStorage(context)

		// Ensure taskHistory.json exists and migrate legacy state (runs once)
		await migrateTaskHistoryToFile(context)

		// Clean up MCP marketplace catalog from global state (moved to disk cache)
		await cleanupMcpMarketplaceCatalogFromGlobalState(context)

		// lastShownAnnouncementId will be set when announcement is shown
		// after activation so we don't need to set it here.

		Logger.info("[VS Code Storage Migrations] Completed")
	} catch (error) {
		Logger.warn("[VS Code Storage Migrations] Failed" + (error instanceof Error ? `: ${error.message}` : ""))
	}
}
