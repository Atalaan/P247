import type { ApiStreamChunk, ApiStreamToolCallsChunk } from "../stream"
import { extractGemma4FinalResponse, extractGemma4Thinking, type Gemma4ToolCall, parseGemma4ToolCalls } from "./parser"

export class Gemma4KesslerStreamAdapter {
	private buffer = ""
	private emittedToolCallCount = 0
	private emittedThinking = false

	push(delta: string): ApiStreamChunk[] {
		this.buffer += delta
		const chunks: ApiStreamChunk[] = []

		this.pushThinkingIfComplete(chunks)
		for (const chunk of this.newToolCallChunks({ allowUnterminatedAtEof: true })) {
			chunks.push(chunk)
		}

		return chunks
	}

	finish(): ApiStreamChunk[] {
		const chunks: ApiStreamChunk[] = []
		this.pushThinkingIfComplete(chunks)

		for (const chunk of this.newToolCallChunks()) {
			chunks.push(chunk)
		}

		if (this.emittedToolCallCount === 0) {
			const text = extractGemma4FinalResponse(this.buffer)
			if (text) {
				chunks.push(this.toToolCallChunk({ name: "attempt_completion", arguments: { result: text } }, 0))
				this.emittedToolCallCount = 1
			}
		}

		return chunks
	}

	getRawText(): string {
		return this.buffer
	}

	private pushThinkingIfComplete(chunks: ApiStreamChunk[]): void {
		if (this.emittedThinking) {
			return
		}
		const { thinking, complete } = extractGemma4Thinking(this.buffer)
		if (complete && thinking) {
			chunks.push({ type: "reasoning", reasoning: thinking })
			this.emittedThinking = true
		}
	}

	private newToolCallChunks(options: { allowUnterminatedAtEof?: boolean } = {}): ApiStreamToolCallsChunk[] {
		const calls = parseGemma4ToolCalls(this.buffer, options)
		if (calls.length <= this.emittedToolCallCount) {
			return []
		}

		const chunks: ApiStreamToolCallsChunk[] = []
		for (let index = this.emittedToolCallCount; index < calls.length; index += 1) {
			chunks.push(this.toToolCallChunk(calls[index], index))
		}
		this.emittedToolCallCount = calls.length
		return chunks
	}

	private toToolCallChunk(call: Gemma4ToolCall, index: number): ApiStreamToolCallsChunk {
		const cleanArguments = stripNullish(call.arguments)
		const callId = `call_gemma4_${index + 1}_${stableHash(`${call.name}:${JSON.stringify(cleanArguments)}`)}`
		return {
			type: "tool_calls",
			tool_call: {
				call_id: callId,
				function: {
					id: callId,
					name: call.name,
					arguments: JSON.stringify(cleanArguments),
				},
			},
		}
	}
}

function stripNullish(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripNullish).filter((item) => item !== undefined)
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (child === null || child === undefined) {
				continue
			}
			const cleaned = stripNullish(child)
			if (cleaned !== undefined) {
				out[key] = cleaned
			}
		}
		return out
	}
	return value
}

function stableHash(value: string): string {
	let hash = 2166136261
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return (hash >>> 0).toString(16).padStart(8, "0")
}
