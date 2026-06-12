import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import type {
	ClineAssistantToolUseBlock,
	ClineContent,
	ClineStorageMessage,
	ClineUserToolResultContentBlock,
} from "@/shared/messages/content"

export interface Gemma4KesslerPromptOptions {
	systemPrompt: string
	messages: ClineStorageMessage[]
	tools?: OpenAITool[]
	enableThinking?: boolean
}

export interface Gemma4KesslerRepairPromptOptions extends Gemma4KesslerPromptOptions {
	invalidResponse: string
}

const protocolPrelude = `You are Cline running in ACT MODE through the C2Ai Gemma4/Kessler transport.
You may think in a Gemma4 thought channel first:
<|channel>thought
private reasoning
<channel|>
After thinking, output exactly one official Gemma4 tool call. No visible prose before or after it.
Use only declared tools. The declaration name is the exact tool name to call.
Valid syntax:
<|tool_call>call:tool_name{"arg":"value"}<tool_call|>
Valid final answer:
<|tool_call>call:attempt_completion{"result":"final answer"}<tool_call|>
For the task "Antwoord exact met OK.", the valid final answer is:
<|tool_call>call:attempt_completion{"result":"OK"}<tool_call|>
Never output XML tool tags, bare tool names, "params", tool descriptions, or schema text.
Never copy a declaration or description into an argument.
Use a concrete workspace tool when evidence is needed. Use attempt_completion only when the user request is satisfied.
Do not invent file contents, paths, command output, or search results.`

export function buildGemma4KesslerPrompt(options: Gemma4KesslerPromptOptions): string {
	const parts: string[] = []
	const thinkToken = options.enableThinking === false ? "" : "<|think|>"
	const toolDeclarations = toolDeclarationsForPrompt(options.systemPrompt, options.tools)
	const toolUseIdToName = new Map<string, string>()
	let pendingModelToolCalls: string[] = []

	parts.push(`<|turn>system\n${thinkToken}${protocolPrelude}\n\nTOOLS:\n${toolDeclarations}<turn|>`)

	for (const message of options.messages) {
		if (message.role === "assistant") {
			flushPendingModelToolCalls(parts, pendingModelToolCalls)
			const assistantParts = assistantMessageToGemma4(message, toolUseIdToName)
			if (assistantParts.toolCalls.length > 0) {
				pendingModelToolCalls = assistantParts.toolCalls
			}
			if (assistantParts.text) {
				parts.push(`<|turn>model\n${assistantParts.text}<turn|>`)
			}
			continue
		}

		const userParts = userMessageToGemma4(message, toolUseIdToName)
		if (userParts.toolResponses.length > 0 && pendingModelToolCalls.length > 0) {
			parts.push(
				`<|turn>model\n${pendingModelToolCalls.join("")}<|tool_response>${userParts.toolResponses.join("")}<turn|>`,
			)
			pendingModelToolCalls = []
		} else if (userParts.toolResponses.length > 0) {
			parts.push(`<|turn>user\n${userParts.toolResponses.join("\n")}<turn|>`)
		}
		if (userParts.text) {
			parts.push(`<|turn>user\n${userParts.text}<turn|>`)
		}
	}

	flushPendingModelToolCalls(parts, pendingModelToolCalls)
	parts.push("<|turn>model\n")
	return parts.join("\n")
}

export function buildGemma4KesslerRepairPrompt(options: Gemma4KesslerRepairPromptOptions): string {
	const toolDeclarations = toolDeclarationsForPrompt(options.systemPrompt, options.tools)
	const latestUser = latestUserTextForRepair(options.messages)
	const invalid = sanitizeGemma4Text(options.invalidResponse).slice(0, 1200)
	return [
		`<|turn>system`,
		`Repair the previous invalid Gemma4/Kessler response into exactly one valid tool call.`,
		`Output exactly one official Gemma4 <|tool_call> as the first token. No prose.`,
		`Use only declared tools. The declaration name is the exact tool name to call.`,
		`Valid syntax: <|tool_call>call:tool_name{"arg":"value"}<tool_call|>`,
		`If the latest user only asks for an exact direct answer, use attempt_completion with exactly that answer.`,
		`For "Antwoord exact met OK.", output exactly: <|tool_call>call:attempt_completion{"result":"OK"}<tool_call|>`,
		`Never copy tool descriptions, schema text, "params", or previous invalid text into arguments.`,
		``,
		`TOOLS:`,
		toolDeclarations,
		`<turn|>`,
		`<|turn>user`,
		`LATEST_USER:`,
		sanitizeGemma4Text(latestUser),
		``,
		`PREVIOUS_INVALID_RESPONSE:`,
		invalid,
		`<turn|>`,
		`<|turn>model`,
	].join("\n")
}

