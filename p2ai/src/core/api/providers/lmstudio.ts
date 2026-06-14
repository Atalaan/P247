import { type ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import crypto from "crypto"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import {
	recordJsonArtifact,
	recordLlmParserEvent,
	recordLlmRequestArtifact,
	recordLlmStreamChunk,
	recordLlmUsageArtifact,
	recordP2AiDiagnosticEvent,
	recordTextArtifact,
} from "@core/observability/p2ai-artifacts"
import type { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { buildGemma4KesslerPrompt, buildGemma4KesslerRepairPrompt } from "../transform/gemma4-kessler/prompt"
import { Gemma4KesslerStreamAdapter } from "../transform/gemma4-kessler/stream-adapter"
import { buildGptOssHarmonyPrompt, buildGptOssHarmonyRepairPrompt } from "../transform/gpt-oss-harmony/prompt"
import { GptOssHarmonyStreamAdapter } from "../transform/gpt-oss-harmony/stream-adapter"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type { ApiStream, ApiStreamChunk, ApiStreamToolCallsChunk } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

type ToolProtocolProfile = "openai-native" | "gemma4-kessler" | "gpt-oss-harmony"

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
				const configuredBaseUrl = this.options.lmStudioBaseUrl || "http://localhost:1234"
				const apiStyle = process.env.P2AI_CLINE_LMSTUDIO_API_STYLE
				const baseURL =
					apiStyle === "llamacpp_v1" || configuredBaseUrl.replace(/\/+$/, "").endsWith("/v1")
						? configuredBaseUrl.replace(/\/+$/, "")
						: new URL("api/v0", configuredBaseUrl).toString()
				this.client = createOpenAIClient({
					// Docs on the new v0 api endpoint: https://lmstudio.ai/docs/app/api/endpoints/rest
					baseURL,
					apiKey: "noop",
				})
			} catch (error) {
				throw new Error(`Error creating LM Studio client: ${error.message}`)
			}
		}
		return this.client
	}

	private toolProtocolProfile(): ToolProtocolProfile {
		const profile = process.env.P2AI_C2AI_TOOL_PROTOCOL_PROFILE
		if (profile === "gemma4-kessler" || profile === "gpt-oss-harmony" || profile === "openai-native") {
			return profile
		}
		if (process.env.P2AI_C2AI_GEMMA4_PROTOCOL === "kessler") {
			return "gemma4-kessler"
		}
		return "openai-native"
	}

	private useGemma4KesslerProtocol(): boolean {
		return this.toolProtocolProfile() === "gemma4-kessler"
	}

	private useGptOssHarmonyProtocol(): boolean {
		return this.toolProtocolProfile() === "gpt-oss-harmony"
	}

	private completionCap(): number | undefined {
		const explicitCompletionCap = Number(process.env.P2AI_C2AI_MAX_COMPLETION_TOKENS)
		if (Number.isFinite(explicitCompletionCap) && explicitCompletionCap > 0) {
			return explicitCompletionCap
		}
		if (this.useGemma4KesslerProtocol() || this.useGptOssHarmonyProtocol()) {
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
		if (this.useGptOssHarmonyProtocol()) {
			yield* this.createGptOssHarmonyMessage(client, systemPrompt, messages, tools)
			return
		}

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]
		const requestConfig = {
			base_url: this.options.lmStudioBaseUrl || "http://localhost:1234",
			model: this.getModel().id,
			stream: true,
			stream_options: { include_usage: true },
			max_completion_tokens: this.completionCap(),
			tool_protocol_profile: this.toolProtocolProfile(),
			tool_count: tools?.length || 0,
		}
		recordLlmRequestArtifact({
			stack: "lmstudio_vscode_c2ai",
			route: "openai_chat_native",
			provider: "lmstudio",
			modelId: this.getModel().id,
			messages: openAiMessages,
			tools,
			request: requestConfig,
		})
		recordJsonArtifact("lmstudio_provider_request.json", requestConfig)
		recordJsonArtifact("lmstudio_provider_messages.json", openAiMessages)
		recordJsonArtifact("lmstudio_provider_tools.json", tools || [])

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
			let chunkIndex = 0

			for await (const chunk of stream) {
				chunkIndex += 1
				const choice = chunk.choices?.[0]
				const delta = choice?.delta
				recordLlmStreamChunk({
					stack: "lmstudio_vscode_c2ai",
					route: "openai_chat_native",
					provider: "lmstudio",
					modelId: this.getModel().id,
					chunkIndex,
					text: delta?.content || undefined,
					chunk,
				})
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
					recordLlmParserEvent({
						stack: "lmstudio_vscode_c2ai",
						route: "openai_chat_native",
						provider: "lmstudio",
						modelId: this.getModel().id,
						event: "openai_tool_call_delta",
						payload: { tool_calls: delta.tool_calls },
					})
					yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
				}

				if (chunk.usage) {
					const localRuntime = (chunk as unknown as { p2ai_runtime?: Record<string, unknown> }).p2ai_runtime
					recordLlmUsageArtifact({
						stack: "lmstudio_vscode_c2ai",
						route: "openai_chat_native",
						provider: "lmstudio",
						modelId: this.getModel().id,
						usage: chunk.usage as unknown as Record<string, unknown>,
						tokenizerSource: "lmstudio_reported",
					})
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
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]
		const requestConfig = {
			base_url: this.options.lmStudioBaseUrl || "http://localhost:1234",
			model: this.getModel().id,
			stream: true,
			max_tokens: maxTokens,
			temperature: 0,
			stop: ["<turn|>"],
			tool_protocol_profile: "gemma4-kessler",
			tool_count: tools?.length || 0,
		}
		recordLlmRequestArtifact({
			stack: "lmstudio_vscode_c2ai",
			route: "gemma4_kessler_completion",
			provider: "lmstudio",
			modelId: this.getModel().id,
			messages: openAiMessages,
			tools,
			renderedPrompt: prompt,
			request: requestConfig,
			extra: {
				raw_messages_count: messages.length,
				system_prompt_chars: systemPrompt.length,
			},
		})
		recordJsonArtifact("lmstudio_provider_request.json", requestConfig)
		recordJsonArtifact("lmstudio_provider_messages.json", openAiMessages)
		recordJsonArtifact("lmstudio_provider_tools.json", tools || [])
		recordTextArtifact("lmstudio_rendered_prompt.txt", prompt)
		recordTextArtifact("lmstudio_rendered_prompt.sha256", `${crypto.createHash("sha256").update(prompt).digest("hex")}\n`)
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
			const adapter = yield* this.streamGemma4KesslerPrompt(client, prompt, maxTokens, "primary")

			recordP2AiDiagnosticEvent({
				event: "gemma4_kessler_response_finished",
				message: "LM Studio Gemma4/Kessler response finished",
				payload: {
					attempt: "primary",
					raw_chars: adapter.getRawText().length,
					raw_preview: adapter.getRawText().slice(0, 4000),
				},
			})

			if (!adapter.hasEmittedToolCall()) {
				const finalText = adapter.getFinalText()
				recordP2AiDiagnosticEvent({
					event: "gemma4_kessler_no_tool_call",
					message: "Gemma4/Kessler response did not contain a valid tool call",
					payload: {
						final_text_preview: finalText.slice(0, 1200),
					},
				})

				const repairPrompt = buildGemma4KesslerRepairPrompt({
					systemPrompt,
					messages,
					tools,
					enableThinking: false,
					invalidResponse: adapter.getRawText(),
				})
				recordTextArtifact("kessler_repair_prompt_rendered.txt", repairPrompt)
				recordP2AiDiagnosticEvent({
					event: "gemma4_kessler_repair_prompt_created",
					message: "LM Studio Gemma4/Kessler repair prompt created",
					payload: {
						model: this.getModel().id,
						prompt_chars: repairPrompt.length,
						prompt_preview: repairPrompt.slice(0, 4000),
					},
				})
				const repairAdapter = yield* this.streamGemma4KesslerPrompt(
					client,
					repairPrompt,
					Math.min(maxTokens || 512, 512),
					"repair",
				)
				recordP2AiDiagnosticEvent({
					event: "gemma4_kessler_response_finished",
					message: "LM Studio Gemma4/Kessler response finished",
					payload: {
						attempt: "repair",
						raw_chars: repairAdapter.getRawText().length,
						raw_preview: repairAdapter.getRawText().slice(0, 4000),
					},
				})
				if (!repairAdapter.hasEmittedToolCall()) {
					throw new Error(
						`Gemma4/Kessler response did not contain a valid tool call. Raw response: ${adapter
							.getRawText()
							.slice(0, 500)}`,
					)
				}
			}
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

	private async *streamGemma4KesslerPrompt(
		client: OpenAI,
		prompt: string,
		maxTokens: number | undefined,
		attempt: "primary" | "repair",
	): AsyncGenerator<ApiStreamChunk, Gemma4KesslerStreamAdapter> {
		const stream = await client.completions.create({
			model: this.getModel().id,
			prompt,
			stream: true,
			max_tokens: maxTokens,
			temperature: 0,
			stop: ["<turn|>"],
		})
		const adapter = new Gemma4KesslerStreamAdapter()
		let chunkIndex = 0

		for await (const chunk of stream) {
			chunkIndex += 1
			const text = chunk.choices?.[0]?.text || ""
			recordLlmStreamChunk({
				stack: "lmstudio_vscode_c2ai",
				route: "gemma4_kessler_completion",
				provider: "lmstudio",
				modelId: this.getModel().id,
				attempt,
				chunkIndex,
				text,
				chunk,
			})
			if (text) {
				const events = adapter.push(text)
				for (const event of events) {
					if (event.type === "tool_calls") {
						this.recordGemma4ToolCall(event, attempt)
					} else {
						recordLlmParserEvent({
							stack: "lmstudio_vscode_c2ai",
							route: "gemma4_kessler_completion",
							provider: "lmstudio",
							modelId: this.getModel().id,
							event: `gemma4_kessler_${event.type}`,
							attempt,
						})
					}
					yield event
				}
			}
			if (chunk.usage) {
				const localRuntime = (chunk as unknown as { p2ai_runtime?: Record<string, unknown> }).p2ai_runtime
				recordLlmUsageArtifact({
					stack: "lmstudio_vscode_c2ai",
					route: "gemma4_kessler_completion",
					provider: "lmstudio",
					modelId: this.getModel().id,
					usage: chunk.usage as unknown as Record<string, unknown>,
					renderedPrompt: prompt,
					outputText: adapter.getRawText(),
					tokenizerSource: "lmstudio_reported",
				})
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
				this.recordGemma4ToolCall(event, attempt)
			} else {
				recordLlmParserEvent({
					stack: "lmstudio_vscode_c2ai",
					route: "gemma4_kessler_completion",
					provider: "lmstudio",
					modelId: this.getModel().id,
					event: `gemma4_kessler_${event.type}`,
					attempt,
				})
			}
			yield event
		}
		recordTextArtifact(`lmstudio_${attempt}_output_text.txt`, adapter.getRawText())
		recordTextArtifact("llm_output_text.txt", adapter.getRawText())
		return adapter
	}

	private recordGemma4ToolCall(event: ApiStreamToolCallsChunk, attempt: "primary" | "repair") {
		const isPartial = event.partial === true
		recordLlmParserEvent({
			stack: "lmstudio_vscode_c2ai",
			route: "gemma4_kessler_completion",
			provider: "lmstudio",
			modelId: this.getModel().id,
			event: isPartial ? "gemma4_kessler_partial_tool_call_emitted" : "gemma4_kessler_tool_call_emitted",
			attempt,
			payload: {
				partial: isPartial,
				tool_name: event.tool_call.function.name,
				arguments: event.tool_call.function.arguments,
			},
		})
		recordP2AiDiagnosticEvent({
			event: isPartial ? "gemma4_kessler_partial_tool_call_emitted" : "gemma4_kessler_tool_call_emitted",
			message: `Gemma4 emitted ${isPartial ? "partial " : ""}tool call ${event.tool_call.function.name || "unknown"}`,
			payload: {
				attempt,
				partial: isPartial,
				tool_name: event.tool_call.function.name,
				arguments: event.tool_call.function.arguments,
			},
		})
	}

	private async *createGptOssHarmonyMessage(
		client: OpenAI,
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: OpenAITool[],
	): ApiStream {
		const prompt = buildGptOssHarmonyPrompt({
			systemPrompt,
			messages,
			tools,
			reasoning: "medium",
		})
		const maxTokens = this.completionCap()
		recordP2AiDiagnosticEvent({
			event: "gptoss_harmony_prompt_created",
			message: "LM Studio GPT-OSS/Harmony prompt created",
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
			const adapter = yield* this.streamGptOssHarmonyPrompt(client, prompt, maxTokens, "primary")
			recordP2AiDiagnosticEvent({
				event: "gptoss_harmony_response_finished",
				message: "LM Studio GPT-OSS/Harmony response finished",
				payload: {
					attempt: "primary",
					raw_chars: adapter.getRawText().length,
					raw_preview: adapter.getRawText().slice(0, 4000),
					final_text_preview: adapter.getFinalText().slice(0, 1200),
				},
			})

			if (!adapter.hasEmittedToolCall()) {
				recordP2AiDiagnosticEvent({
					event: "gptoss_harmony_no_tool_call",
					message: "GPT-OSS/Harmony response did not contain a valid function call",
					payload: {
						final_text_preview: adapter.getFinalText().slice(0, 1200),
					},
				})

				const repairPrompt = buildGptOssHarmonyRepairPrompt({
					systemPrompt,
					messages,
					tools,
					reasoning: "low",
					invalidResponse: adapter.getRawText(),
				})
				recordP2AiDiagnosticEvent({
					event: "gptoss_harmony_repair_prompt_created",
					message: "LM Studio GPT-OSS/Harmony repair prompt created",
					payload: {
						model: this.getModel().id,
						prompt_chars: repairPrompt.length,
						prompt_preview: repairPrompt.slice(0, 4000),
					},
				})
				const repairAdapter = yield* this.streamGptOssHarmonyPrompt(
					client,
					repairPrompt,
					Math.min(maxTokens || 512, 512),
					"repair",
				)
				recordP2AiDiagnosticEvent({
					event: "gptoss_harmony_response_finished",
					message: "LM Studio GPT-OSS/Harmony response finished",
					payload: {
						attempt: "repair",
						raw_chars: repairAdapter.getRawText().length,
						raw_preview: repairAdapter.getRawText().slice(0, 4000),
					},
				})
				if (!repairAdapter.hasEmittedToolCall()) {
					throw new Error(
						`GPT-OSS/Harmony response did not contain a valid function call. Raw response: ${adapter
							.getRawText()
							.slice(0, 500)}`,
					)
				}
			}
		} catch (error) {
			recordP2AiDiagnosticEvent({
				event: "gptoss_harmony_request_failed",
				message: "LM Studio GPT-OSS/Harmony request failed",
				payload: {
					error: error instanceof Error ? error.message : String(error),
				},
			})
			throw new Error(`LM Studio GPT-OSS/Harmony request failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private async *streamGptOssHarmonyPrompt(
		client: OpenAI,
		prompt: string,
		maxTokens: number | undefined,
		attempt: "primary" | "repair",
	): AsyncGenerator<ApiStreamChunk, GptOssHarmonyStreamAdapter> {
		const stream = await client.completions.create({
			model: this.getModel().id,
			prompt,
			stream: true,
			max_tokens: maxTokens,
			temperature: 0,
			stop: ["<|return|>"],
		})
		const adapter = new GptOssHarmonyStreamAdapter()

		for await (const chunk of stream) {
			const text = chunk.choices?.[0]?.text || ""
			if (text) {
				const events = adapter.push(text)
				for (const event of events) {
					if (event.type === "tool_calls") {
						this.recordGptOssHarmonyToolCall(event, attempt)
					}
					yield event
				}
			}
			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
					cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
				}
			}
		}

		for (const event of adapter.finish()) {
			if (event.type === "tool_calls") {
				this.recordGptOssHarmonyToolCall(event, attempt)
			}
			yield event
		}
		return adapter
	}

	private recordGptOssHarmonyToolCall(event: ApiStreamToolCallsChunk, attempt: "primary" | "repair") {
		recordP2AiDiagnosticEvent({
			event: "gptoss_harmony_tool_call_emitted",
			message: `GPT-OSS emitted Harmony function call ${event.tool_call.function.name || "unknown"}`,
			payload: {
				attempt,
				tool_name: event.tool_call.function.name,
				arguments: event.tool_call.function.arguments,
			},
		})
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
