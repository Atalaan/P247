export interface GptOssHarmonyToolCall {
	name: string
	arguments: Record<string, unknown>
}

const toolCallPattern =
	/(?:<\|start\|>assistant)?<\|channel\|>commentary\s+to=(?:functions\.)?([A-Za-z0-9_]+)\s*(?:<\|constrain\|>json)?<\|message\|>([\s\S]*?)(?:<\|call\|>|<\|end\|>|<\|return\|>|$)/g

export function parseGptOssHarmonyToolCalls(text: string): GptOssHarmonyToolCall[] {
	const calls: GptOssHarmonyToolCall[] = []
	for (const match of text.matchAll(toolCallPattern)) {
		const name = match[1]?.trim()
		if (!name) {
			continue
		}
		const args = parseToolArguments(match[2] || "")
		calls.push({ name, arguments: args })
	}
	return calls
}

export function extractGptOssHarmonyReasoning(text: string): { reasoning: string; complete: boolean } {
	const analysisPattern =
		/(?:<\|start\|>assistant)?<\|channel\|>analysis<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|start\|>assistant<\|channel\|>commentary|<\|start\|>assistant<\|channel\|>final)/
	const match = analysisPattern.exec(text)
	if (!match) {
		return { reasoning: "", complete: false }
	}
	return { reasoning: stripHarmonyTokens(match[1]).trim(), complete: true }
}

export function extractGptOssHarmonyFinal(text: string): string {
	const finalPattern = /(?:<\|start\|>assistant)?<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|return\|>|<\|end\|>|$)/
	const match = finalPattern.exec(text)
	if (!match) {
		return ""
	}
	return stripHarmonyTokens(match[1]).trim()
}

function parseToolArguments(raw: string): Record<string, unknown> {
	const text = stripHarmonyTokens(raw).trim()
	if (!text) {
		return {}
	}
	const jsonText = sliceFirstJsonObject(text)
	if (!jsonText) {
		return {}
	}
	try {
		const parsed = JSON.parse(jsonText)
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

function sliceFirstJsonObject(text: string): string | undefined {
	const start = text.indexOf("{")
	if (start === -1) {
		return undefined
	}
	let depth = 0
	let inString = false
	let escaped = false
	for (let index = start; index < text.length; index += 1) {
		const char = text[index]
		if (escaped) {
			escaped = false
			continue
		}
		if (char === "\\") {
			escaped = true
			continue
		}
		if (char === '"') {
			inString = !inString
			continue
		}
		if (inString) {
			continue
		}
		if (char === "{") {
			depth += 1
		} else if (char === "}") {
			depth -= 1
			if (depth === 0) {
				return text.slice(start, index + 1)
			}
		}
	}
	return text.slice(start)
}

function stripHarmonyTokens(value: string): string {
	return value
		.replaceAll("<|start|>", "")
		.replaceAll("<|end|>", "")
		.replaceAll("<|return|>", "")
		.replaceAll("<|call|>", "")
		.replaceAll("<|message|>", "")
		.replaceAll("<|channel|>", "")
		.replaceAll("<|constrain|>json", "")
}
