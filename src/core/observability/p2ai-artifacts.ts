import type { ClineMessageChange } from "@core/task/message-state"
import type { ExtensionState } from "@shared/ExtensionMessage"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import type { ClineStorageMessage } from "@/shared/messages"

const artifactRoot = process.env.P2AI_CLINE_ARTIFACT_ROOT || process.env.CLINE_ARTIFACT_ROOT
const maxStringChars = Number(process.env.P2AI_CLINE_ARTIFACT_MAX_STRING_CHARS || "12000")

let initialized = false
let sequence = 0

function enabled(): boolean {
	return !!artifactRoot
}

function nowMs(): number {
	return Date.now()
}

function ensureInitialized(): void {
	if (!enabled() || initialized) {
		return
	}
	try {
		fs.mkdirSync(artifactRoot!, { recursive: true })
		fs.writeFileSync(
			path.join(artifactRoot!, "cline_artifact_manifest.json"),
			`${JSON.stringify(
				{
					schema: "p2ai.cline.artifact_manifest",
					version: 1,
					created_at_ms: nowMs(),
					created_at: new Date().toISOString(),
					pid: process.pid,
					cwd: process.cwd(),
					source: "cline_typescript",
					env: {
						CLINE_ENVIRONMENT: process.env.CLINE_ENVIRONMENT,
						IS_DEV: process.env.IS_DEV,
						P2AI_CLINE_ARTIFACT_MAX_STRING_CHARS: maxStringChars,
					},
					files: [
						"c2ai_visual_events.jsonl",
						"cline_message_events.jsonl",
						"api_conversation_events.jsonl",
						"controller_state_events.jsonl",
						"prompt_snapshot_events.jsonl",
						"latest_c2ai_visual_state.json",
						"latest_cline_messages.json",
						"latest_api_conversation.json",
						"latest_controller_state_radar.json",
						"latest_prompt_snapshot.json",
						"latest_system_prompt.md",
						"latest_tool_schema.json",
					],
				},
				null,
				2,
			)}\n`,
		)
		initialized = true
	} catch {
		initialized = true
	}
}

function appendJsonl(fileName: string, payload: Record<string, unknown>): void {
	if (!enabled()) {
		return
	}
	ensureInitialized()
	try {
		sequence += 1
		fs.appendFileSync(
			path.join(artifactRoot!, fileName),
			`${JSON.stringify({
				schema: "p2ai.cline.event",
				version: 1,
				seq: sequence,
				created_at_ms: nowMs(),
				created_at: new Date().toISOString(),
				pid: process.pid,
				...payload,
			})}\n`,
		)
	} catch {
		// Artifact logging must never affect Cline runtime behavior.
	}
}

function writeJson(fileName: string, payload: Record<string, unknown>): void {
	if (!enabled()) {
		return
	}
	ensureInitialized()
	try {
		fs.writeFileSync(path.join(artifactRoot!, fileName), `${JSON.stringify(payload, null, 2)}\n`)
	} catch {
		// Artifact logging must never affect Cline runtime behavior.
	}
}

function compactString(value: string): string {
	if (value.length <= maxStringChars) {
		return value
	}
	return `${value.slice(0, maxStringChars)}...[truncated ${value.length - maxStringChars} chars]`
}

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex")
}

function safeStem(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96)
}

function sanitize(value: unknown, depth = 0): unknown {
	if (depth > 8) {
		return "[max_depth]"
	}
	if (typeof value === "string") {
		return compactString(value)
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitize(item, depth + 1))
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (/^(apiKey|secret|password|refreshToken|accessToken|authToken|bearerToken|idToken)$/i.test(key)) {
				out[key] = "[redacted]"
			} else {
				out[key] = sanitize(child, depth + 1)
			}
		}
		return out
	}
	return value
}

export function recordP2AiDiagnosticEvent(params: { event: string; message: string; payload?: Record<string, unknown> }): void {
	if (!enabled()) {
		return
	}
	const state = {
		schema: "p2ai.cline.visual_diagnostic",
		version: 1,
		created_at_ms: nowMs(),
		created_at: new Date().toISOString(),
		event: params.event,
		message: params.message,
		payload: sanitize(params.payload || {}),
	}
	appendJsonl("c2ai_visual_events.jsonl", state)
	writeJson("latest_c2ai_visual_state.json", state)
}

function summarizeTool(tool: unknown): Record<string, unknown> | undefined {
	if (!tool || typeof tool !== "object") {
		return undefined
	}
	const raw = tool as Record<string, unknown>
	const fn = raw.function && typeof raw.function === "object" ? (raw.function as Record<string, unknown>) : undefined
	return sanitize({
		type: raw.type,
		name: fn?.name ?? raw.name,
		description: fn?.description ?? raw.description,
	}) as Record<string, unknown>
}

function summarizeMessage(message: unknown): Record<string, unknown> | undefined {
	if (!message || typeof message !== "object") {
		return undefined
	}
	const msg = message as Record<string, unknown>
	return sanitize({
		ts: msg.ts,
		type: msg.type,
		ask: msg.ask,
		say: msg.say,
		text: typeof msg.text === "string" ? msg.text : undefined,
		reasoning: typeof msg.reasoning === "string" ? msg.reasoning : undefined,
		partial: msg.partial,
		conversationHistoryIndex: msg.conversationHistoryIndex,
		conversationHistoryDeletedRange: msg.conversationHistoryDeletedRange,
		modelInfo: msg.modelInfo,
	}) as Record<string, unknown>
}

