import { expect } from "chai"

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
