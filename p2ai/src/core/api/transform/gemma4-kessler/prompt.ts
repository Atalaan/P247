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

type DeterministicOutputShape = "search_summary_two_hits" | "exact_stdout"

type DeterministicCompletionContract =
	| { kind: "single_tool"; toolName: string; outputShape: DeterministicOutputShape }
	| { kind: "disabled" }

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
	const repairContext = repairContextForMessages(options.messages)
	const invalid = sanitizeGemma4Text(options.invalidResponse).slice(0, 1200)
	return [
		`<|turn>system`,
		`Repair the previous invalid Gemma4/Kessler response into exactly one valid tool call.`,
		`Output exactly one official Gemma4 <|tool_call> as the first token. No prose.`,
		`Use only declared tools. The declaration name is the exact tool name to call.`,
		`Valid syntax: <|tool_call>call:tool_name{"arg":"value"}<tool_call|>`,
		`Obey ORIGINAL_USER_INSTRUCTION, including forbidden tools and required final tool.`,
		`If LATEST_TOOL_RESULT is present and ORIGINAL_USER_INSTRUCTION asks to finish with attempt_completion, output attempt_completion now using only LATEST_TOOL_RESULT.`,
		`Never call a tool that ORIGINAL_USER_INSTRUCTION forbids.`,
		`If the latest user only asks for an exact direct answer, use attempt_completion with exactly that answer.`,
		`For "Antwoord exact met OK.", output exactly: <|tool_call>call:attempt_completion{"result":"OK"}<tool_call|>`,
		`Never copy tool descriptions, schema text, "params", or previous invalid text into arguments.`,
		``,
		`TOOLS:`,
		toolDeclarations,
		`<turn|>`,
		`<|turn>user`,
		`ORIGINAL_USER_INSTRUCTION:`,
		sanitizeGemma4Text(repairContext.originalInstruction),
		``,
		`LATEST_TOOL_RESULT:`,
		sanitizeGemma4Text(repairContext.latestToolResult).slice(0, 3000),
		``,
		`PREVIOUS_INVALID_RESPONSE:`,
		invalid,
		`<turn|>`,
		`<|turn>model`,
	].join("\n")
}

export function buildGemma4KesslerDeterministicAttemptCompletion(messages: ClineStorageMessage[]):
	| {
			result: string
			originalInstruction: string
			latestToolResultPreview: string
	  }
	| undefined {
	const contract = inferDeterministicCompletionContract(messages)
	if (contract.kind === "disabled") {
		return undefined
	}

	const repairContext = repairContextForMessages(messages)
	if (!repairContext.latestToolResult.trim()) {
		return undefined
	}
	if (!expectsAttemptCompletion(repairContext.originalInstruction)) {
		return undefined
	}
	if (toolResultLooksFailed(repairContext.latestToolResult)) {
		return undefined
	}

	const lastToolName = lastAssistantToolUseName(messages)
	if (lastToolName !== contract.toolName) {
		return undefined
	}

	const result = deterministicResultForShape(repairContext.latestToolResult, contract.outputShape)
	if (!result) {
		return undefined
	}

	return {
		result,
		originalInstruction: repairContext.originalInstruction,
		latestToolResultPreview: repairContext.latestToolResult.slice(0, 1200),
	}
}

function repairContextForMessages(messages: ClineStorageMessage[]): {
	originalInstruction: string
	latestToolResult: string
} {
	let originalInstruction = ""
	let latestUser = ""
	let latestToolResult = ""

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message.role !== "user") {
			continue
		}
		const content = message.content
		if (typeof content === "string") {
			if (!latestUser) {
				latestUser = content
			}
			if (!originalInstruction && content.trim()) {
				originalInstruction = content
			}
			continue
		}
		const textParts: string[] = []
		const toolResultParts: string[] = []
		for (const block of content) {
			if (block.type === "text") {
				textParts.push(block.text || "")
			} else if (block.type === "tool_result") {
				toolResultParts.push(contentBlockToText((block as ClineUserToolResultContentBlock).content))
			}
		}
		const userText = [...textParts, ...toolResultParts].filter(Boolean).join("\n")
		if (!latestUser && userText) {
			latestUser = userText
		}
		if (!latestToolResult && toolResultParts.length > 0) {
			latestToolResult = toolResultParts.filter(Boolean).join("\n")
		}
		const instructionText = textParts.filter(Boolean).join("\n")
		if (!originalInstruction && instructionText.trim()) {
			originalInstruction = instructionText
		}
	}

	return {
		originalInstruction: originalInstruction || latestUser,
		latestToolResult,
	}
}

