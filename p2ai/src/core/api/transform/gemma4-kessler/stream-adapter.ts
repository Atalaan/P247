import type { ApiStreamChunk, ApiStreamToolCallsChunk } from "../stream"
import {
	extractGemma4FinalResponse,
	extractGemma4ThinkingProgress,
	parseGemma4PartialToolCall,
	parseGemma4ToolCalls,
	type Gemma4ToolCall,
	type Gemma4PartialToolCall,
} from "./parser"

export class Gemma4KesslerStreamAdapter {
	private buffer = ""
	private emittedToolCallCount = 0
	private emittedThinkingText = ""
	private completedThinking = false
	private partialToolCall:
		| {
				index: number
				id: string
				name: string
				emittedArgumentsText: string
		  }
		| undefined

	push(delta: string): ApiStreamChunk[] {
		this.buffer += delta
		const chunks: ApiStreamChunk[] = []

		this.pushThinkingDelta(chunks)
		for (const chunk of this.newPartialToolCallChunks()) {
			chunks.push(chunk)
		}
		for (const chunk of this.newToolCallChunks()) {
			chunks.push(chunk)
		}

		return chunks
	}

	finish(): ApiStreamChunk[] {
		const chunks: ApiStreamChunk[] = []
		this.pushThinkingDelta(chunks)

		for (const chunk of this.newToolCallChunks({ allowUnterminatedAtEof: true })) {
			chunks.push(chunk)
		}

		return chunks
	}

	getRawText(): string {
		return this.buffer
	}

	getFinalText(): string {
		return extractGemma4FinalResponse(this.buffer)
	}

	hasEmittedToolCall(): boolean {
		return this.emittedToolCallCount > 0
	}

	private pushThinkingDelta(chunks: ApiStreamChunk[]): void {
		if (this.completedThinking) {
			return
		}
		const { thinking, complete, detected } = extractGemma4ThinkingProgress(this.buffer)
		if (detected && thinking) {
			const nextDelta = thinking.startsWith(this.emittedThinkingText)
				? thinking.slice(this.emittedThinkingText.length)
				: thinking
			if (nextDelta) {
				chunks.push({ type: "reasoning", reasoning: nextDelta })
				this.emittedThinkingText = thinking
			}
		}
		if (complete) {
			this.completedThinking = true
		}
	}

	private newToolCallChunks(options: { allowUnterminatedAtEof?: boolean } = {}): ApiStreamToolCallsChunk[] {
		const calls = parseGemma4ToolCalls(this.buffer, options)
		if (calls.length <= this.emittedToolCallCount) {
			return []
		}

		const chunks: ApiStreamToolCallsChunk[] = []
		for (let index = this.emittedToolCallCount; index < calls.length; index += 1) {
			const chunk = this.toToolCallChunk(calls[index], index)
			if (chunk) {
				chunks.push(chunk)
			}
		}
		this.emittedToolCallCount = calls.length
		return chunks
	}

	private newPartialToolCallChunks(): ApiStreamToolCallsChunk[] {
		const partial = parseGemma4PartialToolCall(this.buffer)
		if (!partial || partial.index < this.emittedToolCallCount) {
			return []
		}
		if (partial.name === "attempt_completion") {
			return []
		}

		if (!this.partialToolCall || this.partialToolCall.index !== partial.index || this.partialToolCall.name !== partial.name) {
			this.partialToolCall = {
				index: partial.index,
				id: this.toolCallId(partial.index, partial.name),
				name: partial.name,
				emittedArgumentsText: "",
			}
		}

		const nextArgumentsDelta = partial.argumentsText.slice(this.partialToolCall.emittedArgumentsText.length)
		if (!nextArgumentsDelta) {
			return []
		}

		this.partialToolCall.emittedArgumentsText = partial.argumentsText
		return [this.toPartialToolCallChunk(partial, nextArgumentsDelta)]
	}

	private toPartialToolCallChunk(partial: Gemma4PartialToolCall, argumentsDelta: string): ApiStreamToolCallsChunk {
		const id = this.partialToolCall?.id ?? this.toolCallId(partial.index, partial.name)
		return {
			type: "tool_calls",
			partial: true,
			tool_call: {
				call_id: id,
				function: {
					id,
					name: partial.name,
					arguments: argumentsDelta,
				},
			},
		}
	}

	private toToolCallChunk(call: Gemma4ToolCall, index: number): ApiStreamToolCallsChunk | undefined {
		const cleanArguments = stripNullish(call.arguments)
		const callId = this.toolCallId(index, call.name)
		let argumentsText = JSON.stringify(cleanArguments)
		if (this.partialToolCall?.index === index && this.partialToolCall.name === call.name) {
			const alreadyEmitted = this.partialToolCall.emittedArgumentsText
			if (argumentsText.startsWith(alreadyEmitted)) {
				argumentsText = argumentsText.slice(alreadyEmitted.length)
			} else {
				argumentsText = ""
			}
			this.partialToolCall = undefined
		}
		if (!argumentsText) {
			argumentsText = JSON.stringify(cleanArguments)
		}
		return {
			type: "tool_calls",
			partial: false,
			tool_call: {
				call_id: callId,
				function: {
					id: callId,
					name: call.name,
					arguments: argumentsText,
				},
			},
		}
	}

	private toolCallId(index: number, name: string): string {
		return `call_gemma4_${index + 1}_${stableHash(`${index}:${name}`)}`
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
