import { afterEach, describe, expect, it } from "vitest";

import { buildSetupWrappedCommand, SETUP_MARKER_FILENAME } from "../../../src/terminal/setup-script";

const originalShell = process.env.SHELL;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	if (originalShell === undefined) {
		delete process.env.SHELL;
	} else {
		process.env.SHELL = originalShell;
	}
});

describe("buildSetupWrappedCommand", () => {
	it("returns the original command unchanged when the setup script is empty", () => {
		const result = buildSetupWrappedCommand({
			setupScript: "   ",
			doneMarkerPath: "/repo/.git/worktrees/t/kanban-setup-done",
			commandBinary: "claude",
			commandArgs: ["--flag", "value"],
		});
		expect(result).toEqual({ binary: "claude", args: ["--flag", "value"] });
	});

	it("wraps the command in a POSIX shell that runs setup before exec-ing the agent", () => {
		setPlatform("darwin");
		process.env.SHELL = "/bin/zsh";
		const result = buildSetupWrappedCommand({
			setupScript: "npm install",
			doneMarkerPath: "/repo/.git/worktrees/t/kanban-setup-done",
			commandBinary: "claude",
			commandArgs: ["--dangerously-skip-permissions"],
		});

		expect(result.binary).toBe("/bin/zsh");
		expect(result.args[0]).toBe("-c");
		// The real agent command is passed as positional parameters and exec'd via "$@".
		expect(result.args.slice(2)).toEqual(["kanban-setup", "claude", "--dangerously-skip-permissions"]);
		const wrapper = result.args[1];
		expect(wrapper).toContain("npm install");
		expect(wrapper).toContain('exec "$@"');
		// Quotes the marker path and guards on its absence (run-once-per-worktree).
		expect(wrapper).toContain("'/repo/.git/worktrees/t/kanban-setup-done'");
		expect(wrapper).toContain('[ ! -e "$__kanban_marker" ]');
	});

	it("falls back to /bin/sh and runs every time when no marker is provided", () => {
		setPlatform("linux");
		delete process.env.SHELL;
		const result = buildSetupWrappedCommand({
			setupScript: "echo hi",
			doneMarkerPath: null,
			commandBinary: "codex",
			commandArgs: [],
		});

		expect(result.binary).toBe("/bin/sh");
		const wrapper = result.args[1];
		expect(wrapper).toContain("echo hi");
		expect(wrapper).toContain('exec "$@"');
		// No marker means no once-guard.
		expect(wrapper).not.toContain("__kanban_marker");
	});

	it("wraps with cmd.exe on Windows", () => {
		setPlatform("win32");
		const result = buildSetupWrappedCommand({
			setupScript: "npm install",
			doneMarkerPath: "C:\\repo\\.git\\worktrees\\t\\kanban-setup-done",
			commandBinary: "claude.cmd",
			commandArgs: ["--flag"],
		});

		expect(result.args[0]).toBe("/d");
		const inner = result.args[result.args.length - 1];
		expect(inner).toContain("npm install");
		expect(inner).toContain("claude.cmd");
		expect(inner).toContain("if not exist");
	});

	it("exposes the marker filename used to scope setup completion", () => {
		expect(SETUP_MARKER_FILENAME).toBe("kanban-setup-done");
	});
});
