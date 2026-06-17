import { String as ProtoString, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeTextArea } from "@vscode/webview-ui-toolkit/react"
import { memo, useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { ModelsServiceClient } from "@/services/grpc-client"

type FeedbackAction = "saved" | "skipped" | "do_not_remember"
type FeedbackStatus = "waiting" | "submitting" | "saved" | "queued" | "applied" | "no_op" | "degraded" | "failed"

interface P2AiRunFeedbackTrayProps {
	answerMessageId?: string
	answerMessageIdSource?: string
	answerText: string
	answerTextSha256?: string
	completionResultTs: number
	runtimeMetadata?: Record<string, unknown>
}

const stringValue = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const boolValue = (value: unknown): boolean => value === true || value === "true"

const numberValue = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

export const p2aiTextSha256 = async (text: string): Promise<string | undefined> => {
	if (!globalThis.crypto?.subtle) {
		return undefined
	}
	const bytes = new TextEncoder().encode(text)
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
}

export const p2aiCompletionAnswerMessageId = ({
	runtimeMetadata,
	messageTs,
	text,
	textSha256,
}: {
	runtimeMetadata?: Record<string, unknown>
	messageTs: number
	text: string
	textSha256?: string
}): string | undefined => {
	const taskId =
		stringValue(runtimeMetadata?.source_task_id) ??
		stringValue(runtimeMetadata?.task_id) ??
		stringValue(runtimeMetadata?.source_task_ulid)
	if (!taskId || text.trim().length === 0 || !textSha256) {
		return undefined
	}
	return `p247:${taskId}:completion_result:${messageTs}:${textSha256.slice(0, 12)}`
}

export const P2AiRunFeedbackTray = memo(
	({
		answerMessageId,
		answerMessageIdSource = "composite_task_ts_sha256_text",
		answerText,
		answerTextSha256,
		completionResultTs,
		runtimeMetadata,
	}: P2AiRunFeedbackTrayProps) => {
		const [rating, setRating] = useState(0)
		const [feedbackText, setFeedbackText] = useState("")
		const [feedbackEventId, setFeedbackEventId] = useState<string | undefined>()
		const [status, setStatus] = useState<FeedbackStatus>("waiting")
		const [error, setError] = useState<string | undefined>()
		const [readOnlyHistory, setReadOnlyHistory] = useState(false)

		const identity = useMemo(() => {
			const p247TaskRunId = stringValue(runtimeMetadata?.p247_task_run_id) ?? stringValue(runtimeMetadata?.run_id)
			const llmCallId = stringValue(runtimeMetadata?.llm_call_id) ?? stringValue(runtimeMetadata?.source_call_id)
			const taskId = stringValue(runtimeMetadata?.source_task_id) ?? stringValue(runtimeMetadata?.task_id)
			const taskUlid = stringValue(runtimeMetadata?.source_task_ulid)
			return {
				p247TaskRunId,
				llmCallId,
				taskId,
				taskUlid,
				completionAttemptId: stringValue(runtimeMetadata?.completion_attempt_id),
				runOrdinal: numberValue(runtimeMetadata?.run_ordinal),
				p247TaskRunIdReliable: runtimeMetadata?.p247_task_run_id_reliable !== false,
				feedbackLoopEnabled: boolValue(runtimeMetadata?.feedback_loop_enabled),
				feedbackLoopEffective: boolValue(runtimeMetadata?.feedback_loop_effective),
				disabledReason: stringValue(runtimeMetadata?.feedback_loop_disabled_reason),
			}
		}, [runtimeMetadata])

		useEffect(() => {
			if (!answerMessageId || !identity.p247TaskRunId) {
				return
			}
			let cancelled = false
			const restore = async () => {
				try {
					const response = await ModelsServiceClient.makeUnaryRequest(
						"p2aiGetFeedbackTrayState",
						StringRequest.create({
							value: JSON.stringify({
								run_id: identity.p247TaskRunId,
								answer_message_id: answerMessageId,
							}),
						}),
						StringRequest.toJSON,
						ProtoString.fromJSON,
					)
					if (cancelled) {
						return
					}
					const parsed = JSON.parse(response.value || "{}") as {
						ok?: boolean
						found?: boolean
						read_only?: boolean
						feedback_event_id?: string
						rating?: number
						feedback_text?: string
						status?: FeedbackStatus
						error?: string
					}
					if (parsed.ok === false) {
						setError(parsed.error)
						return
					}
					if (!parsed.found) {
						return
					}
					setReadOnlyHistory(Boolean(parsed.read_only))
					setFeedbackEventId(parsed.feedback_event_id)
					if (typeof parsed.rating === "number") {
						setRating(parsed.rating)
					}
					if (typeof parsed.feedback_text === "string") {
						setFeedbackText(parsed.feedback_text)
					}
					setStatus(parsed.status ?? "saved")
				} catch (err) {
					if (!cancelled) {
						setError(err instanceof Error ? err.message : String(err))
					}
				}
			}
			void restore()
			return () => {
				cancelled = true
			}
		}, [answerMessageId, identity.p247TaskRunId])

		if (!runtimeMetadata || (!identity.feedbackLoopEnabled && !identity.feedbackLoopEffective)) {
			return null
		}

		const submitBlockedReason = !identity.feedbackLoopEffective
			? (identity.disabledReason ?? "feedback_loop_not_effective")
			: !identity.p247TaskRunId
				? "missing_p247_task_run_id"
				: !identity.p247TaskRunIdReliable
					? "unreliable_p247_task_run_id"
					: !answerMessageId
						? "missing_answer_message_id"
						: undefined
		const submitLocked =
			readOnlyHistory ||
			Boolean(feedbackEventId) ||
			status === "submitting" ||
			status === "saved" ||
			status === "queued" ||
			status === "applied" ||
			status === "no_op" ||
			status === "degraded"

		const submit = async (action: FeedbackAction, processNow = false) => {
			if (submitLocked || submitBlockedReason) {
				return
			}
			setStatus("submitting")
			setError(undefined)
			const payload = {
				source_system: "p247_cline",
				source_adapter_version: "p247_cline_local_runtime.v1",
				conversation_id: identity.taskId ?? identity.taskUlid ?? identity.p247TaskRunId,
				run_id: identity.p247TaskRunId,
				p247_task_run_id: identity.p247TaskRunId,
				answer_message_id: answerMessageId,
				answer_message_id_source: answerMessageIdSource,
				source_message_id: answerMessageId,
				source_task_id: identity.taskId,
				source_task_ulid: identity.taskUlid,
				task_id: identity.taskId,
				source_call_id: identity.llmCallId,
				llm_call_id: identity.llmCallId,
				completion_attempt_id: identity.completionAttemptId,
				run_ordinal: identity.runOrdinal,
				completion_result_ts: completionResultTs,
				answer_text_sha256: answerTextSha256,
				rating: action === "saved" ? rating : null,
				feedback_text: feedbackText.trim(),
				feedback_action: action,
				process_now: processNow,
				feedback_loop_scope: "p247_local_runtime",
				runtime_authority: runtimeMetadata,
			}
			try {
				const response = await ModelsServiceClient.makeUnaryRequest(
					"p2aiSubmitRunFeedback",
					StringRequest.create({ value: JSON.stringify(payload) }),
					StringRequest.toJSON,
					ProtoString.fromJSON,
				)
				const parsed = JSON.parse(response.value || "{}") as {
					ok?: boolean
					status?: string
					feedback_event_id?: string
					error?: string
				}
				if (parsed.feedback_event_id) {
					setFeedbackEventId(parsed.feedback_event_id)
				}
				if (parsed.ok === false && parsed.status === "degraded") {
					setStatus("degraded")
					setError(parsed.error)
					return
				}
				if (parsed.ok === false) {
					setStatus("failed")
					setError(parsed.error ?? "feedback_submit_failed")
					return
				}
				setStatus(processNow && (parsed.status === "applied" || parsed.status === "no_op") ? parsed.status : "saved")
			} catch (err) {
				setStatus("failed")
				setError(err instanceof Error ? err.message : String(err))
			}
		}

		return (
			<div
				className="mt-2 rounded-sm border border-description/20 bg-background p-2 text-[12px]"
				data-p2ai-answer-message-id={answerMessageId}
				data-p2ai-feedback-status={status}
				data-testid="p2ai-local-feedback-tray">
				<div className="mb-2 flex items-center justify-between gap-2">
					<div className="font-medium text-foreground">P2AI local feedback</div>
					<div className="truncate text-[11px] text-description">
						{identity.p247TaskRunId ? `run ${identity.p247TaskRunId}` : "runtime identity pending"}
					</div>
				</div>
				{submitBlockedReason ? (
					<div className="mb-2 rounded-sm border border-warning/40 bg-warning/10 px-2 py-1 text-warning">
						Feedback disabled: {submitBlockedReason}
					</div>
				) : null}
				{readOnlyHistory ? (
					<div className="mb-2 rounded-sm border border-description/30 bg-description/10 px-2 py-1 text-description">
						History feedback restored read-only
					</div>
				) : null}
				<div className="mb-2 flex items-center gap-1">
					{[-2, -1, 0, 1, 2].map((value) => (
						<button
							aria-label={`Set feedback rating ${value}`}
							className={cn(
								"h-6 min-w-6 rounded-sm border border-description/30 bg-transparent px-2 text-[11px]",
								rating === value && "border-success bg-success/20 text-success",
							)}
							data-testid={`p2ai-feedback-rating-${value}`}
							disabled={submitLocked || Boolean(submitBlockedReason)}
							key={value}
							onClick={() => setRating(value)}
							type="button">
							{value}
						</button>
					))}
				</div>
				<VSCodeTextArea
					className="w-full"
					data-testid="p2ai-feedback-text"
					disabled={submitLocked || Boolean(submitBlockedReason)}
					onInput={(event) => setFeedbackText((event.target as HTMLTextAreaElement).value)}
					placeholder="Feedback voor latere lokale runs"
					resize="vertical"
					rows={3}
					value={feedbackText}
				/>
				<div className="mt-2 flex flex-wrap gap-2">
					<VSCodeButton
						data-testid="p2ai-feedback-save"
						disabled={submitLocked || Boolean(submitBlockedReason)}
						onClick={() => submit("saved", false)}>
						Save
					</VSCodeButton>
					<VSCodeButton
						appearance="secondary"
						data-testid="p2ai-feedback-process-now"
						disabled={submitLocked || Boolean(submitBlockedReason)}
						onClick={() => submit("saved", true)}>
						Process now
					</VSCodeButton>
					<VSCodeButton
						appearance="secondary"
						data-testid="p2ai-feedback-skip"
						disabled={submitLocked || Boolean(submitBlockedReason)}
						onClick={() => submit("skipped", false)}>
						Skip
					</VSCodeButton>
					<VSCodeButton
						appearance="secondary"
						data-testid="p2ai-feedback-do-not-remember"
						disabled={submitLocked || Boolean(submitBlockedReason)}
						onClick={() => submit("do_not_remember", false)}>
						Do not remember
					</VSCodeButton>
				</div>
				<div className="mt-2 text-[11px] text-description">
					{feedbackEventId ? `Feedback saved: ${feedbackEventId}` : `Status: ${status}`}
					{error ? <span className="ml-2 text-error">{error}</span> : null}
				</div>
			</div>
		)
	},
)

P2AiRunFeedbackTray.displayName = "P2AiRunFeedbackTray"