function latestUserTextForRepair(messages: ClineStorageMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message.role !== "user") {
			continue
		}
		const content = message.content
		if (typeof content === "string") {
			return content
		}
		return content
			.map((block) => {
				if (block.type === "text") {
					return block.text || ""
				}
				if (block.type === "tool_result") {
					return contentBlockToText((block as ClineUserToolResultContentBlock).content)
				}
				return ""
			})
			.filter(Boolean)
			.join("\n")
	}
	return ""
}

function flushPendingModelToolCalls(parts: string[], pendingModelToolCalls: string[]): void {
	if (pendingModelToolCalls.length > 0) {
		parts.push(`<|turn>model\n${pendingModelToolCalls.join("")}<turn|>`)
		pendingModelToolCalls.length = 0
	}
}

function formatToolDeclaration(tool: OpenAITool): string {
	if (tool.type !== "function") {
		return ""
	}
	const fn = tool.function
	if (fn.name === "plan_mode_respond") {
		return ""
	}
	const schema = conciseToolSchema(fn.name, fn.parameters)
	return `<|tool>declaration:${fn.name}${JSON.stringify(schema)}<tool|>`
}

function conciseToolSchema(name: string, parameters: unknown): {
	description: string
	parameters: unknown
} {
	const known = conciseClineToolSchemas[name]
	if (known) {
		return known
	}
	return {
		description: `Use ${name} when required by the task.`,
		parameters: parameters ?? { type: "object", properties: {} },
	}
}

function toolDeclarationsForPrompt(systemPrompt: string, tools?: OpenAITool[]): string {
	const openAiDeclarations = (tools || [])
		.map(formatToolDeclaration)
		.filter((declaration) => declaration.length > 0)
	if (openAiDeclarations.length > 0) {
		return openAiDeclarations.join("")
	}
	return fallbackClineToolDeclarations(systemPrompt).join("")
}

function fallbackClineToolDeclarations(systemPrompt: string): string[] {
	return fallbackClineTools
		.filter((tool) => systemPrompt.includes(`## ${tool.name}`) || systemPrompt.includes(`<${tool.name}>`))
		.map((tool) => `<|tool>declaration:${tool.name}${JSON.stringify(tool.schema)}<tool|>`)
}

const fallbackClineTools: Array<{
	name: string
	schema: {
		description: string
		parameters: {
			type: "object"
			properties: Record<string, { type: string; description: string }>
			required: string[]
		}
	}
}> = [
	{
		name: "read_file",
		schema: {
			description: "Read the contents of an existing workspace file.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative path to the file." },
					task_progress: { type: "string", description: "Optional markdown checklist of task progress." },
				},
				required: ["path"],
			},
		},
	},
	{
		name: "list_files",
		schema: {
			description: "List files and directories at a workspace path.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative directory path." },
					recursive: { type: "boolean", description: "Whether to list recursively." },
					task_progress: { type: "string", description: "Optional markdown checklist of task progress." },
				},
				required: ["path"],
			},
		},
	},
	{
		name: "search_files",
		schema: {
			description: "Search files in a workspace directory using a regex pattern.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative directory path." },
					regex: { type: "string", description: "Regex pattern to search for." },
					file_pattern: { type: "string", description: "Optional glob pattern to restrict files." },
					task_progress: { type: "string", description: "Optional markdown checklist of task progress." },
				},
				required: ["path", "regex"],
			},
		},
	},
	{
		name: "list_code_definition_names",
		schema: {
			description: "List source-code definitions in a workspace directory.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative directory path." },
					task_progress: { type: "string", description: "Optional markdown checklist of task progress." },
				},
				required: ["path"],
			},
		},
	},
	{
		name: "execute_command",
		schema: {
			description: "Execute a shell command in the current workspace.",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Command to execute." },
					requires_approval: { type: "boolean", description: "Whether explicit approval is required." },
					task_progress: { type: "string", description: "Optional markdown checklist of task progress." },
				},
				required: ["command", "requires_approval"],
			},
		},
	},
	{
		name: "attempt_completion",
		schema: {
			description: "Present the final answer after the task is complete.",
			parameters: {
				type: "object",
				properties: {
					result: { type: "string", description: "Final answer for the user." },
					command: { type: "string", description: "Optional command to demonstrate the result." },
				},
				required: ["result"],
			},
		},
	},
	{
		name: "ask_followup_question",
		schema: {
			description: "Ask the user a clarifying question only when required.",
			parameters: {
				type: "object",
				properties: {
					question: { type: "string", description: "Question for the user." },
					options: { type: "string", description: "Optional concise options." },
				},
				required: ["question"],
			},
		},
	},
	{
		name: "write_to_file",
		schema: {
			description: "Write complete content to a workspace file.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative file path." },
					content: { type: "string", description: "Complete file content." },
					task_progress: { type: "string", description: "Optional markdown checklist of task progress." },
				},
				required: ["path", "content"],
			},
		},
	},
	{
		name: "replace_in_file",
		schema: {
			description: "Replace exact text in an existing workspace file.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative file path." },
					diff: { type: "string", description: "Search/replace diff block." },
					task_progress: { type: "string", description: "Optional markdown checklist of task progress." },
				},
				required: ["path", "diff"],
			},
		},
	},
]

