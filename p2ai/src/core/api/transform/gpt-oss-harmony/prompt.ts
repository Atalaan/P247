import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import type {
	ClineAssistantToolUseBlock,
	ClineContent,
	ClineStorageMessage,
	ClineUserToolResultContentBlock,
} from "@/shared/messages/content"

export interface GptOssHarmonyPromptOptions {
	systemPrompt: string
	messages: ClineStorageMessage[]
	tools?: OpenAITool[]
	reasoning?: "low" | "medium" | "high"
	currentDate?: string
}

export interface GptOssHarmonyRepairPromptOptions extends GptOssHarmonyPromptOptions {
	invalidResponse: string
}

export function buildGptOssHarmonyPrompt(options: GptOssHarmonyPromptOptions): string {
	const parts: string[] = []
	const toolUseIdToName = new Map<string, string>()

	parts.push(systemMessage(options.reasoning, options.currentDate, hasTools(options.systemPrompt, options.tools)))
	parts.push(developerMessage(options.systemPrompt, options.tools))

	for (const message of options.messages) {
		if (message.role === "assistant") {
			parts.push(...assistantMessagesToHarmony(message, toolUseIdToName))
			continue
		}
		parts.push(...userMessagesToHarmony(message, toolUseIdToName))
	}

	parts.push("<|start|>assistant")
	return parts.join("")
}

export function buildGptOssHarmonyRepairPrompt(options: GptOssHarmonyRepairPromptOptions): string {
	const latestUser = latestUserTextForRepair(options.messages)
	const invalid = sanitizeHarmonyText(options.invalidResponse).slice(0, 1600)
	return [
		systemMessage("low", options.currentDate, true),
		"<|start|>developer<|message|># Instructions\n",
		"Repair the previous invalid GPT-OSS Harmony response into exactly one valid function call.\n",
		"Output no prose. The first generated token after the assistant header must be <|channel|>commentary.\n",
		"Use this exact form:\n",
		"<|channel|>commentary to=functions.tool_name <|constrain|>json<|message|>{\"arg\":\"value\"}<|call|>\n",
		"If the request is fully satisfied, call functions.attempt_completion with a result string.\n",
		"Never output XML Cline tool tags or plain JSON outside a Harmony function call.\n\n",
		"# Tools\n\n",
		"## functions\n\n",
		toolDeclarationsForPrompt(options.systemPrompt, options.tools),
		"<|end|>",
		"<|start|>user<|message|>LATEST_USER:\n",
		sanitizeHarmonyText(latestUser),
		"\n\nPREVIOUS_INVALID_RESPONSE:\n",
		invalid,
		"<|end|>",
		"<|start|>assistant",
	].join("")
}

function systemMessage(reasoning: GptOssHarmonyPromptOptions["reasoning"], currentDate: string | undefined, withTools: boolean): string {
	return [
		"<|start|>system<|message|>You are ChatGPT, a large language model trained by OpenAI.\n",
		"Knowledge cutoff: 2024-06\n",
		`Current date: ${currentDate || "2026-06-09"}\n\n`,
		`Reasoning: ${reasoning || "medium"}\n\n`,
		"# Valid channels: analysis, commentary, final. Channel must be included for every message.\n",
		withTools ? "Calls to these tools must go to the commentary channel: 'functions'.\n" : "",
		"<|end|>",
	].join("")
}

function developerMessage(systemPrompt: string, tools?: OpenAITool[]): string {
	return [
		"<|start|>developer<|message|># Instructions\n\n",
		sanitizeHarmonyText(systemPrompt),
		"\n\n# P2AI Cline tool protocol\n\n",
		"You are driving the real Cline agent loop. Use function calls for all actions.\n",
		"Use concrete workspace tools when evidence is needed. Do not invent file contents, paths, command output, or search results.\n",
		"Use functions.attempt_completion only after the user request is satisfied.\n",
		"Directory listing requests must use functions.list_files. File-content requests must use functions.read_file. Regex/content search requests must use functions.search_files.\n",
		"Each function call must use valid JSON arguments and this exact Harmony form:\n",
		"<|channel|>commentary to=functions.tool_name <|constrain|>json<|message|>{\"arg\":\"value\"}<|call|>\n",
		"Never output XML Cline tool tags.\n\n",
		"# Tools\n\n",
		"## functions\n\n",
		toolDeclarationsForPrompt(systemPrompt, tools),
		"<|end|>",
	].join("")
}

function hasTools(systemPrompt: string, tools?: OpenAITool[]): boolean {
	return (tools || []).some((tool) => tool.type === "function" && tool.function.name !== "plan_mode_respond") ||
		fallbackClineTools.some((tool) => systemPrompt.includes(`## ${tool.name}`) || systemPrompt.includes(`<${tool.name}>`))
}

function toolDeclarationsForPrompt(systemPrompt: string, tools?: OpenAITool[]): string {
	const declarations = (tools || [])
		.map(formatOpenAiToolDeclaration)
		.filter((declaration) => declaration.length > 0)
	if (declarations.length > 0) {
		return `namespace functions {\n\n${declarations.join("\n")}} // namespace functions\n`
	}
	const fallback = fallbackClineTools
		.filter((tool) => systemPrompt.includes(`## ${tool.name}`) || systemPrompt.includes(`<${tool.name}>`))
		.map((tool) => formatToolDeclaration(tool.name, tool.schema))
	return `namespace functions {\n\n${fallback.join("\n")}} // namespace functions\n`
}

