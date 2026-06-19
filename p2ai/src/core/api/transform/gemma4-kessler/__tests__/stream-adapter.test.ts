import { expect } from "chai"

import type { ClineStorageMessage } from "@/shared/messages/content"
import { buildGemma4KesslerDeterministicAttemptCompletion } from "../prompt"
import { Gemma4KesslerStreamAdapter } from "../stream-adapter"

describe("Gemma4KesslerStreamAdapter", () => {
	it("streams reasoning deltas before the thought channel closes", () => {
		const adapter = new Gemma4KesslerStreamAdapter()

		expect(adapter.push("<|channel>")).to.deep.equal([])
		expect(adapter.push("thought\nThe user")).to.deep.equal([{ type: "reasoning", reasoning: "The user" }])
		expect(adapter.push(" wants me")).to.deep.equal([{ type: "reasoning", reasoning: " wants me" }])

		const finalChunks = adapter.push('<channel|><|tool_call>call:attempt_completion{"result":"ok"}<tool_call|>')
		expect(finalChunks.some((chunk) => chunk.type === "reasoning")).to.equal(false)

		const toolCallChunk = finalChunks.find((chunk) => chunk.type === "tool_calls")
		expect(toolCallChunk).to.not.equal(undefined)
		if (!toolCallChunk || toolCallChunk.type !== "tool_calls") {
			throw new Error("Expected a tool_calls chunk")
		}
		expect(toolCallChunk.tool_call.function.name).to.equal("attempt_completion")
		expect(adapter.finish()).to.deep.equal([])
	})
})

describe("Gemma4KesslerDeterministicAttemptCompletion", () => {
	it("does not complete read_file summaries that require LLM formatting", () => {
		const messages = singleToolMessages(
			"Gebruik uitsluitend read_file op docs/CLINE_CODEBASE_ANALYSIS/00_INDEX_OVERZICHT.md. Geef daarna precies 3 bullets korte samenvatting en sluit af met attempt_completion.",
			"read_file",
			"Bestandsinhoud met meerdere alinea's die niet deterministisch naar precies drie bullets mag worden samengevat.",
		)

		expect(buildGemma4KesslerDeterministicAttemptCompletion(messages)).to.equal(undefined)
	})

	it("completes supported search_files two-hit summaries", () => {
		const messages = singleToolMessages(
			"Gebruik uitsluitend search_files op docs/CLINE_CODEBASE_ANALYSIS met regex HostBridge. Noem maximaal 2 matches en sluit af met attempt_completion.",
			"search_files",
			[
				"[search_files for 'HostBridge'] Result:",
				"Found 29 results.",
				"docs/CLINE_CODEBASE_ANALYSIS/01_HOSTBRIDGE.md",
				"docs/CLINE_CODEBASE_ANALYSIS/02_RUNTIME.md",
			].join("\n"),
		)

		const completion = buildGemma4KesslerDeterministicAttemptCompletion(messages)
		expect(completion?.result).to.contain("29 resultaten")
		expect(completion?.result).to.contain("01_HOSTBRIDGE.md")
		expect(completion?.result).to.contain("02_RUNTIME.md")
	})

	it("does not complete multi-step execute_command output without a single-tool contract", () => {
		const messages = singleToolMessages(
			"Gebruik write_to_file om test.py te maken. Gebruik daarna execute_command met command python test.py en requires_approval=false. Sluit af met attempt_completion met de exacte uitvoer 247.",
			"execute_command",
			"[execute_command for 'python test.py'] Result:\n247",
		)

		expect(buildGemma4KesslerDeterministicAttemptCompletion(messages)).to.equal(undefined)
	})
})

function singleToolMessages(instruction: string, toolName: string, toolResult: string): ClineStorageMessage[] {
	return [
		{
			role: "user",
			content: [{ type: "text", text: instruction }],
		},
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "toolu_1", name: toolName, input: {} }],
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1", content: toolResult }],
		},
	]
}
