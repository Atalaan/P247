import { recordP2AiDiagnosticEvent } from "@core/observability/p2ai-artifacts"
import { type ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import type { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { buildGemma4KesslerPrompt } from "../transform/gemma4-kessler/prompt"
import { Gemma4KesslerStreamAdapter } from "../transform/gemma4-kessler/stream-adapter"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

interface LmStudioHandlerOptions extends CommonApiHandlerOptions {
	lmStudioBaseUrl?: string
	lmStudioModelId?: string
	lmStudioMaxTokens?: string
}

export class LmStudioHandler implements ApiHandler {
	private options: LmStudioHandlerOptions
	private client: OpenAI | undefined

	constructor(options: LmStudioHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			try {
				this.client = createOpenAIClient({
					// Docs on the new v0 api endpoint: https://lmstudio.ai/docs/app/api/endpoints/rest
					baseURL: new URL("api/v0", this.options.lmStudioBaseUrl || "http://localhost:1234").toString(),
					apiKey: "noop",
				})
			} catch (error) {
				throw new Error(`Error creating LM Studio client: ${error.message}`)
			}
		}
		return this.client
	}

	private useGemma4KesslerProtocol(): boolean {
		return process.env.P2AI_C2AI_GEMMA4_PROTOCOL === "kessler"
	}

	private completionCap(): number | undefined {
		const explicitCompletionCap = Number(process.env.P2AI_C2AI_MAX_COMPLETION_TOKENS)
		if (Number.isFinite(explicitCompletionCap) && explicitCompletionCap > 0) {
			return explicitCompletionCap
		}
		if (this.useGemma4KesslerProtocol()) {
			return 1024
		}
		const raw = this.options.lmStudioMaxTokens
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed
		}
		return undefined
	}

	@withRetry({ retryAllErrors: true })
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		if (this.useGemma4KesslerProtocol()) {
			yield* this.createGemma4KesslerMessage(client, systemPrompt, messages, tools)
			return
		}

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		try {
			const stream = await client.chat.completions.create({
				model: this.getModel().id,
				messages: openAiMessages,
				stream: true,
				stream_options: { include_usage: true },
				max_completion_tokens: this.completionCap(),
				...getOpenAIToolParams(tools),
			})

			const toolCallProcessor = new ToolCallProcessor()

			for await (const chunk of stream) {
				const choice = chunk.choices?.[0]
				const delta = choice?.delta
				if (delta?.content) {
					yield {
						type: "text",
						text: delta.content,
					}
				}
				if (delta && "reasoning_content" in delta && delta.reasoning_content) {
					yield {
						type: "reasoning",
						reasoning: (delta.reasoning_content as string | undefined) || "",
					}
				}

				if (delta?.tool_calls) {
					yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
				}

				if (chunk.usage) {
					const localRuntime = (chunk as unknown as { p2ai_runtime?: Record<string, unknown> }).p2ai_runtime
					yield {
						type: "usage",
						inputTokens: chunk.usage.prompt_tokens || 0,
						outputTokens: chunk.usage.completion_tokens || 0,
						cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
						localRuntime,
					}
				}
			}
		} catch (error) {
			// LM Studio doesn't return an error code/body for now
			throw new Error(
				`LM Studio request failed: ${error instanceof Error ? error.message : String(error)}. Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Cline's prompts. Alternatively, try enabling Compact Prompt in your settings when working with a limited context window.`,
			)
		}
	}

	private async *createGemma4KesslerMessage(
		client: OpenAI,
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: OpenAITool[],
	): ApiStream {
		const prompt = buildGemma4KesslerPrompt({
			systemPrompt,
			messages,
			tools,
			enableThinking: process.env.P2AI_C2AI_GEMMA4_THINKING !== "false",
		})
		const maxTokens = this.completionCap()
		recordP2AiDiagnosticEvent({
			event: "gemma4_kessler_prompt_created",
			message: "LM Studio Gemma4/Kessler prompt created",
			payload: {
				model: this.getModel().id,
				prompt_chars: prompt.length,
				message_count: messages.length,
				tool_count: tools?.length || 0,
				max_tokens: maxTokens,
				prompt_preview: prompt.slice(0, 4000),
			},
		})

		try {
			const stream = await client.completions.create({
				model: this.getModel().id,
				prompt,
				stream: true,
				max_tokens: maxTokens,
				temperature: 0,
				stop: ["<turn|>"],
			})
			const adapter = new Gemma4KesslerStreamAdapter()

			for await (const chunk of stream) {
				const text = chunk.choices?.[0]?.text || ""
				if (text) {
					const events = adapter.push(text)
					for (const event of events) {
						if (event.type === "tool_calls") {
							recordP2AiDiagnosticEvent({
								event: "gemma4_kessler_tool_call_emitted",
								message: `Gemma4 emitted tool call ${event.tool_call.function.name || "unknown"}`,
								payload: {
									tool_name: event.tool_call.function.name,
									arguments: event.tool_call.function.arguments,
								},
							})
						}
						yield event
					}
				}
				if (chunk.usage) {
					const localRuntime = (chunk as unknown as { p2ai_runtime?: Record<string, unknown> }).p2ai_runtime
					yield {
						type: "usage",
						inputTokens: chunk.usage.prompt_tokens || 0,
						outputTokens: chunk.usage.completion_tokens || 0,
						cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
						localRuntime,
					}
				}
			}

			for (const event of adapter.finish()) {
				if (event.type === "tool_calls") {
					recordP2AiDiagnosticEvent({
						event: "gemma4_kessler_tool_call_emitted",
						message: `Gemma4 emitted tool call ${event.tool_call.function.name || "unknown"}`,
						payload: {
							tool_name: event.tool_call.function.name,
							arguments: event.tool_call.function.arguments,
						},
					})
				}
				yield event
			}

			recordP2AiDiagnosticEvent({
				event: "gemma4_kessler_response_finished",
				message: "LM Studio Gemma4/Kessler response finished",
				payload: {
					raw_chars: adapter.getRawText().length,
					raw_preview: adapter.getRawText().slice(0, 4000),
				},
			})
		} catch (error) {
			recordP2AiDiagnosticEvent({
				event: "gemma4_kessler_request_failed",
				message: "LM Studio Gemma4/Kessler request failed",
				payload: {
					error: error instanceof Error ? error.message : String(error),
				},
			})
			throw new Error(`LM Studio Gemma4/Kessler request failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const info = { ...openAiModelInfoSaneDefaults }
		const maxTokens = Number(this.options.lmStudioMaxTokens)
		if (!Number.isNaN(maxTokens)) {
			info.contextWindow = maxTokens
		}
		return {
			id: this.options.lmStudioModelId || "",
			info,
		}
	}
}
