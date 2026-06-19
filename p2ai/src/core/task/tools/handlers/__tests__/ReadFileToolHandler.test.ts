import { expect } from "chai"
import fs from "fs/promises"
import os from "os"
import path from "path"

import { ReadFileToolHandler } from "../ReadFileToolHandler"

describe("ReadFileToolHandler missing path recovery", () => {
	let tempDir: string | undefined

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true })
			tempDir = undefined
		}
	})

	it("auto-reads a unique same-directory filename typo", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "p247-read-file-recovery-"))
		const docsDir = path.join(tempDir, "docs", "CLINE_CODEBASE_ANALYSIS")
		await fs.mkdir(docsDir, { recursive: true })
		await fs.writeFile(path.join(docsDir, "00_INDEX_OVERZICHT.md"), "correct content", "utf8")

		const handler = new ReadFileToolHandler({
			checkClineIgnorePath: () => ({ ok: true }),
		} as any)

		const result = await (handler as any).resolveReadFileMissingPath({
			config: {
				cwd: tempDir,
				isSubagentExecution: true,
				taskState: { userMessageContent: [] },
				services: {
					fileContextTracker: {
						trackFileContext: async () => undefined,
					},
				},
				callbacks: {
					shouldAutoApproveToolWithPath: async () => true,
				},
			},
			requestedRelPath: "docs/CLINE_CODEBASE_ANALYSIS/00_INDEXOVERZIC.md",
			requestedAbsPath: path.join(tempDir, "docs", "CLINE_CODEBASE_ANALYSIS", "00_INDEXOVERZIC.md"),
			displayPath: "docs/CLINE_CODEBASE_ANALYSIS/00_INDEXOVERZIC.md",
			supportsImages: false,
			block: { name: "read_file" },
		})

		expect(result.kind).to.equal("auto_read")
		expect(result.content).to.equal("correct content")
	})
})
