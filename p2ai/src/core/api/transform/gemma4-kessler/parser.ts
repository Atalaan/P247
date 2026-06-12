import { tokenizeGemma4, type Gemma4Token } from "./lexer"

export interface Gemma4ToolCall {
	name: string
	arguments: Record<string, unknown>
}

const callPrefix = "call:"
const stringMarker = "\x00"

export function hasGemma4ToolCall(text: string): boolean {
	return text.includes("<|tool_call>")
}

export function hasCompleteGemma4ToolCall(text: string): boolean {
	return text.includes("<|tool_call>") && text.includes("<tool_call|>")
}

export function parseGemma4ToolCalls(text: string): Gemma4ToolCall[] {
	const tokens = tokenizeGemma4(text)
	const calls: Gemma4ToolCall[] = []
	let index = 0

	while (index < tokens.length) {
		if (tokens[index].type !== "TOOL_CALL_START") {
			index += 1
			continue
		}

		index += 1
		const body: Gemma4Token[] = []
		while (index < tokens.length && tokens[index].type !== "TOOL_CALL_END") {
			body.push(tokens[index])
			index += 1
		}

		if (index < tokens.length) {
			index += 1
			const call = parseGemma4ToolCallBody(body)
			if (call) {
				calls.push(call)
			}
		}
	}

	return calls
}

export function extractGemma4Thinking(text: string): { thinking: string; complete: boolean } {
	const tokens = tokenizeGemma4(text)
	let inChannel = false
	let sawChannelEnd = false
	let channelText = ""
	let thinking = ""

	for (const token of tokens) {
		if (token.type === "CHANNEL_START") {
			inChannel = true
			channelText = ""
			continue
		}
		if (token.type === "CHANNEL_END") {
			inChannel = false
			sawChannelEnd = true
			const trimmed = channelText.trimStart()
			if (trimmed.startsWith("thought\n")) {
				thinking = trimmed.slice("thought\n".length).trim()
			} else if (trimmed.startsWith("thought")) {
				thinking = trimmed.slice("thought".length).trim()
			} else {
				thinking = trimmed.trim()
			}
			continue
		}
		if (inChannel) {
			channelText += token.value
		}
	}

	return { thinking, complete: sawChannelEnd }
}

export function extractGemma4FinalResponse(text: string): string {
	const tokens = tokenizeGemma4(text)
	const parts: string[] = []
	let depth = 0
	let afterTurnStart = false

	for (const token of tokens) {
		if (
			token.type === "TOOL_CALL_START" ||
			token.type === "TOOL_RESPONSE_START" ||
			token.type === "CHANNEL_START" ||
			token.type === "TOOL_DECL_START"
		) {
			depth += 1
			continue
		}
		if (
			token.type === "TOOL_CALL_END" ||
			token.type === "TOOL_RESPONSE_END" ||
			token.type === "CHANNEL_END" ||
			token.type === "TOOL_DECL_END"
		) {
			depth = Math.max(0, depth - 1)
			continue
		}
		if (depth > 0) {
			continue
		}

		if (token.type === "TURN_START") {
			afterTurnStart = true
			continue
		}

		if (
			token.type === "TURN_END" ||
			token.type === "EOS" ||
			token.type === "END_OF_TURN" ||
			token.type === "BOS" ||
			token.type === "IMAGE" ||
			token.type === "THINK" ||
			token.type === "STRING_DELIM"
		) {
			continue
		}

		if (token.type === "TEXT") {
			let value = token.value
			if (afterTurnStart) {
				afterTurnStart = false
				for (const role of ["model", "assistant", "system", "user"]) {
					if (value.startsWith(role)) {
						value = value.slice(role.length).trimStart()
						break
					}
				}
			}
			if (value) {
				parts.push(value)
			}
		}
	}

	return parts.join("").trim()
}

function parseGemma4ToolCallBody(tokens: Gemma4Token[]): Gemma4ToolCall | undefined {
	const fullText = tokens
		.filter((token) => token.type === "TEXT")
		.map((token) => token.value)
		.join("")

	if (!fullText.startsWith(callPrefix)) {
		return undefined
	}

	const braceIndex = fullText.indexOf("{")
	if (braceIndex === -1) {
		return undefined
	}

	const name = fullText.slice(callPrefix.length, braceIndex).trim()
	if (!name) {
		return undefined
	}

	const argsText = fullText.slice(braceIndex)
	try {
		const parsed = JSON.parse(argsText)
		return {
			name,
			arguments: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
		}
	} catch {
		return {
			name,
			arguments: parseGemma4DelimitedArgs(tokens),
		}
	}
}

function parseGemma4DelimitedArgs(tokens: Gemma4Token[]): Record<string, unknown> {
	let rebuilt = ""
	for (const token of tokens) {
		if (token.type === "STRING_DELIM") {
			rebuilt += stringMarker
		} else if (token.type === "TEXT") {
			rebuilt += token.value
		}
	}

	const start = rebuilt.indexOf("{")
	const end = rebuilt.lastIndexOf("}")
	if (start === -1 || end === -1 || start >= end) {
		return {}
	}

	const body = rebuilt.slice(start + 1, end)
	const args: Record<string, unknown> = {}
	let pos = 0

	while (pos < body.length) {
		while (pos < body.length && (body[pos] === "," || /\s/.test(body[pos]))) {
			pos += 1
		}
		if (pos >= body.length) {
			break
		}

		const keyStart = pos
		while (pos < body.length && body[pos] !== ":") {
			pos += 1
		}
		const key = body.slice(keyStart, pos).trim()
		if (!key || pos >= body.length) {
			break
		}
		pos += 1

		if (body[pos] === stringMarker) {
			pos += 1
			const valueStart = pos
			while (pos < body.length && body[pos] !== stringMarker) {
				pos += 1
			}
			args[key] = body.slice(valueStart, pos)
			if (pos < body.length) {
				pos += 1
			}
		} else {
			const valueStart = pos
			while (pos < body.length && body[pos] !== ",") {
				pos += 1
			}
			args[key] = castGemma4Value(body.slice(valueStart, pos).trim())
		}
	}

	return args
}

function castGemma4Value(value: string): unknown {
	if (value === "true") {
		return true
	}
	if (value === "false") {
		return false
	}
	if (value === "null") {
		return null
	}

	const numberValue = Number(value)
	if (!Number.isNaN(numberValue) && value !== "") {
		return numberValue
	}

	return value
}
