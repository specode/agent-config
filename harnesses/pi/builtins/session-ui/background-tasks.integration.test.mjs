import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

const root = process.env.PI_PACKAGE_ROOT;
let registerBackgroundTasks, theme, visibleWidth;
if (root) {
	const load = (path) => import(pathToFileURL(resolve(root, path)).href);
	const themeModule = await load("dist/modes/interactive/theme/theme.js");
	themeModule.initTheme("dark", false);
	theme = themeModule.theme;
	const require = createRequire(resolve(root, "package.json"));
	const tuiPath = require.resolve("@earendil-works/pi-tui");
	({ visibleWidth } = await import(pathToFileURL(tuiPath).href));
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			return nextResolve(specifier === "@earendil-works/pi-tui" ? tuiPath : specifier, context);
		},
	});
	try { ({ registerBackgroundTasks } = await import("./background-tasks.ts")); }
	finally { hooks.deregister(); }
}
const supported = process.platform === "darwin" || process.platform === "linux";
const options = { skip: !root || !supported };

const PI = process.pid;
const SHELL = 100;
const row = (pid, ppid, pgid, command, elapsedSeconds = 1, state = "S") =>
	({ pid, ppid, pgid, elapsedSeconds, state, command });
/** Pi's detached shell while the tool runs, with its children. */
const running = (...children) => [row(SHELL, PI, SHELL, "bash -c job", 1, "Ss"), ...children];
/** The same children once the shell exited and they were reparented. */
const detached = (...children) => children.map((child) => ({ ...child, ppid: child.ppid === SHELL ? 1 : child.ppid }));

function harness(overrides = {}, config = {}) {
	const handlers = new Map();
	let widget, placement;
	const notifications = [];
	const watches = [];
	const ctx = {
		hasUI: true, mode: "tui",
		ui: {
			setWidget: (_id, factory, config) => {
				placement = config?.placement;
				widget = factory?.({ requestRender() {} }, theme);
			},
			notify: (text) => notifications.push(text),
		},
		...overrides,
	};
	registerBackgroundTasks({ on: (event, handler) => handlers.set(event, handler) },
		{ enabled: true, placement: "aboveEditor", maxItems: 3, ...config },
		(update, error) => {
			const watch = { update, error, stops: 0 };
			watches.push(watch);
			return () => { watch.stops++; };
		});
	const emit = (event, context = ctx) => handlers.get(event)?.({}, context);
	return {
		emit, ctx, watches, notifications, placement: () => placement,
		lines: (width = 100) => widget?.render(width) ?? [],
		plain: (width = 100) => (widget?.render(width) ?? []).map(stripVTControlCharacters),
	};
}

const tasks = [
	row(101, SHELL, SHELL, "npm run dev", 135),
	row(102, 101, SHELL, "node vite.js", 134),
	row(103, SHELL, SHELL, "python -m http.server", 32),
	row(104, SHELL, SHELL, "sleep 600", 48),
	row(105, SHELL, SHELL, "tail -f log", 12),
];

test("hides foreground commands and renders background tasks capped and width-safe", options, () => {
	const h = harness();
	assert.equal(h.watches.length, 0, "factory must not start resources");
	h.emit("session_start");
	assert.equal(h.placement(), "aboveEditor");
	h.watches[0].update(running(...tasks, row(200, PI, PI, "claude --output-format stream-json")));
	assert.deepEqual(h.plain(), [], "foreground commands belong to tool activity");
	h.watches[0].update(detached(...tasks, row(200, PI, PI, "claude --output-format stream-json")));
	assert.deepEqual(h.plain(), [
		"Background · 4 tasks · 1 hidden",
		"◆ tail -f log · pid 105 · 00:12",
		"◆ python -m http.server · pid 103 · 00:32",
		"◆ sleep 600 · pid 104 · 00:48",
	]);
	h.watches[0].update(detached(tasks[0], tasks[1]));
	assert.deepEqual(h.plain(), ["Background · 1 task", "◆ npm run dev · pid 101 · 2 procs · 02:15"]);
	h.watches[0].update(detached({ ...tasks[0], command: "node 测试脚本.ts " + "very-long ".repeat(20) }));
	for (const width of [0, 1, 8, 24, 48, 100]) {
		for (const line of h.lines(width)) assert.ok(visibleWidth(line) <= width, line);
	}
	assert.ok(h.plain(48)[1].endsWith(" · pid 101 · 02:15"));
	h.watches[0].update(detached({ ...tasks[0], elapsedSeconds: 136 }));
	assert.ok(h.plain()[1].endsWith("02:16"));
	h.watches[0].update([]);
	assert.deepEqual(h.plain(), []);
	h.emit("session_shutdown");
});

test("respects disabled state, placement and row limits", options, () => {
	const disabled = harness({}, { enabled: false });
	disabled.emit("session_start");
	assert.deepEqual(disabled.watches, []);
	const h = harness({}, { placement: "belowEditor", maxItems: 1 });
	h.emit("session_start");
	assert.equal(h.placement(), "belowEditor");
	h.watches[0].update(running(...tasks));
	h.watches[0].update(detached(...tasks));
	assert.equal(h.plain().length, 2);
	assert.equal(h.plain()[0], "Background · 4 tasks · 3 hidden");
	h.emit("session_shutdown");
});

test("survives turns, clears on shutdown and keeps group evidence across session switches", options, () => {
	const h = harness();
	h.emit("session_start");
	const old = h.watches[0];
	old.update(running(tasks[3]));
	old.update(detached(tasks[3]));
	h.emit("turn_end");
	h.emit("agent_settled");
	assert.equal(h.plain().length, 2);
	h.emit("session_shutdown");
	h.emit("session_shutdown");
	assert.equal(old.stops, 1);
	assert.deepEqual(h.plain(), []);
	h.emit("session_start");
	old.update(detached(...tasks));
	old.error();
	assert.deepEqual(h.plain(), []);
	assert.deepEqual(h.notifications, []);
	// The process outlived the earlier session; its group evidence still applies.
	h.watches[1].update(detached(tasks[3]));
	assert.deepEqual(h.plain()[1], "◆ sleep 600 · pid 104 · 00:48");
	h.emit("session_start");
	assert.equal(h.watches[1].stops, 1);
	assert.deepEqual(h.plain(), []);
	h.emit("session_shutdown");
});

test("clears stale tasks on failure, warns once and does not sample in non-TUI modes", options, () => {
	const h = harness();
	h.emit("session_start");
	h.watches[0].update(running(tasks[3]));
	h.watches[0].update(detached(tasks[3]));
	h.watches[0].error();
	assert.deepEqual(h.plain(), []);
	h.watches[0].error();
	assert.equal(h.notifications.length, 1);
	h.watches[0].update(detached(tasks[3]));
	assert.equal(h.plain().length, 2, "group evidence survives a failed sample");
	h.emit("session_shutdown");
	for (const mode of ["rpc", "json", "print"]) {
		const other = harness({ mode });
		other.emit("session_start");
		assert.deepEqual(other.watches, []);
		other.emit("session_shutdown");
	}
	const headless = harness({ hasUI: false });
	headless.emit("session_start");
	assert.deepEqual(headless.watches, []);
});
