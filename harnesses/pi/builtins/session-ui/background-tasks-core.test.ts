import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
	BackgroundTaskTracker, formatProcessCommand, formatProcessDuration, parseElapsed,
	parseProcessTable, readLinuxCommandLine, sampleProcessTable, watchProcessTable,
	type BackgroundTask, type ProcessRow,
} from "./background-tasks-core.ts";

const PI = 10;

function row(pid: number, ppid: number, pgid: number, command: string, elapsedSeconds = 1, state = "S"): ProcessRow {
	return { pid, ppid, pgid, elapsedSeconds, state, command };
}

test("parses macOS and Linux elapsed time and formats long durations", () => {
	assert.equal(parseElapsed("00:32"), 32);
	assert.equal(parseElapsed("02:03:04"), 7384);
	assert.equal(parseElapsed("2-03:04:05"), 183845);
	assert.equal(parseElapsed("invalid"), undefined);
	assert.equal(formatProcessDuration(32), "00:32");
	assert.equal(formatProcessDuration(7384), "2:03:04");
	assert.equal(formatProcessDuration(183845), "51:04:05");
});

test("parses process table rows and skips malformed ones", () => {
	assert.deepEqual(parseProcessTable([
		"   11    10    11       02:15 Ss   bash -c npm run dev &",
		"12 11 11 1-00:00:01 S+ node  server.js --port 3000",
		"bad row", "13 11 11 soon S node",
	].join("\n")), [
		row(11, 10, 11, "bash -c npm run dev &", 135, "Ss"),
		row(12, 11, 11, "node  server.js --port 3000", 86401, "S+"),
	]);
});

test("hides foreground commands, services in Pi's own group and unrelated processes", () => {
	const tracker = new BackgroundTaskTracker(PI);
	assert.deepEqual(tracker.update([
		row(PI, 1, PI, "pi"),
		row(11, PI, 11, "bash -c npm test"),
		row(12, 11, 11, "npm test"),
		row(13, PI, PI, "claude --output-format stream-json"),
		row(14, PI, PI, "/bin/ps -ww -axo pid=,ppid=,pgid=,etime=,stat=,command="),
		row(20, 1, 19, "crashpad_handler"),
	]), []);
});

test("shows processes that outlive their shell, one task per surviving process", () => {
	const tracker = new BackgroundTaskTracker(PI);
	tracker.update([
		row(11, PI, 11, "bash -c 'npm run dev & sleep 60 &'"),
		row(12, 11, 11, "npm run dev", 0), row(13, 11, 11, "sleep 60", 0),
	]);
	// The shell exits: survivors are reparented outside Pi's tree but keep the group.
	assert.deepEqual(tracker.update([
		row(12, 1, 11, "npm run dev", 5),
		row(14, 12, 11, "node vite.js", 4),
		row(15, 14, 15, "esbuild --service", 4),
		row(13, 1, 11, "sleep 60", 5),
	]), [
		{ pid: 13, command: "sleep 60", elapsedSeconds: 5, processCount: 1 },
		{ pid: 12, command: "npm run dev", elapsedSeconds: 5, processCount: 3 },
	] satisfies BackgroundTask[]);
});

test("treats a zombie leader as exited and never shows zombie processes", () => {
	const tracker = new BackgroundTaskTracker(PI);
	assert.deepEqual(tracker.update([
		row(11, PI, 11, "bash", 1, "Z"),
		row(12, 1, 11, "worker"),
		row(13, 12, 11, "defunct", 1, "Z"),
	]), [{ pid: 12, command: "worker", elapsedSeconds: 1, processCount: 1 }]);
});

test("forgets a group once it is empty, so a reused group ID is never claimed", () => {
	const tracker = new BackgroundTaskTracker(PI);
	tracker.update([row(11, PI, 11, "bash"), row(12, 11, 11, "worker")]);
	assert.equal(tracker.update([row(12, 1, 11, "worker")]).length, 1);
	assert.deepEqual(tracker.update([]), []);
	assert.deepEqual(tracker.update([row(30, 1, 11, "unrelated")]), []);
});

test("does not guess at shells that exited before they were sampled", () => {
	const tracker = new BackgroundTaskTracker(PI);
	assert.deepEqual(tracker.update([row(12, 1, 11, "npm run dev")]), []);
});

