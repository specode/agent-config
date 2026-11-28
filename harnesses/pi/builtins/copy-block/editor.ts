import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EditorLaunchResult {
	ok: boolean;
	message?: string;
}

/**
 * Splits a configured editor command into `[executable, ...args]` while
 * preserving quoted segments. On Windows, backslashes remain path separators
 * unless directly escaping a double quote inside double quotes.
 */
export function parseEditorCommand(
	command: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const isWin = platform === "win32";
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let hasToken = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (escaped) {
			current += ch;
			escaped = false;
			hasToken = true;
			continue;
		}
		if (!isWin && ch === "\\" && quote !== "'") {
			escaped = true;
			hasToken = true;
			continue;
		}
		if (isWin && quote === '"' && ch === "\\" && command[i + 1] === '"') {
			escaped = true;
			hasToken = true;
			continue;
		}
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			hasToken = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (hasToken) {
				tokens.push(current);
				current = "";
				hasToken = false;
			}
			continue;
		}
		current += ch;
		hasToken = true;
	}

	if (escaped) current += "\\";
	if (hasToken) tokens.push(current);
	return tokens;
}

export function quoteWindowsShellArg(arg: string): string {
	if (!/[\s"&|<>^()%]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '\\"')}"`;
}

export function resolveFallbackEditorCommand(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	const fromEnv = env.VISUAL?.trim() || env.EDITOR?.trim();
	if (fromEnv) return fromEnv;
	return platform === "win32" ? "notepad" : "nano";
}

/**
 * Opens text in a blocking external editor via a private temporary scratch
 * file and cleans up the temporary directory after the editor exits.
 */
export async function launchExternalEditor(
	command: string,
	content: string,
	extension = "md",
): Promise<EditorLaunchResult> {
	const parts = parseEditorCommand(command);
	const executable = parts[0];
	if (!executable) {
		return { ok: false, message: "No external editor command configured." };
	}
	const args = parts.slice(1);
	const safeExt = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "md";

	let tempDir: string | undefined;
	try {
		tempDir = mkdtempSync(join(tmpdir(), "pi-copy-block-"));
		const filePath = join(tempDir, `snippet.${safeExt}`);
		writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });

		const isWin = process.platform === "win32";
		const spawnCmd = isWin ? quoteWindowsShellArg(executable) : executable;
		const spawnArgs = isWin
			? [...args, filePath].map(quoteWindowsShellArg)
			: [...args, filePath];

		const exit = await new Promise<number | NodeJS.Signals | null>(
			(resolve) => {
				const child = spawn(spawnCmd, spawnArgs, {
					stdio: "inherit",
					shell: isWin,
				});
				child.on("error", () => resolve(null));
				child.on("close", (code, signal) => resolve(code ?? signal));
			},
		);

		if (exit === null) {
			return {
				ok: false,
				message: `Failed to launch external editor: ${command}`,
			};
		}
		if (exit !== 0) {
			return {
				ok: false,
				message: `External editor exited with ${typeof exit === "number" ? `code ${exit}` : exit}`,
			};
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			message: `External editor failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup.
			}
		}
	}
}
