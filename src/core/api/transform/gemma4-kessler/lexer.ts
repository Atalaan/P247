export type Gemma4TokenType =
	| "TOOL_CALL_START"
	| "TOOL_CALL_END"
	| "TOOL_RESPONSE_START"
	| "TOOL_RESPONSE_END"
	| "STRING_DELIM"
	| "CHANNEL_START"
	| "CHANNEL_END"
	| "TURN_START"
	| "TURN_END"
	| "TOOL_DECL_START"
	| "TOOL_DECL_END"
	| "EOS"
	| "END_OF_TURN"
	| "BOS"
	| "IMAGE"
	| "THINK"
	| "TEXT"

export interface Gemma4Token {
	type: Gemma4TokenType
	value: string
}

const specialTokens: readonly [string, Gemma4TokenType][] = [
	["<|tool_response>", "TOOL_RESPONSE_START"],
	["<tool_response|>", "TOOL_RESPONSE_END"],
	["<|tool_call>", "TOOL_CALL_START"],
	["<tool_call|>", "TOOL_CALL_END"],
	["<end_of_turn>", "END_OF_TURN"],
	["<|channel>", "CHANNEL_START"],
	["<channel|>", "CHANNEL_END"],
	["<|image|>", "IMAGE"],
	["<|think|>", "THINK"],
	["<|turn>", "TURN_START"],
	["<turn|>", "TURN_END"],
	["<|tool>", "TOOL_DECL_START"],
	["<tool|>", "TOOL_DECL_END"],
	['<|"|>', "STRING_DELIM"],
	["<eos>", "EOS"],
	["<bos>", "BOS"],
]

export function tokenizeGemma4(input: string): Gemma4Token[] {
	const tokens: Gemma4Token[] = []
	let pos = 0
	let textStart = 0

	while (pos < input.length) {
		if (input[pos] === "<") {
			let matched = false
			for (const [value, type] of specialTokens) {
				if (input.startsWith(value, pos)) {
					if (pos > textStart) {
						tokens.push({ type: "TEXT", value: input.slice(textStart, pos) })
					}
					tokens.push({ type, value })
					pos += value.length
					textStart = pos
					matched = true
					break
				}
			}
			if (!matched) {
				pos += 1
			}
		} else {
			pos += 1
		}
	}

	if (pos > textStart) {
		tokens.push({ type: "TEXT", value: input.slice(textStart, pos) })
	}

	return tokens
}