function formatOpenAiToolDeclaration(tool: OpenAITool): string {
	if (tool.type !== "function" || tool.function.name === "plan_mode_respond") {
		return ""
	}
	const schema = conciseToolSchema(tool.function.name, tool.function.parameters)
	return formatToolDeclaration(tool.function.name, schema)
}

function formatToolDeclaration(name: string, schema: { description: string; parameters: unknown }): string {
	const description = schema.description ? `// ${sanitizeToolComment(schema.description)}\n` : ""
	return `${description}type ${name} = (_: ${schemaToType(schema.parameters)}) => any;\n`
}

function schemaToType(schema: unknown): string {
	const map = objectFromUnknown(schema)
	if (map.type !== "object") {
		return "Record<string, any>"
	}
	const properties = objectFromUnknown(map.properties)
	const required = Array.isArray(map.required) ? new Set(map.required.map(String)) : new Set<string>()
	const lines = ["{"]
	for (const [key, value] of Object.entries(properties)) {
		const child = objectFromUnknown(value)
		if (child.description) {
			lines.push(`// ${sanitizeToolComment(String(child.description))}`)
		}
		const optional = required.has(key) ? "" : "?"
		lines.push(`${key}${optional}: ${schemaPropertyType(child)},`)
	}
	lines.push("}")
	return lines.join("\n")
}

function schemaPropertyType(schema: Record<string, unknown>): string {
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.map((item) => JSON.stringify(String(item))).join(" | ")
	}
	switch (schema.type) {
		case "string":
			return "string"
		case "boolean":
			return "boolean"
		case "integer":
		case "number":
			return "number"
		case "array": {
			const itemType = schemaPropertyType(objectFromUnknown(schema.items))
			return `${itemType}[]`
		}
		case "object":
			return schemaToType(schema)
		default:
			return "any"
	}
}

function assistantMessagesToHarmony(
	message: ClineStorageMessage,
	toolUseIdToName: Map<string, string>,
): string[] {
	const content = message.content
	if (typeof content === "string") {
		return content.trim() ? [`<|start|>assistant<|channel|>final<|message|>${sanitizeHarmonyText(content)}<|end|>`] : []
	}

	const out: string[] = []
	for (const block of content) {
		if (block.type === "thinking") {
			const thinking = sanitizeHarmonyText(block.thinking || "")
			if (thinking) {
				out.push(`<|start|>assistant<|channel|>analysis<|message|>${thinking}<|end|>`)
			}
		} else if (block.type === "text") {
			const text = sanitizeHarmonyText(block.text || "")
			if (text) {
				out.push(`<|start|>assistant<|channel|>final<|message|>${text}<|end|>`)
			}
		} else if (block.type === "tool_use") {
			const toolUse = block as ClineAssistantToolUseBlock
			toolUseIdToName.set(toolUse.id, toolUse.name)
			out.push(formatToolCall(toolUse.name, objectFromUnknown(toolUse.input)))
		}
	}
	return out
}

function userMessagesToHarmony(
	message: ClineStorageMessage,
	toolUseIdToName: Map<string, string>,
): string[] {
	const content = message.content
	if (typeof content === "string") {
		return [`<|start|>user<|message|>${sanitizeHarmonyText(content)}<|end|>`]
	}

	const out: string[] = []
	const textParts: string[] = []
	for (const block of content) {
		if (block.type === "text") {
			textParts.push(sanitizeHarmonyText(block.text || ""))
		} else if (block.type === "tool_result") {
			const result = block as ClineUserToolResultContentBlock
			const toolName = toolUseIdToName.get(result.tool_use_id) || result.tool_use_id || "unknown_tool"
			out.push(formatToolResponse(toolName, contentBlockToText(result.content)))
		} else if (block.type === "image") {
			textParts.push("[image omitted]")
		} else if (block.type === "document") {
			textParts.push("[document omitted]")
		}
	}
	if (textParts.filter(Boolean).length > 0) {
		out.push(`<|start|>user<|message|>${textParts.filter(Boolean).join("\n")}<|end|>`)
	}
	return out
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	return `<|start|>assistant<|channel|>commentary to=functions.${name} <|constrain|>json<|message|>${JSON.stringify(args)}<|call|>`
}

function formatToolResponse(name: string, content: string): string {
	const raw = sanitizeHarmonyText(content)
	return `<|start|>functions.${name} to=assistant<|channel|>commentary<|message|>${raw}<|end|>`
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

function conciseToolSchema(name: string, parameters: unknown): { description: string; parameters: unknown } {
	const known = conciseClineToolSchemas[name]
	if (known) {
		return known
	}
	return {
		description: `Use ${name} when required by the task.`,
		parameters: parameters ?? { type: "object", properties: {} },
	}
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

function sanitizeHarmonyText(value: string): string {
	return value
		.replaceAll("<|start|>", "")
		.replaceAll("<|end|>", "")
		.replaceAll("<|return|>", "")
		.replaceAll("<|call|>", "")
		.replaceAll("<|message|>", "")
		.replaceAll("<|channel|>", "")
		.replaceAll("<|constrain|>", "")
}

function sanitizeToolComment(value: string): string {
	return sanitizeHarmonyText(value).replaceAll("\n", " ").replaceAll("*/", "* /")
}

function objectFromUnknown(value: unknown): Record<string, any> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, any>
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
