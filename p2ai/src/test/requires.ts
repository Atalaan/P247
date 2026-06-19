import { createRequire } from "module"

const require = createRequire(import.meta.url)
const Module = require("module")
const originalRequire = Module.prototype.require

/**
 * VSCode is not available during unit tests
 * @see {@link file://./vscode-mock.ts}
 */
Module.prototype.require = function (path: string) {
	if (path === "vscode") {
		return require("./vscode-mock")
	}
	// Avoid pulling in VSCode-integrated checkpoint/editor code during unit tests
	if (path === "@integrations/checkpoints") {
		return {}
	}
	if (path === "@integrations/checkpoints/MultiRootCheckpointManager") {
		return { MultiRootCheckpointManager: class {} }
	}

	return originalRequire.call(this, path)
}

// Unit tests only need the String.prototype.toPosix helper, not the full
// runtime path module with workspace/host dependencies.
declare global {
	interface String {
		toPosix(): string
	}
}

String.prototype.toPosix = function (this: string): string {
	if (this.startsWith("\\\\?\\")) {
		return this.toString()
	}
	return this.replace(/\\/g, "/")
}

export {}
