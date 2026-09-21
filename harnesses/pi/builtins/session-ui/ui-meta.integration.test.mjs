import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { DEFAULT_SESSION_UI_CONFIG } from "./config.ts";
import { UI_META_SENTINEL } from "./ui-meta-core.ts";

const root = process.env.PI_PACKAGE_ROOT;
let registerUiMeta;
if (root) {
	const require = createRequire(resolve(root, "package.json"));
	const tuiPath = require.resolve("@earendil-works/pi-tui");
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			return nextResolve(specifier === "@earendil-works/pi-tui" ? tuiPath : specifier, context);
		},
	});
	try {
		({ registerUiMeta } = await import("./ui-meta.ts"));
	} finally {
		hooks.deregister();
	}
}
const options = { skip: !root };
const meta = (record) => `${UI_META_SENTINEL}${JSON.stringify({ v: 1, ...record })}`;
const start = (task = { action: "keep" }) => ({
	kind: "turn_start", title: "Current action", session: { action: "keep" }, task,
});

function harness({ entries = [], config = DEFAULT_SESSION_UI_CONFIG.uiMeta, name, mode = "tui" } = {}) {
	const handlers = new Map();
	const renderers = new Map();
	let branch = structuredClone(entries);
	let sessionName = name;
	const ctx = {
		mode,
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
		ui: { setWidget: () => assert.fail("Recap must remain in the transcript") },
	};
	registerUiMeta({
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		getSessionName: () => sessionName,
		setSessionName: (value) => { sessionName = value; },
		registerEntryRenderer: (key, renderer) => renderers.set(key, renderer),
		registerMarkdownTransformer: () => {},
	}, config, { setTaskTitle() {}, setWorking() {} });
	const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
	const message = (records, stopReason = "stop", toolCalls = false) => emit("message_end", {
		message: { role: "assistant", stopReason, content: [
			{ type: "text", text: records.map(meta).join("\nAnswer\n") },
			...(toolCalls ? [{ type: "toolCall", id: "1", name: "test", arguments: {} }] : []),
		] },
	});
	emit("session_start");
	return {
		emit, message,
		begin: () => emit("before_agent_start", { systemPrompt: "Base" }),
		end: () => { emit("agent_end"); emit("agent_settled"); },
		entries: () => branch,
		recaps: () => branch.filter((entry) => entry.customType === "session-ui:turn-recap").map((entry) => entry.data.text),
		setBranch: (entries) => { branch = structuredClone(entries); emit("session_tree"); },
		name: () => sessionName,
		render: (text) => renderers.get("session-ui:turn-recap")({ data: { text } }, {}, {
			fg: (_color, value) => value,
		}).render(200).join("\n"),
		marker: () => emit("context", { messages: [{ role: "user", content: "Follow up" }] }).messages[0].content.at(-1).text,
	};
}

test("keeps transcript placement, rendering and end timing while requesting cumulative task progress", options, () => {
	const h = harness();
	const prompt = h.begin().systemPrompt;
	assert.match(prompt, /across all relevant conversation turns/);
	assert.match(prompt, /NOT a report of only this agent run/);
	assert.match(prompt, /bounded by the outcome the user wants to achieve/);
	assert.match(prompt, /not by an individual message, tool call, action, or workflow phase/);
	assert.match(prompt, /do not merge unrelated goals merely because they share a topic/);
	assert.match(prompt, /Discussion, agreement, or a plan is not implementation; implementation is not verification/);
	assert.match(prompt, /For discussion-only tasks, summarize what was clarified or decided/);
	assert.match(prompt, /Treat suggestions as proposals unless the user accepted them/);
	h.message([start({ action: "set", name: "Feature A" }), { kind: "turn_end", recap: "Implemented; tests pending" }]);
	assert.deepEqual(h.recaps(), []);
	h.end();
	assert.deepEqual(h.recaps(), ["Implemented; tests pending"]);
	assert.equal(h.render(h.recaps()[0]).trimEnd(), "↳ Recap · Implemented; tests pending");
	h.begin();
	assert.match(h.marker(), /Feature A/);
	assert.doesNotMatch(h.marker(), /Implemented; tests pending/);
	h.message([start(), { kind: "turn_end", recap: "Implemented; regression passed; terminal unchecked" }]);
	h.end();
	assert.deepEqual(h.recaps(), ["Implemented; tests pending", "Implemented; regression passed; terminal unchecked"]);
	h.begin();
	h.message([start(), { kind: "turn_end", recap: "Implemented; regression now fails" }]);
	h.end();
	assert.equal(h.recaps().at(-1), "Implemented; regression now fails");
	assert.equal(h.recaps().length, 3);
});

