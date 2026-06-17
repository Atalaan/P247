import { tokenizeGemma4, type Gemma4Token } from "./lexer"

export interface Gemma4ToolCall {
	name: string
	arguments: Record<string, unknown>
}

export interface Gemma4PartialToolCall {
	index: number
	name: string
	argumentsText: string
}

export interface Gemma4ThinkingProgress {
	thinking: string
	complete: boolean
	detected: boolean
}

const callPrefix = "call:"
const stringMarker = "\x00"
const toolCallStartMarker = "<|tool_call>"
const toolCallEndMarker = "<tool_call|>"

export function hasGemma4ToolCall(text: string): boolean {
	return text.includes(toolCallStartMarker)
}

export function hasCompleteGemma4ToolCall(text: string): boolean {
	return text.includes(toolCallStartMarker) && text.includes(toolCallEndMarker)
}

export function parseGemma4ToolCalls(
	text: string,
	options: { allowUnterminatedAtEof?: boolean } = {},
): Gemma4ToolCall[] {
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
		} else if (options.allowUnterminatedAtEof) {
			const call = parseGemma4ToolCallBody(body, { requireCompleteObject: true })
			if (call) {
				calls.push(call)
			}
		}
	}

	return calls
}

export function parseGemma4PartialToolCall(text: string): Gemma4PartialToolCall | undefined {
	let callStart = -1
	let searchFrom = 0
	let index = 0

	while (searchFrom < text.length) {
		const nextStart = text.indexOf(toolCallStartMarker, searchFrom)
		if (nextStart === -1) {
			break
		}
		const bodyStart = nextStart + toolCallStartMarker.length
		const nextEnd = text.indexOf(toolCallEndMarker, bodyStart)
		if (nextEnd === -1) {
			callStart = nextStart
			break
		}
		index += 1
		searchFrom = nextEnd + toolCallEndMarker.length
	}

	if (callStart === -1) {
		return undefined
	}

	const bodyStart = callStart + toolCallStartMarker.length
	let body = text.slice(bodyStart).trimStart()
	const partialEndMarker = body.indexOf("<tool_call")
	if (partialEndMarker !== -1) {
		body = body.slice(0, partialEndMarker)
	}

	if (!body.startsWith(callPrefix)) {
		return undefined
	}

	const braceIndex = body.indexOf("{")
	if (braceIndex === -1) {
		return undefined
	}

	const name = body.slice(callPrefix.length, braceIndex).trim()
	if (!name) {
		return undefined
	}

	const argumentsText = body.slice(braceIndex)
	if (!argumentsText) {
		return undefined
	}

	return { index, name, argumentsText }
}

export function extractGemma4Thinking(text: string): { thinking: string; complete: boolean } {
	const progress = extractGemma4ThinkingProgress(text)
	return {
		thinking: progress.complete ? progress.thinking.trim() : "",
		complete: progress.complete,
	}
}

export function extractGemma4ThinkingProgress(text: string): Gemma4ThinkingProgress {
	const tokens = tokenizeGemma4(text)
	let inChannel = false
	let sawChannelEnd = false
	let channelText = ""
	let thinking = ""
	let detected = false

	for (const token of tokens) {
		if (token.type === "CHANNEL_START") {
			inChannel = true
			channelText = ""
			continue
		}
		if (token.type === "CHANNEL_END") {
			inChannel = false
			sawChannelEnd = true
			const normalized = normalizeGemma4ThinkingChannelText(channelText)
			if (normalized !== null) {
				thinking = normalized
				detected = true
			}
			continue
		}
		if (inChannel) {
			channelText += token.value
		}
	}

	if (inChannel) {
		const normalized = normalizeGemma4ThinkingChannelText(channelText)
		if (normalized !== null) {
			thinking = normalized
			detected = true
		}
	}

	return { thinking, complete: sawChannelEnd && detected, detected }
}

function normalizeGemma4ThinkingChannelText(channelText: string): string | null {
	const trimmed = channelText.trimStart()
	if (!trimmed) {
		return null
	}
	if (trimmed.startsWith("thought\n")) {
		return trimmed.slice("thought\n".length)
	}
	if (trimmed === "thought" || "thought".startsWith(trimmed)) {
		return ""
	}
	if (trimmed.startsWith("thought")) {
		const remainder = trimmed.slice("thought".length)
		if (remainder.startsWith("\n")) {
			return remainder.slice(1)
		}
		return ""
	}
	return trimmed
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

function parseGemma4ToolCallBody(
	tokens: Gemma4Token[],
	options: { requireCompleteObject?: boolean } = {},
): Gemma4ToolCall | undefined {
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

	let argsText = fullText.slice(braceIndex)
	if (options.requireCompleteObject) {
		const completeArgsText = completeLeadingJsonObject(argsText)
		if (!completeArgsText) {
			return undefined
		}
		argsText = completeArgsText
	}
	try {
		const parsed = JSON.parse(argsText)
		return {
			name,
			arguments: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
		}
	} catch {
		const looseArgs = parseLooseGemma4Args(argsText)
		if (Object.keys(looseArgs).length > 0) {
			return {
				name,
				arguments: looseArgs,
			}
		}
		return {
			name,
			arguments: parseGemma4DelimitedArgs(tokens),
		}
	}
}

function completeLeadingJsonObject(text: string): string | undefined {
	if (!text.startsWith("{")) {
		return undefined
	}

	let depth = 0
	let inString = false
	let escaped = false
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]
		if (inString) {
			if (escaped) {
				escaped = false
				continue
			}
			if (char === "\\") {
				escaped = true
				continue
			}
			if (char === '"') {
				inString = false
			}
			continue
		}

		if (char === '"') {
			inString = true
			continue
		}
		if (char === "{") {
			depth += 1
			continue
		}
		if (char === "}") {
			depth -= 1
			if (depth === 0) {
				return text.slice(0, index + 1)
			}
		}
	}

	return undefined
}