test("reads exact command lines only for background tasks", () => {
	const reads: number[] = [];
	const tracker = new BackgroundTaskTracker(PI, (pid) => {
		reads.push(pid);
		return pid === 12 ? "bash -c a\nb" : undefined;
	});
	tracker.update([
		row(11, PI, 11, "bash"), row(12, 11, 11, "bash -c a?b"),
		row(13, 11, 11, "[kworker]"), row(40, PI, PI, "service"),
	]);
	assert.deepEqual(reads, []);
	assert.deepEqual(tracker.update([
		row(12, 1, 11, "bash -c a?b", 1), row(13, 1, 11, "[kworker]", 2), row(40, PI, PI, "service"),
	]).map((task) => task.command), ["bash -c a b", "[kworker]"]);
	assert.deepEqual(reads.sort(), [12, 13]);
});

test("shows commands verbatim on one line without redaction", () => {
	assert.equal(
		formatProcessCommand("curl -u admin:pass --token=abc https://user:pw@example.com"),
		"curl -u admin:pass --token=abc https://user:pw@example.com",
	);
	// macOS ps encodes tab, newline and CR in arguments as octal escapes.
	assert.equal(formatProcessCommand("bash -c cd x\\012npm test\\011--watch\\015"), "bash -c cd x npm test --watch");
	assert.equal(formatProcessCommand("bash -c 'a\nb\tc'"), "bash -c 'a b c'");
	assert.equal(formatProcessCommand("\x1b[31mnode\x1b[0m\x07 job.py\u202e"), "node job.py");
	assert.equal(formatProcessCommand("node 测试.ts"), "node 测试.ts");
});

test("serializes polling, aborts on stop and discards late results", async () => {
	let resolveSample!: (rows: ProcessRow[]) => void;
	let signal!: AbortSignal;
	let calls = 0;
	const updates: ProcessRow[][] = [];
	const stop = watchProcessTable((rows) => updates.push(rows), () => assert.fail("unexpected error"), {
		intervalMs: 1,
		sample: (value) => {
			calls++;
			signal = value;
			return new Promise((resolve) => { resolveSample = resolve; });
		},
	});
	try {
		await delay(20);
		assert.equal(calls, 1);
		stop();
		stop();
		assert.equal(signal.aborted, true);
		resolveSample([row(1, PI, 1, "late")]);
		await delay(20);
		assert.deepEqual(updates, []);
		assert.equal(calls, 1);
	} finally { stop(); }
});

test("reports a failed sample and resumes on the next one", async () => {
	const rows = [row(11, PI, 11, "node")];
	const updates: ProcessRow[][] = [];
	let errors = 0;
	let calls = 0;
	let complete!: () => void;
	const done = new Promise<void>((resolve) => { complete = resolve; });
	const stop = watchProcessTable((value) => {
		updates.push(value);
		if (updates.length === 2) complete();
	}, () => { errors++; }, {
		intervalMs: 1,
		sample: async () => { if (++calls === 2) throw new Error("private output"); return rows; },
	});
	try {
		await Promise.race([done, delay(1000).then(() => { throw new Error("poll timeout"); })]);
		stop();
		assert.deepEqual(updates, [rows, rows]);
		assert.equal(errors, 1);
	} finally { stop(); }
});

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 3000;
	for (;;) {
		const value = await read();
		if (accept(value) || Date.now() > deadline) return value;
		await delay(50);
	}
}

test("tracks a real process that outlives its detached shell, with arguments on one line", {
	skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
	const signal = new AbortController().signal;
	// Mirrors Pi's shell tool: a detached shell starts a background command, then exits.
	const shell = spawn("/bin/sh", [
		"-c", '"$@" >/dev/null 2>&1 & echo $!; read _', "sh",
		process.execPath, "-e", "setInterval(() => {}, 1000)", "first\nsecond\tthird",
	], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
	let backgroundPid: number | undefined;
	try {
		const [data] = await once(shell.stdout!, "data");
		backgroundPid = Number(String(data).trim());
		const tracker = new BackgroundTaskTracker(
			process.pid,
			process.platform === "linux" ? readLinuxCommandLine : undefined,
		);
		assert.deepEqual(tracker.update(await sampleProcessTable(signal)), [], "foreground while the shell runs");
		const exited = once(shell, "exit");
		shell.stdin!.end();
		await exited;
		const tasks = await until(
			async () => tracker.update(await sampleProcessTable(signal)),
			(value) => value[0]?.command.endsWith(" first second third") === true,
		);
		assert.deepEqual(tasks.map((task) => task.pid), [backgroundPid]);
		assert.ok(tasks[0]!.command.endsWith(" first second third"), tasks[0]!.command);
		process.kill(backgroundPid);
		const after = await until(
			async () => tracker.update(await sampleProcessTable(signal)),
			(value) => value.length === 0,
		);
		assert.deepEqual(after, []);
	} finally {
		try { if (backgroundPid) process.kill(backgroundPid); } catch {}
		shell.kill();
	}
});
