import { ClineIgnoreController } from "@core/ignore/ClineIgnoreController"
import { listFiles } from "@services/glob/list-files"
import { fileExistsAtPath } from "@utils/fs"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { LanguageParser, loadRequiredLanguageParsers } from "./languageParser"

const fallbackDefinitionExtensions = new Set([".dart"])

// TODO: implement caching behavior to avoid having to keep analyzing project for new tasks.
export async function parseSourceCodeForDefinitionsTopLevel(
	dirPath: string,
	clineIgnoreController?: ClineIgnoreController,
): Promise<string> {
	// check if the path exists
	const resolvedPath = path.resolve(dirPath)
	const pathExists = await fileExistsAtPath(resolvedPath)
	if (!pathExists) {
		return "This path does not exist or you do not have permission to access it."
	}

	const pathStats = await fs.stat(resolvedPath)
	const basePath = pathStats.isFile() ? path.dirname(resolvedPath) : resolvedPath
	const allFiles = pathStats.isFile() ? [resolvedPath] : (await listFiles(resolvedPath, false, 200))[0]

	let result = ""

	// Separate files to parse and remaining files
	const { filesToParse, remainingFiles } = separateFiles(allFiles)

	const filesRequiringLanguageParsers = filesToParse.filter(
		(file) => !fallbackDefinitionExtensions.has(path.extname(file).toLowerCase()),
	)
	const languageParsers = await loadRequiredLanguageParsers(filesRequiringLanguageParsers)

	// Parse specific files we have language parsers for
	// const filesWithoutDefinitions: string[] = []

	// Filter filepaths for access if controller is provided
	const allowedFilesToParse = clineIgnoreController ? clineIgnoreController.filterPaths(filesToParse) : filesToParse

	for (const filePath of allowedFilesToParse) {
		const definitions = await parseFile(filePath, languageParsers, clineIgnoreController)
		if (definitions) {
			result += `${path.relative(basePath, filePath).toPosix()}\n${definitions}\n`
		}
		// else {
		// 	filesWithoutDefinitions.push(file)
		// }
	}

	// List remaining files' paths
	// let didFindUnparsedFiles = false
	// filesWithoutDefinitions
	// 	.concat(remainingFiles)
	// 	.sort()
	// 	.forEach((file) => {
	// 		if (!didFindUnparsedFiles) {
	// 			result += "# Unparsed Files\n\n"
	// 			didFindUnparsedFiles = true
	// 		}
	// 		result += `${path.relative(dirPath, file)}\n`
	// 	})

	return result ? result : "No source code definitions found."
}

function separateFiles(allFiles: string[]): {
	filesToParse: string[]
	remainingFiles: string[]
} {
	const extensions = [
		"js",
		"jsx",
		"ts",
		"tsx",
		"py",
		// Rust
		"rs",
		"go",
		// C
		"c",
		"h",
		// C++
		"cpp",
		"hpp",
		// C#
		"cs",
		// Ruby
		"rb",
		"java",
		"php",
		"swift",
		// Kotlin
		"kt",
		"dart",
	].map((e) => `.${e}`)
	const filesToParse = allFiles.filter((file) => extensions.includes(path.extname(file))).slice(0, 50) // 50 files max
	const remainingFiles = allFiles.filter((file) => !filesToParse.includes(file))
	return { filesToParse, remainingFiles }
}