function parseLooseGemma4Args(argsText: string): Record<string, unknown> {
	const start = argsText.indexOf("{")
	const end = argsText.lastIndexOf("}")
	if (start === -1 || end === -1 || start >= end) {
		return {}
	}

	const body = argsText.slice(start + 1, end)
	const args: Record<string, unknown> = {}
	let pos = 0

	while (pos < body.length) {
		while (pos < body.length && (body[pos] === "," || /\s/.test(body[pos]))) {
			pos += 1
		}
		if (pos >= body.length) {
			break
		}

		const keyResult = readLooseKey(body, pos)
		if (!keyResult) {
			break
		}
		const key = normalizeGemma4ArgKey(keyResult.value)
		pos = keyResult.next
		while (pos < body.length && /\s/.test(body[pos])) {
			pos += 1
		}
		if (!key || body[pos] !== ":") {
			break
		}
		pos += 1
		while (pos < body.length && /\s/.test(body[pos])) {
			pos += 1
		}

		const valueResult = readLooseValue(body, pos)
		args[key] = valueResult.value
		pos = valueResult.next
	}

	return args
}

function readLooseKey(text: string, pos: number): { value: string; next: number } | undefined {
	if (text[pos] === '"') {
		return readLooseKeyString(text, pos)
	}

	const start = pos
	while (pos < text.length && text[pos] !== ":") {
		pos += 1
	}
	if (pos >= text.length) {
		return undefined
	}
	return { value: text.slice(start, pos).trim(), next: pos }
}

function readLooseKeyString(text: string, pos: number): { value: string; next: number } | undefined {
	let value = ""
	pos += 1

	while (pos < text.length) {
		const char = text[pos]
		if (char === "\\") {
			const next = text[pos + 1]
			if (next) {
				value += next
				pos += 2
				continue
			}
		}

		if (char === '"') {
			let lookahead = pos + 1
			while (lookahead < text.length && /\s/.test(text[lookahead])) {
				lookahead += 1
			}
			if (text[lookahead] === ":") {
				return { value, next: pos + 1 }
			}
		}

		value += char
		pos += 1
	}

	return undefined
}

function readLooseValue(text: string, pos: number): { value: unknown; next: number } {
	if (text[pos] === '"') {
		return readLooseString(text, pos)
	}

	const start = pos
	while (pos < text.length && text[pos] !== "," && text[pos] !== "}") {
		pos += 1
	}
	return { value: castGemma4Value(text.slice(start, pos).trim()), next: pos }
}

function readLooseString(text: string, pos: number): { value: string; next: number } {
	let value = ""
	pos += 1

	while (pos < text.length) {
		const char = text[pos]
		if (char === "\\") {
			const next = text[pos + 1]
			if (next === "n") {
				value += "\n"
				pos += 2
				continue
			}
			if (next === "r") {
				const after = text[pos + 2]
				if (!after || /[,\]}"\s]/.test(after)) {
					value += "\r"
					pos += 2
					continue
				}
			}
			if (next === "t") {
				value += "\t"
				pos += 2
				continue
			}
			if (next === '"' || next === "\\" || next === "/") {
				value += next
				pos += 2
				continue
			}
			if (next) {
				value += `\\${next}`
				pos += 2
				continue
			}
		}
		if (char === '"' && isLooseStringTerminator(text, pos + 1)) {
			return { value, next: pos + 1 }
		}
		value += char
		pos += 1
	}

	return { value, next: pos }
}

function isLooseStringTerminator(text: string, pos: number): boolean {
	while (pos < text.length && /\s/.test(text[pos])) {
		pos += 1
	}
	return pos >= text.length || text[pos] === "," || text[pos] === "}"
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
		const key = normalizeGemma4ArgKey(body.slice(keyStart, pos).trim())
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

function normalizeGemma4ArgKey(key: string): string {
	return key
		.replaceAll(stringMarker, "")
		.replace(/^"+|"+$/g, "")
		.trim()
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