test("does not gate valid recaps on task metadata", options, () => {
	for (const firstStart of [start(), {
		kind: "turn_start", title: "Current action", session: { action: "keep" },
	}]) {
		const h = harness();
		h.begin();
		h.message([firstStart, { kind: "turn_end", recap: "Current progress" }]);
		h.end();
		assert.deepEqual(h.recaps(), ["Current progress"]);
	}
	const h = harness();
	h.begin();
	h.message([start({ action: "set", name: "Task" }), { kind: "turn_end", recap: "Implemented" }]);
	h.end();
	h.begin();
	h.message([{ kind: "turn_start", title: "Current action", session: { action: "keep" } },
		{ kind: "turn_end", recap: "Implemented; tests passed" }]);
	h.end();
	assert.deepEqual(h.recaps(), ["Implemented", "Implemented; tests passed"]);
});

test("preserves normal recap cadence even when the task progress is unchanged", options, () => {
	const h = harness();
	for (let i = 0; i < 2; i++) {
		h.begin();
		h.message([start(i ? { action: "keep" } : { action: "set", name: "Task" }), { kind: "turn_end", recap: "Implemented; testing pending" }]);
		h.end();
	}
	assert.equal(h.recaps().length, 2);
});

test("tracks task identity independently of session naming without deleting historical recaps", options, () => {
	const h = harness({ name: "Pinned name" });
	h.begin();
	h.message([start({ action: "set", name: "Task A" }), { kind: "turn_end", recap: "A complete" }]);
	h.end();
	const taskA = structuredClone(h.entries());
	h.begin();
	h.message([start({ action: "set", name: "Task B" }), { kind: "turn_end", recap: "B blocked" }]);
	h.end();
	assert.equal(h.name(), "Pinned name");
	assert.deepEqual(h.recaps(), ["A complete", "B blocked"]);
	const restored = harness({ entries: h.entries(), name: "Pinned name" });
	restored.begin();
	assert.match(restored.marker(), /Task B/);
	restored.setBranch(taskA);
	restored.begin();
	assert.match(restored.marker(), /Task A/);
	assert.deepEqual(restored.recaps(), ["A complete"]);
	restored.emit("session_shutdown");
});

test("ignores failed and tool-bearing recaps and preserves task identity through compaction", options, () => {
	const h = harness();
	h.begin();
	h.message([start({ action: "set", name: "Task" }), { kind: "turn_end", recap: "Invalid" }], "aborted");
	h.message([{ kind: "turn_end", recap: "Tool result" }], "stop", true);
	h.emit("session_compact", { willRetry: true });
	h.begin();
	assert.match(h.marker(), /"needStart":false/);
	h.message([{ kind: "turn_end", recap: "Actual task progress" }]);
	h.end();
	h.message([{ kind: "turn_end", recap: "Stale response" }]);
	h.end();
	assert.deepEqual(h.recaps(), ["Actual task progress"]);
});

test("supports recap-only configuration and leaves non-TUI sessions untouched", options, () => {
	const config = structuredClone(DEFAULT_SESSION_UI_CONFIG.uiMeta);
	config.title.enabled = false;
	config.sessionName.enabled = false;
	const h = harness({ config });
	h.begin();
	assert.match(h.marker(), /"needStart":false/);
	h.message([{ kind: "turn_end", recap: "Latest progress" }]);
	h.end();
	assert.deepEqual(h.recaps(), ["Latest progress"]);
	for (const mode of ["rpc", "print", "json"]) {
		const other = harness({ mode });
		assert.equal(other.begin(), undefined);
		other.message([start({ action: "set", name: "Task" }), { kind: "turn_end", recap: "Hidden" }]);
		other.end();
		assert.deepEqual(other.entries(), []);
	}
});
