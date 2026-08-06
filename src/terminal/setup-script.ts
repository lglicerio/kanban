// Wraps an agent launch command so a per-project setup script runs once, right
// after a task worktree is created, before the agent starts. Output streams in
// the same task terminal. If the setup script exits non-zero, the agent is not
// started (the `&&` / `exit` short-circuits), and the marker is not written so
// the next launch retries setup.
import { buildShellCommandLine, quoteShellArg } from "../core/shell";

export interface WrappedLaunchCommand {
	binary: string;
	args: string[];
}

// Name of the per-worktree marker file written inside the worktree's git
// directory once setup has completed successfully. Resolving it through
// `git rev-parse --git-path` keeps it scoped to the individual worktree and out
// of the working tree, so it never shows up in `git status`.
export const SETUP_MARKER_FILENAME = "kanban-setup-done";

interface BuildSetupWrappedCommandInput {
	setupScript: string;
	// Absolute path to the per-worktree setup completion marker. When provided,
	// setup runs only if the marker is absent (run-once-per-worktree). When
	// omitted, setup runs on every launch.
	doneMarkerPath?: string | null;
	commandBinary: string;
	commandArgs: string[];
}

// Returns the command to spawn in the task PTY. When `setupScript` is empty, the
// original agent command is returned unchanged.
export function buildSetupWrappedCommand(input: BuildSetupWrappedCommandInput): WrappedLaunchCommand {
	const setupScript = input.setupScript.trim();
	if (!setupScript) {
		return { binary: input.commandBinary, args: input.commandArgs };
	}
	if (process.platform === "win32") {
		return buildWindowsWrappedCommand(
			setupScript,
			input.doneMarkerPath ?? null,
			input.commandBinary,
			input.commandArgs,
		);
	}
	return buildPosixWrappedCommand(setupScript, input.doneMarkerPath ?? null, input.commandBinary, input.commandArgs);
}

function buildPosixWrappedCommand(
	setupScript: string,
	doneMarkerPath: string | null,
	commandBinary: string,
	commandArgs: string[],
): WrappedLaunchCommand {
	const shell = process.env.SHELL?.trim() || "/bin/sh";
	const runSetup = [
		`printf '\\n\\033[2m[kanban] Running project setup script…\\033[0m\\n'`,
		`(`,
		setupScript,
		`)`,
		`__kanban_status=$?`,
		`if [ "$__kanban_status" -ne 0 ]; then`,
		`  printf '\\n\\033[31m[kanban] Setup script failed (exit %s). Agent not started.\\033[0m\\n' "$__kanban_status" >&2`,
		`  exit "$__kanban_status"`,
		`fi`,
	];
	const guarded = doneMarkerPath
		? [
				`__kanban_marker=${quoteShellArg(doneMarkerPath)}`,
				`if [ ! -e "$__kanban_marker" ]; then`,
				...runSetup,
				`  : > "$__kanban_marker" 2>/dev/null || true`,
				`  printf '\\033[2m[kanban] Setup complete.\\033[0m\\n\\n'`,
				`fi`,
			]
		: runSetup;
	const wrapper = [...guarded, `exec "$@"`].join("\n");
	return {
		binary: shell,
		// `$0` is the placeholder label; `$1..` become the real agent command via `exec "$@"`.
		args: ["-c", wrapper, "kanban-setup", commandBinary, ...commandArgs],
	};
}

function buildWindowsWrappedCommand(
	setupScript: string,
	doneMarkerPath: string | null,
	commandBinary: string,
	commandArgs: string[],
): WrappedLaunchCommand {
	const comspec = process.env.COMSPEC?.trim() || "cmd.exe";
	const agentCommandLine = buildShellCommandLine(commandBinary, commandArgs);
	const setupClause = doneMarkerPath
		? `if not exist ${quoteWindowsArg(doneMarkerPath)} ( ( ${setupScript} ) && type nul > ${quoteWindowsArg(doneMarkerPath)} || exit /b 1 )`
		: `( ${setupScript} ) || exit /b 1`;
	const inner = `${setupClause} && ${agentCommandLine}`;
	return {
		binary: comspec,
		args: ["/d", "/s", "/c", inner],
	};
}

function quoteWindowsArg(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}
