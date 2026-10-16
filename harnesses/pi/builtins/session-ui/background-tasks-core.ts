import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

/** One row of the system process table. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	elapsedSeconds: number;
	state: string;
	command: string;
}

/** A process that outlived the shell command Pi started it from. */
export interface BackgroundTask {
	pid: number;
	command: string;
	elapsedSeconds: number;
	/** The task process plus its live descendants. */
	processCount: number;
}

/** ps uses [[days-]hours:]minutes:seconds on macOS and Linux. */
export function parseElapsed(value: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
	if (!match) return undefined;
	const [, days, hours, minutes, seconds] = match;
	const total =
		Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 +
		Number(minutes) * 60 + Number(seconds);
	return Number.isSafeInteger(total) ? total : undefined;
}

export function formatProcessDuration(seconds: number): string {
	const value = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(value / 3600);
	const minutes = Math.floor(value / 60) % 60;
	const remainder = value % 60;
	return [
		...(hours > 0 ? [String(hours)] : []),
		String(minutes).padStart(2, "0"),
		String(remainder).padStart(2, "0"),
	].join(":");
}

/**
 * Shows the command line verbatim on one line. Only terminal-unsafe characters are removed;
 * macOS ps encodes tab/newline/CR as octal escapes, which become spaces like real whitespace.
 */
export function formatProcessCommand(command: string): string {
	return stripVTControlCharacters(command)
		.replace(/\\0(?:11|12|15)/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export type CommandLineReader = (pid: number) => string | undefined;

/**
 * Linux ps replaces non-printable argument bytes with "?", so read the exact NUL-separated
 * arguments instead. Kernel threads and exited processes yield undefined and fall back to ps.
 */
export function readLinuxCommandLine(pid: number): string | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+$/, "");
		return raw ? raw.split("\0").join(" ") : undefined;
	} catch {
		return undefined;
	}
}

export function parseProcessTable(output: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
		if (!match) continue;
		const elapsedSeconds = parseElapsed(match[4]!);
		if (elapsedSeconds === undefined) continue;
		rows.push({
			pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
			elapsedSeconds, state: match[5]!, command: match[6]!,
		});
	}
	return rows;
}

/**
 * Pi runs every shell command detached, as the leader of a new process group, and waits only
 * for that shell. Processes left in the group after the shell exits keep the group ID even once
 * they are reparented outside Pi's tree, so the group ID is the evidence of a background task.
 *
 * While the leader lives, the command is a foreground tool already shown by tool activity.
 * Only groups whose leader was seen as a direct child of Pi are known: a shell that exits
 * before the first sample leaves no evidence, and its processes are not guessed at. Services
 * sharing Pi's own process group and unrelated processes are never tasks.
 */
export class BackgroundTaskTracker {
	private readonly groups = new Set<number>();
	private readonly rootPid: number;
	private readonly readCommandLine?: CommandLineReader;

	constructor(rootPid: number, readCommandLine?: CommandLineReader) {
		this.rootPid = rootPid;
		this.readCommandLine = readCommandLine;
	}

	update(rows: readonly ProcessRow[]): BackgroundTask[] {
		for (const row of rows) {
			if (row.ppid === this.rootPid && row.pid === row.pgid) this.groups.add(row.pgid);
		}
		const live = rows.filter((row) => !row.state.startsWith("Z"));
		const byPid = new Map(live.map((row) => [row.pid, row]));
		const children = new Map<number, ProcessRow[]>();
		const members = new Map<number, ProcessRow[]>();
		for (const row of live) {
			const siblings = children.get(row.ppid) ?? [];
			siblings.push(row);
			children.set(row.ppid, siblings);
			if (!this.groups.has(row.pgid)) continue;
			const group = members.get(row.pgid) ?? [];
			group.push(row);
			members.set(row.pgid, group);
		}
		// The kernel does not reuse a group ID while the group exists; forget it once empty.
		for (const group of this.groups) {
			if (!members.has(group)) this.groups.delete(group);
		}

		const tasks: BackgroundTask[] = [];
		for (const [group, groupRows] of members) {
			if (byPid.has(group)) continue;
			for (const row of groupRows) {
				// A member started by another member belongs to that member's task.
				if (byPid.get(row.ppid)?.pgid === group) continue;
				tasks.push({
					pid: row.pid,
					command: formatProcessCommand(this.readCommandLine?.(row.pid) ?? row.command),
					elapsedSeconds: row.elapsedSeconds,
					processCount: countProcesses(row.pid, children),
				});
			}
		}
		// Newest first.
		return tasks.sort((a, b) => a.elapsedSeconds - b.elapsedSeconds || b.pid - a.pid);
	}
}

function countProcesses(pid: number, children: ReadonlyMap<number, ProcessRow[]>): number {
	const seen = new Set<number>();
	const pending = [pid];
	while (pending.length > 0) {
		const next = pending.pop()!;
		if (seen.has(next)) continue;
		seen.add(next);
		for (const child of children.get(next) ?? []) pending.push(child.pid);
	}
	return seen.size;
}

/** No shell, no credentials or environment inspection, and no persistent process history. */
export function sampleProcessTable(signal: AbortSignal): Promise<ProcessRow[]> {
	return new Promise((resolve, reject) => {
		execFile("/bin/ps", ["-ww", "-axo", "pid=,ppid=,pgid=,etime=,stat=,command="], {
			encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024,
			signal, env: { ...process.env, LC_ALL: "C" },
		}, (error, stdout) => {
			if (error) {
				// exec errors can contain stdout/stderr: never forward them to the UI.
				reject(new Error("Process sampling failed"));
				return;
			}
			resolve(parseProcessTable(stdout));
		});
	});
}

export type ProcessTableSampler = (signal: AbortSignal) => Promise<ProcessRow[]>;

/** Serialized sampling; stopping also rejects late results from a previous session. */
export function watchProcessTable(
	onRows: (rows: ProcessRow[]) => void,
	onError: () => void,
	options: { sample?: ProcessTableSampler; intervalMs?: number } = {},
): () => void {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poll = async () => {
		try {
			const rows = await (options.sample ?? sampleProcessTable)(controller.signal);
			if (!controller.signal.aborted) onRows(rows);
		} catch {
			if (!controller.signal.aborted) onError();
		} finally {
			if (!controller.signal.aborted) {
				timer = setTimeout(() => void poll(), options.intervalMs ?? 1000);
				timer.unref();
			}
		}
	};
	void poll();
	return () => {
		controller.abort();
		clearTimeout(timer);
	};
}
