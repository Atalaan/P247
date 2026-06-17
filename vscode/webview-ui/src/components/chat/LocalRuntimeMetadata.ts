import type { ClineApiReqInfo, ClineMessage } from "@shared/ExtensionMessage"

const numberValue = (value: unknown): number | undefined => {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const stringValue = (value: unknown): string | undefined => {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

const formatTimestamp = (ms: number): string => {
	const d = new Date(ms)
	const pad = (n: number) => n.toString().padStart(2, "0")
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
		d.getMinutes(),
	)}:${pad(d.getSeconds())}`
}

const formatSeconds = (seconds: number): string => `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`

export const formatLocalRuntimeMetadata = (metadata: Record<string, unknown> | undefined): string | null => {
	if (!metadata) {
		return null
	}
	const createdAtMs = numberValue(metadata.created_at_ms)
	const wallclockMs = numberValue(metadata.sidecar_llm_wallclock_ms)
	const runtime = stringValue(metadata.runtime) ?? "local"
	const backend = stringValue(metadata.backend)
	const model = stringValue(metadata.model_id)
	const gpuLayers = numberValue(metadata.gpu_layers_effective)
	const contextWindow = numberValue(metadata.context_window_effective)
	const ttft = numberValue(metadata.native_time_to_first_token_sec)
	const tps = numberValue(metadata.native_visible_tokens_per_second) ?? numberValue(metadata.native_tokens_per_second)
	const inputTokens = numberValue(metadata.prompt_tokens)
	const outputTokens = numberValue(metadata.completion_tokens)
	const reasoningChars = numberValue(metadata.reasoning_chars) ?? 0
	const replyChars = numberValue(metadata.output_chars)
	const finish = stringValue(metadata.native_stop_reason)

	const parts = [
		createdAtMs ? formatTimestamp(createdAtMs) : undefined,
		wallclockMs != null ? formatSeconds(wallclockMs / 1000) : undefined,
		backend ? `local ${runtime}/${backend}` : `local ${runtime}`,
		model,
		gpuLayers != null ? `gpu ${gpuLayers}` : undefined,
		contextWindow != null ? `ctx ${contextWindow}` : undefined,
		ttft != null ? `ttft ${formatSeconds(ttft)}` : undefined,
		tps != null ? `gen ${tps.toFixed(1)} tok/s` : undefined,
		inputTokens != null ? `input ${inputTokens} tok` : undefined,
		outputTokens != null ? `output ${outputTokens} tok` : undefined,
		`reasoning ${reasoningChars} chars`,
		replyChars != null ? `reply ${replyChars} chars` : undefined,
		finish ? `finish ${finish}` : undefined,
	].filter(Boolean)

	return parts.join(" - ")
}

const metadataFromApiReq = (message: ClineMessage): string | null => {
	if (message.say !== "api_req_started" || !message.text) {
		return null
	}
	try {
		const info = JSON.parse(message.text) as ClineApiReqInfo
		return formatLocalRuntimeMetadata(info.localRuntime)
	} catch {
		return null
	}
}

export const findLocalRuntimeMetadataForMessage = (
	message: ClineMessage,
	messages: ClineMessage[],
): string | null => {
	const direct = metadataFromApiReq(message)
	if (direct) {
		return direct
	}

	const currentIndex = messages.findIndex(
		(candidate) =>
			candidate.ts === message.ts &&
			candidate.type === message.type &&
			candidate.say === message.say &&
			candidate.ask === message.ask,
	)
	const startIndex = currentIndex >= 0 ? currentIndex : messages.length - 1

	for (let i = startIndex; i >= 0; i--) {
		const summary = metadataFromApiReq(messages[i])
		if (summary) {
			return summary
		}
	}

	return null
}