/*
Parsing files using tree-sitter

1. Parse the file content into an AST (Abstract Syntax Tree) using the appropriate language grammar (set of rules that define how the components of a language like keywords, expressions, and statements can be combined to create valid programs).
2. Create a query using a language-specific query string, and run it against the AST's root node to capture specific syntax elements.
    - We use tag queries to identify named entities in a program, and then use a syntax capture to label the entity and its name. A notable example of this is GitHub's search-based code navigation.
	- Our custom tag queries are based on tree-sitter's default tag queries, but modified to only capture definitions.
3. Sort the captures by their position in the file, output the name of the definition, and format by i.e. adding "|----\n" for gaps between captured sections.

This approach allows us to focus on the most relevant parts of the code (defined by our language-specific queries) and provides a concise yet informative view of the file's structure and key elements.

- https://github.com/tree-sitter/node-tree-sitter/blob/master/test/query_test.js
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/test/query-test.js
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/test/helper.js
- https://tree-sitter.github.io/tree-sitter/code-navigation-systems
*/
async function parseFile(
	filePath: string,
	languageParsers: LanguageParser,
	clineIgnoreController?: ClineIgnoreController,
): Promise<string | null> {
	if (clineIgnoreController && !clineIgnoreController.validateAccess(filePath)) {
		return null
	}
	const fileContent = await fs.readFile(filePath, "utf8")
	const ext = path.extname(filePath).toLowerCase().slice(1)

	if (ext === "dart") {
		return parseDartDefinitions(fileContent)
	}

	const { parser, query } = languageParsers[ext] || {}
	if (!parser || !query) {
		return `Unsupported file type: ${filePath}`
	}

	let formattedOutput = ""

	try {
		// Parse the file content into an Abstract Syntax Tree (AST), a tree-like representation of the code
		const tree = parser.parse(fileContent)
		if (!tree || !tree.rootNode) {
			return null
		}

		// Apply the query to the AST and get the captures
		// Captures are specific parts of the AST that match our query patterns, each capture represents a node in the AST that we're interested in.
		const captures = query.captures(tree.rootNode)

		// Sort captures by their start position
		captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row)

		// Split the file content into individual lines
		const lines = fileContent.split("\n")

		// Keep track of the last line we've processed
		let lastLine = -1

		captures.forEach((capture) => {
			const { node, name } = capture
			// Get the start and end lines of the current AST node
			const startLine = node.startPosition.row
			const endLine = node.endPosition.row
			// Once we've retrieved the nodes we care about through the language query, we filter for lines with definition names only.
			// name.startsWith("name.reference.") > refs can be used for ranking purposes, but we don't need them for the output
			// previously we did `name.startsWith("name.definition.")` but this was too strict and excluded some relevant definitions

			// Add separator if there's a gap between captures
			if (lastLine !== -1 && startLine > lastLine + 1) {
				formattedOutput += "|----\n"
			}
			// Only add the first line of the definition
			// query captures includes the definition name and the definition implementation, but we only want the name (I found discrepancies in the naming structure for various languages, i.e. javascript names would be 'name' and typescript names would be 'name.definition)
			if (name.includes("name") && lines[startLine]) {
				formattedOutput += `│${lines[startLine]}\n`
			}
			// Adds all the captured lines
			// for (let i = startLine; i <= endLine; i++) {
			// 	formattedOutput += `│${lines[i]}\n`
			// }
			//}

			lastLine = endLine
		})
	} catch (error) {
		Logger.log(`Error parsing file: ${error}\n`)
	}

	if (formattedOutput.length > 0) {
		return `|----\n${formattedOutput}|----\n`
	}
	return null
}

function parseDartDefinitions(fileContent: string): string | null {
	const lines = fileContent.split("\n")
	const definitions: string[] = []
	let inMultilineString = false
	const maxDefinitions = 12

	lines.forEach((line) => {
		if (definitions.length >= maxDefinitions) {
			return
		}
		const tripleQuoteCount = (line.match(/(?:r)?(?:'''|""")/g) ?? []).length
		if (inMultilineString) {
			if (tripleQuoteCount % 2 === 1) {
				inMultilineString = false
			}
			return
		}
		if (tripleQuoteCount % 2 === 1) {
			inMultilineString = true
			return
		}
		const definition = dartDefinitionName(line)
		if (definition) {
			definitions.push(`- ${definition}`)
		}
	})

	return definitions.length > 0 ? `Definitions:\n${definitions.join("\n")}\n` : null
}

function dartDefinitionName(line: string): string | null {
	const trimmed = line.trim()
	const classMatch = trimmed.match(/^(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+)*class\s+([A-Za-z_]\w*)/)
	if (classMatch) return `class ${classMatch[1]}`
	const mixinMatch = trimmed.match(/^(?:base\s+)?mixin\s+([A-Za-z_]\w*)/)
	if (mixinMatch) return `mixin ${mixinMatch[1]}`
	const enumMatch = trimmed.match(/^enum\s+([A-Za-z_]\w*)/)
	if (enumMatch) return `enum ${enumMatch[1]}`
	const extensionMatch = trimmed.match(/^extension\s+([A-Za-z_]\w*)?/)
	if (extensionMatch?.[1]) return `extension ${extensionMatch[1]}`
	const typedefMatch = trimmed.match(/^typedef\s+([A-Za-z_]\w*)/)
	if (typedefMatch) return `typedef ${typedefMatch[1]}`
	const accessorMatch = trimmed.match(/^(?:static\s+)?(?:get|set)\s+([A-Za-z_]\w*)/)
	if (accessorMatch) return `accessor ${accessorMatch[1]}`
	const functionMatch = trimmed.match(
		/^(?:static\s+)?(?!(?:if|for|while|switch|catch|function)\b)(?:Future(?:Or)?<[^>]+>|Stream<[^>]+>|[A-Za-z_]\w*(?:<[^>]+>)?|void)\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:async\s*)?[{=>]/,
	)
	if (functionMatch) return `function ${functionMatch[1]}`
	return null
}