function expectsAttemptCompletion(instruction: string): boolean {
	return /attempt_completion|sluit af|rond af|afronden|final answer/i.test(instruction)
}

function inferDeterministicCompletionContract(messages: ClineStorageMessage[]): DeterministicCompletionContract {
	const instruction = repairContextForMessages(messages).originalInstruction
	if (!expectsAttemptCompletion(instruction)) {
		return { kind: "disabled" }
	}

	if (/Gebruik uitsluitend search_files\b/i.test(instruction) && /maximaal\s+2|maximum\s+2|max\s+2/i.test(instruction)) {
		return { kind: "single_tool", toolName: "search_files", outputShape: "search_summary_two_hits" }
	}

	if (
		/Gebruik uitsluitend execute_command\b/i.test(instruction) &&
		/(exacte uitvoer|exact stdout|antwoord exact)/i.test(instruction)
	) {
		return { kind: "single_tool", toolName: "execute_command", outputShape: "exact_stdout" }
	}

	return { kind: "disabled" }
}

function toolResultLooksFailed(toolResult: string): boolean {
	return /The tool execution failed|<error>|Error executing|denied this operation|was denied|permission denied/i.test(toolResult)
}

function lastAssistantToolUseName(messages: ClineStorageMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const content = messages[i]?.content
		if (!Array.isArray(content)) {
			continue
		}
		for (let j = content.length - 1; j >= 0; j -= 1) {
			const block = content[j]
			if (block.type === "tool_use" && "name" in block && typeof block.name === "string") {
				return block.name
			}
		}
	}
	return undefined
}

function deterministicResultForShape(toolResult: string, shape: DeterministicOutputShape): string | undefined {
	if (shape === "search_summary_two_hits") {
		return summarizeSearchFilesResult(toolResult)
	}
	if (shape === "exact_stdout") {
		return extractCommandStdout(toolResult)
	}
	return undefined
}

function extractCommandStdout(toolResult: string): string | undefined {
	const text = toolResult.replace(/\r/g, "").trim()
	if (!text) {
		return undefined
	}

	const resultMatch = text.match(/\]\s*Result:\s*([\s\S]*)$/i)
	const candidate = (resultMatch?.[1] ?? text)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("[execute_command for "))
		.join("\n")
		.trim()

	return candidate || undefined
}

function summarizeSearchFilesResult(toolResult: string): string | undefined {
	const match = toolResult.match(/\[search_files for '([^']+)'\] Result:\s*Found (\d+) results\./i)
	if (!match) {
		return undefined
	}

	const query = match[1]
	const count = Number(match[2])
	if (count === 0) {
		return `De zoekopdracht naar '${query}' leverde 0 resultaten op.`
	}

	const paths = unique(
		toolResult
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => /^[A-Za-z0-9_.\\/ -]+\.[A-Za-z0-9]+$/.test(line))
			.slice(0, 2),
	)
	const hitText =
		paths.length > 0
			? ` Eerste hits: ${paths.map((path) => `\`${path}\``).join(" en ")}.`
			: ""
	return `De zoekopdracht naar '${query}' leverde ${count} resultaten op.${hitText}`
}

function unique(values: string[]): string[] {
	return [...new Set(values)]
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
	const openAiToolNames = new Set<string>()
	const openAiDeclarations = (tools || [])
		.map((tool) => {
			if (tool.type === "function") {
				openAiToolNames.add(tool.function.name)
			}
			return formatToolDeclaration(tool)
		})
		.filter((declaration) => declaration.length > 0)
	const fallbackDeclarations = fallbackClineToolDeclarations(systemPrompt, openAiToolNames)
	if (openAiDeclarations.length > 0) {
		return [...openAiDeclarations, ...fallbackDeclarations].join("")
	}
	return fallbackDeclarations.join("")
}

function fallbackClineToolDeclarations(systemPrompt: string, skipToolNames = new Set<string>()): string[] {
	return fallbackClineTools
		.filter((tool) => !skipToolNames.has(tool.name) && systemPromptMentionsTool(systemPrompt, tool.name))
		.map((tool) => `<|tool>declaration:${tool.name}${JSON.stringify(tool.schema)}<tool|>`)
}

function systemPromptMentionsTool(systemPrompt: string, toolName: string): boolean {
	return (
		systemPrompt.includes(`## ${toolName}`) ||
		systemPrompt.includes(`<${toolName}>`) ||
		new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(toolName)}([^A-Za-z0-9_]|$)`).test(systemPrompt)
	)
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
		content: raw,
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
