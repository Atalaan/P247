import { Anthropic } from "@anthropic-ai/sdk"
import fs from "fs/promises"
import * as path from "path"
import { extractImageContent } from "./extract-images"
import { callTextExtractionFunctions } from "./extract-text"

export type FileContentResult = {
	text: string
	imageBlock?: Anthropic.ImageBlockParam
}

export class FileMissingPathError extends Error {
	constructor(
		readonly absolutePath: string,
		readonly code: "ENOENT" | "ENOTDIR",
	) {
		super(`File not found: ${absolutePath}`)
		this.name = "FileMissingPathError"
	}
}

export function isFileMissingPathError(error: unknown): error is FileMissingPathError {
	return error instanceof FileMissingPathError
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Extract content from a file, handling both text and images
 * Extra logic for handling images based on whether the model supports images
 */
export async function extractFileContent(absolutePath: string, modelSupportsImages: boolean): Promise<FileContentResult> {
	// Check if file exists first
	try {
		await fs.access(absolutePath)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT" || code === "ENOTDIR") {
			throw new FileMissingPathError(absolutePath, code)
		}
		throw error
	}

	const fileExtension = path.extname(absolutePath).toLowerCase()
	const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"]
	const isImage = imageExtensions.includes(fileExtension)

	if (isImage && modelSupportsImages) {
		const imageResult = await extractImageContent(absolutePath)

		if (imageResult.success) {
			return {
				text: "Successfully read image",
				imageBlock: imageResult.imageBlock,
			}
		} else {
			throw new Error(imageResult.error)
		}
	} else if (isImage && !modelSupportsImages) {
		throw new Error(`Current model does not support image input`)
	} else {
		// Handle text files using existing extraction functions
		try {
			const textContent = await callTextExtractionFunctions(absolutePath)
			return {
				text: textContent,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			throw new Error(`Error reading file: ${errorMessage}`)
		}
	}
}