const conciseClineToolSchemas: Record<string, { description: string; parameters: unknown }> = Object.fromEntries(
	fallbackClineTools.map((tool) => [tool.name, tool.schema]),
)

function assistantMessageToGemma4(
	message: ClineStorageMessage,
	toolUseIdToName: Map<string, string>,
): { text: string; toolCalls: string[] } {
	const content = message.content
	if (typeof content === "string") {
		return { text: sanitizeGemma4Text(content), toolCalls: [] }
	}

	const textParts: string[] = []
	const toolCalls: string[] = []
	for (const block of content) {
		if (block.type === "text") {
			textParts.push(sanitizeGemma4Text(block.text || ""))
		} else if (block.type === "tool_use") {
			const toolUse = block as ClineAssistantToolUseBlock
			toolUseIdToName.set(toolUse.id, toolUse.name)
			toolCalls.push(formatToolCall(toolUse.name, objectFromUnknown(toolUse.input)))
		} else if (block.type === "thinking") {
			textParts.push(`<|channel>thought\n${sanitizeGemma4Text(block.thinking || "")}<channel|>`)
		}
	}

	return {
		text: textParts.filter(Boolean).join("\n"),
		toolCalls,
	}
}

function userMessageToGemma4(
	message: ClineStorageMessage,
	toolUseIdToName: Map<string, string>,
): { text: string; toolResponses: string[] } {
	const content = message.content
	if (typeof content === "string") {
		return { text: sanitizeGemma4Text(content), toolResponses: [] }
	}

	const textParts: string[] = []
	const toolResponses: string[] = []
	for (const block of content) {
		if (block.type === "text") {
			textParts.push(sanitizeGemma4Text(block.text || ""))
		} else if (block.type === "tool_result") {
			const result = block as ClineUserToolResultContentBlock
			const toolName = toolUseIdToName.get(result.tool_use_id) || result.tool_use_id || "unknown_tool"
			toolResponses.push(formatToolResponse(toolName, contentBlockToText(result.content)))
		} else if (block.type === "image") {
			textParts.push("[image omitted]")
		} else if (block.type === "document") {
			textParts.push("[document omitted]")
		}
	}

	return {
		text: textParts.filter(Boolean).join("\n"),
		toolResponses,
	}
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	return `<|tool_call>call:${name}${JSON.stringify(args)}<tool_call|>`
}

function formatToolResponse(name: string, content: string): string {
	const raw = sanitizeGemma4Text(content)
	const payload = {
		ok: true,
		status: "ok",
		mime: "text/plain",
		content_b64: Buffer.from(raw, "utf8").toString("base64"),
	}
	return `response:${name}${JSON.stringify(payload)}<tool_response|>`
}

function gemma4String(value: unknown): string {
	const raw = typeof value === "string" ? value : JSON.stringify(value)
	return `<|"|>${sanitizeGemma4Text(String(raw ?? ""))}<|"|>`
}

function sanitizeGemma4Text(value: string): string {
	return value
		.replaceAll("<|tool_call>", "")
		.replaceAll("<tool_call|>", "")
		.replaceAll("<|tool_response>", "")
		.replaceAll("<tool_response|>", "")
		.replaceAll("<|tool>", "")
		.replaceAll("<tool|>", "")
		.replaceAll("<|turn>", "")
		.replaceAll("<turn|>", "")
}

function objectFromUnknown(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>
	}
	return {}
}

function contentBlockToText(content: ClineUserToolResultContentBlock["content"]): string {
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		return String(content ?? "")
	}
	return content.map(contentPartToText).filter(Boolean).join("\n")
}

function contentPartToText(part: ClineContent): string {
	if (part.type === "text") {
		return part.text || ""
	}
	if (part.type === "image") {
		return "[image omitted]"
	}
	if (part.type === "document") {
		return "[document omitted]"
	}
	return ""
}