function summarizeApiMessage(message: unknown): Record<string, unknown> | undefined {
	if (!message || typeof message !== "object") {
		return undefined
	}
	const msg = message as Record<string, unknown>
	return sanitize({
		role: msg.role,
		content: msg.content,
		modelInfo: msg.modelInfo,
		ts: msg.ts,
	}) as Record<string, unknown>
}

export function recordClineMessageChange(params: { taskId: string; ulid: string; change: ClineMessageChange }): void {
	if (!enabled()) {
		return
	}
	const latest = params.change.messages[params.change.messages.length - 1]
	appendJsonl("cline_message_events.jsonl", {
		event: "cline_messages_changed",
		task_id: params.taskId,
		ulid: params.ulid,
		change_type: params.change.type,
		message_count: params.change.messages.length,
		index: params.change.index,
		message: summarizeMessage(params.change.message),
		previous_message: summarizeMessage(params.change.previousMessage),
		latest_message: summarizeMessage(latest),
	})
	writeJson("latest_cline_messages.json", {
		schema: "p2ai.cline.latest_cline_messages",
		version: 1,
		created_at_ms: nowMs(),
		task_id: params.taskId,
		ulid: params.ulid,
		message_count: params.change.messages.length,
		latest_message: summarizeMessage(latest),
		messages: sanitize(params.change.messages),
	})
}

export function recordApiConversationChange(params: {
	taskId: string
	ulid: string
	changeType: "add" | "overwrite" | "set"
	history: ClineStorageMessage[]
	message?: ClineStorageMessage
}): void {
	if (!enabled()) {
		return
	}
	appendJsonl("api_conversation_events.jsonl", {
		event: "api_conversation_changed",
		task_id: params.taskId,
		ulid: params.ulid,
		change_type: params.changeType,
		message_count: params.history.length,
		message: summarizeApiMessage(params.message),
		latest_message: summarizeApiMessage(params.history[params.history.length - 1]),
	})
	writeJson("latest_api_conversation.json", {
		schema: "p2ai.cline.latest_api_conversation",
		version: 1,
		created_at_ms: nowMs(),
		task_id: params.taskId,
		ulid: params.ulid,
		message_count: params.history.length,
		messages: sanitize(params.history),
	})
}

export function recordControllerState(state: ExtensionState): void {
	if (!enabled()) {
		return
	}
	const clineMessages = state.clineMessages || []
	const latest = clineMessages[clineMessages.length - 1]
	const currentTask = state.currentTaskItem
	const radar = {
		schema: "p2ai.cline.controller_state_radar",
		version: 1,
		created_at_ms: nowMs(),
		version_string: state.version,
		environment: state.environment,
		mode: state.mode,
		platform: state.platform,
		current_task_id: currentTask?.id,
		current_task_text: currentTask?.task,
		cline_message_count: clineMessages.length,
		latest_message: summarizeMessage(latest),
	}
	appendJsonl("controller_state_events.jsonl", {
		event: "controller_state_posted",
		...radar,
	})
	writeJson("latest_controller_state_radar.json", radar)
}

export function recordPromptSnapshot(params: {
	taskId: string
	ulid: string
	apiRequestCount: number
	systemPrompt: string
	tools?: unknown[]
	providerInfo: unknown
}): void {
	if (!enabled()) {
		return
	}
	const promptHash = sha256(params.systemPrompt)
	const toolSummaries = (params.tools || []).map(summarizeTool).filter(Boolean)
	const baseName = safeStem(`task-${params.taskId}-req-${params.apiRequestCount}`)
	const promptFileName = `${baseName}.system_prompt.md`
	const toolFileName = `${baseName}.tool_schema.json`
	const snapshot = {
		schema: "p2ai.cline.prompt_snapshot",
		version: 1,
		created_at_ms: nowMs(),
		task_id: params.taskId,
		ulid: params.ulid,
		api_request_count: params.apiRequestCount,
		system_prompt_chars: params.systemPrompt.length,
		system_prompt_sha256: promptHash,
		system_prompt_file: promptFileName,
		tool_schema_file: toolFileName,
		tool_count: params.tools?.length || 0,
		tools: toolSummaries,
		provider_info: sanitize(params.providerInfo),
	}
	appendJsonl("prompt_snapshot_events.jsonl", {
		event: "api_request_prompt_snapshot",
		...snapshot,
	})
	writeJson("latest_prompt_snapshot.json", snapshot)
	try {
		if (enabled()) {
			fs.writeFileSync(path.join(artifactRoot!, promptFileName), params.systemPrompt)
			fs.writeFileSync(path.join(artifactRoot!, "latest_system_prompt.md"), params.systemPrompt)
			fs.writeFileSync(path.join(artifactRoot!, toolFileName), `${JSON.stringify(sanitize(params.tools || []), null, 2)}\n`)
			fs.writeFileSync(
				path.join(artifactRoot!, "latest_tool_schema.json"),
				`${JSON.stringify(sanitize(params.tools || []), null, 2)}\n`,
			)
		}
	} catch {
		// Artifact logging must never affect Cline runtime behavior.
	}
}
