import type { ApiStreamChunk, ApiStreamToolCallsChunk } from "../stream"
import {
	extractGptOssHarmonyFinal,
	extractGptOssHarmonyReasoning,
	parseGptOssHarmonyToolCalls,
	type GptOssHarmonyToolCall,
} from "./parser"

export class GptOssHarmonyStreamAdapter {
	private buffer = ""
	private emittedToolCallCount = 0
	private emittedReasoning = false

	push(delta: string): ApiStreamChunk[] {
		this.buffer += delta
		const chunks: ApiStreamChunk[] = []
		this.pushReasoningIfComplete(chunks)
		for (const chunk of this.newToolCallChunks()) {
			chunks.push(chunk)
		}
		return chunks
	}

	finish(): ApiStreamChunk[] {
		const chunks: ApiStreamChunk[] = []
		this.pushReasoningIfComplete(chunks)
		for (const chunk of this.newToolCallChunks()) {
			chunks.push(chunk)
		}
		return chunks
	}

	getRawText(): string {
		return this.buffer
	}

	getFinalText(): string {
		return extractGptOssHarmonyFinal(this.buffer)
	}

	hasEmittedToolCall(): boolean {
		return this.emittedToolCallCount > 0
	}

	private pushReasoningIfComplete(chunks: ApiStreamChunk[]): void {
		if (this.emittedReasoning) {
			return
		}
		const { reasoning, complete } = extractGptOssHarmonyReasoning(this.buffer)
		if (complete && reasoning) {
			chunks.push({ type: "reasoning", reasoning })
			this.emittedReasoning = true
		}
	}

	private newToolCallChunks(): ApiStreamToolCallsChunk[] {
		const calls = parseGptOssHarmonyToolCalls(this.buffer)
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

	private toToolCallChunk(call: GptOssHarmonyToolCall, index: number): ApiStreamToolCallsChunk {
		const cleanArguments = stripNullish(call.arguments)
		const callId = `call_gptoss_${index + 1}_${stableHash(`${call.name}:${JSON.stringify(cleanArguments)}`)}`
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
