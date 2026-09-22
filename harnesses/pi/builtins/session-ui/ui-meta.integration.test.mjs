import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DEFAULT_SESSION_UI_CONFIG } from "./config.ts";
import { UI_META_SENTINEL } from "./ui-meta-core.ts";

const root = process.env.PI_PACKAGE_ROOT;
let registerUiMeta, ExtensionRunner, AgentSession, buildSystemPromptSections, diffSystemPromptSections;
if (root) {
	const load = (path) => import(pathToFileURL(resolve(root, path)).href);
	({ ExtensionRunner } = await load("dist/core/extensions/runner.js"));
	({ AgentSession } = await load("dist/core/agent-session.js"));
	({ buildSystemPromptSections, diffSystemPromptSections } = await load("dist/core/system-prompt.js"));
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
		emit, message, handlers, ctx,
		begin: () => {
			const systemPromptOptions = { sections: {} };
			assert.equal(emit("before_agent_start", { systemPrompt: "Base", systemPromptOptions }), undefined);
			return systemPromptOptions;
		},
		end: () => { emit("agent_end"); emit("agent_settled"); },
		entries: () => branch,
		recaps: () => branch.filter((entry) => entry.customType === "session-ui:turn-recap").map((entry) => entry.data.text),
		setBranch: (entries) => { branch = structuredClone(entries); emit("session_tree"); },
		name: () => sessionName,
		render: (text) => renderers.get("session-ui:turn-recap")({ data: { text } }, {}, {
			fg: (_color, value) => value,
		}).render(200).join("\n"),
		marker: () => emit("context_with_system", { messages: [{ role: "user", content: "Follow up" }] }).messages[0].content.at(-1).text,
	};
}

test("keeps transcript placement, rendering and end timing while requesting cumulative task progress", options, () => {
	const h = harness();
	const prompt = h.begin().sections.session_ui_meta;
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
		assert.deepEqual(other.begin(), { sections: {} });
		other.message([start({ action: "set", name: "Task" }), { kind: "turn_end", recap: "Hidden" }]);
		other.end();
		assert.deepEqual(other.entries(), []);
	}
});

// These tests intentionally use Pi 0.87 internals; recheck them on Pi upgrades.
// Exercise the installed Pi transforms; only UI/session services are stubbed.
function nativeRunner(h, contextHandler) {
	const extensions = [{
		path: "session-ui",
		handlers: new Map([...h.handlers].map(([event, handler]) => [event, [handler]])),
	}];
	if (contextHandler) extensions.push({
		path: "tool-result-rewriter",
		handlers: new Map([["context", [contextHandler]]]),
	});
	const runner = new ExtensionRunner(extensions, {}, process.cwd(), {}, {});
	runner.createContext = () => h.ctx;
	runner.onError((error) => assert.fail(JSON.stringify(error)));
	return runner;
}

function requestTransform(runner, systemPromptOptions) {
	const host = {
		_runSystemPromptOptions: systemPromptOptions,
		agent: { transformContext: (messages) => runner.emitContext(messages) },
	};
	AgentSession.prototype._installAgentForcedPromptProjection.call(host);
	return host.agent.transformContext;
}

function transcript() {
	return [
		{ role: "system", content: "", sections: { preamble: "Base" }, toolsAdded: [
			{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
		], timestamp: 1 },
		{ role: "user", content: "Earlier request", timestamp: 2 },
		{ role: "system", content: "", sections: { project: "Updated project rules" }, toolsAdded: [
			{ name: "search", description: "Search files", parameters: { type: "object", properties: {} } },
		], timestamp: 3 },
		{ role: "user", content: [
			{ type: "text", text: "Current request" },
			{ type: "image", data: "test-image", mimeType: "image/png" },
		], timestamp: 4 },
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [
			{ type: "text", text: "Large observation" },
		], isError: false, timestamp: 5 },
	];
}

test("uses a stable protocol section without forcing the prompt or duplicating patches", options, async () => {
	const h = harness();
	assert.equal(h.handlers.has("context"), false);
	const runner = nativeRunner(h);
	const base = { cwd: process.cwd(), customPrompt: "Base", sections: { other: "Keep this section" } };
	const first = await runner.emitBeforeAgentStart("First request", undefined, base);
	assert.equal(first.systemPromptOptions.forceSystemPrompt, undefined);
	assert.equal(first.systemPromptOptions.sections.other, "Keep this section");
	assert.match(first.systemPromptOptions.sections.session_ui_meta, /Session UI metadata protocol/);
	const before = buildSystemPromptSections(base);
	const after = buildSystemPromptSections(first.systemPromptOptions);
	assert.deepEqual(Object.keys(diffSystemPromptSections(before, after)), ["session_ui_meta"]);
	h.end();
	const second = await runner.emitBeforeAgentStart("Next request", undefined, base);
	assert.equal(diffSystemPromptSections(after, buildSystemPromptSections(second.systemPromptOptions)), undefined);
	assert.deepEqual(base.sections, { other: "Keep this section" });
});

test("preserves the full system and tool prefix through native request transforms", options, async () => {
	const h = harness();
	const runner = nativeRunner(h);
	const { systemPromptOptions } = await runner.emitBeforeAgentStart("Request", undefined, { cwd: process.cwd() });
	const transform = requestTransform(runner, systemPromptOptions);
	const messages = transcript();
	const original = structuredClone(messages);
	const direct = h.emit("context_with_system", { messages });
	assert.deepEqual(messages, original);
	assert.notEqual(direct.messages, messages);
	assert.equal(direct.messages[0], messages[0]);
	assert.equal(direct.messages[2], messages[2]);
	const result = await transform(messages);
	assert.deepEqual(result.slice(0, 3), original.slice(0, 3));
	assert.deepEqual(result[3].content.slice(0, 2), original[3].content);
	assert.match(result[3].content.at(-1).text, /<ui_meta_request>/);
	assert.deepEqual(result[4], original[4]);
	assert.deepEqual(messages, original);
	assert.deepEqual(await transform(messages), result);
	h.end();
	assert.deepEqual(await transform(messages), original);
	assert.deepEqual(await transform([original[0]]), [original[0]]);
});

test("keeps restored prompt and tools when an earlier context phase rewrites observations", options, async () => {
	const h = harness();
	const rewrite = (event) => {
		assert.ok(event.messages.every((message) => message.role !== "system"));
		return { messages: event.messages.map((message) => message.role === "toolResult"
			? { ...message, content: [{ type: "text", text: "Observation placeholder" }] }
			: message) };
	};
	const runner = nativeRunner(h, rewrite);
	const { systemPromptOptions } = await runner.emitBeforeAgentStart("Request", undefined, { cwd: process.cwd() });
	const messages = transcript();
	const result = await requestTransform(runner, systemPromptOptions)(messages);
	assert.equal(result.filter((message) => message.role === "system").length, 1);
	assert.equal(result[0].sections.preamble, "Base");
	assert.equal(result[0].sections.project, "Updated project rules");
	assert.deepEqual(result[0].toolsAdded.map((tool) => tool.name), ["read", "search"]);
	assert.match(result.findLast((message) => message.role === "user").content.at(-1).text, /<ui_meta_request>/);
	assert.equal(result.at(-1).content[0].text, "Observation placeholder");
});

function preparePrompt(options, messages) {
	const host = { _toolRegistry: new Map(), agent: { state: {} } };
	return AgentSession.prototype._preparePromptAndToolLoadout.call(host, options, messages);
}

test("delivers the protocol patch and recreates it when the retained context lacks it", options, async () => {
	const h = harness();
	const runner = nativeRunner(h);
	const base = { cwd: process.cwd(), customPrompt: "Base", selectedTools: [] };
	const { systemPromptOptions } = await runner.emitBeforeAgentStart("Request", undefined, base);
	const retained = [
		{ role: "system", content: "", sections: buildSystemPromptSections(base), timestamp: 1 },
		{ role: "user", content: "Request or retained compaction summary", timestamp: 2 },
	];
	const patch = preparePrompt(systemPromptOptions, retained);
	assert.deepEqual(Object.keys(patch.sections), ["session_ui_meta"]);
	assert.match(patch.sections.session_ui_meta, /Session UI metadata protocol/);
	const history = [...retained, patch];
	const request = await requestTransform(runner, systemPromptOptions)(history);
	assert.deepEqual(request[0], retained[0]);
	assert.deepEqual(request.at(-1), patch);
	assert.match(request[1].content.at(-1).text, /<ui_meta_request>/);
	assert.equal(typeof history[1].content, "string");
	assert.equal(preparePrompt(systemPromptOptions, history), undefined);
	assert.deepEqual(preparePrompt(systemPromptOptions, retained).sections, patch.sections);
});

test("removes the persisted protocol when resuming outside TUI and restores it on return", options, async () => {
	const base = { cwd: process.cwd(), customPrompt: "Base", selectedTools: [] };
	const tui = nativeRunner(harness());
	const { systemPromptOptions: tuiOptions } = await tui.emitBeforeAgentStart("Request", undefined, base);
	const history = [
		{ role: "system", content: "", sections: buildSystemPromptSections(tuiOptions), timestamp: 1 },
		{ role: "user", content: "Resume", timestamp: 2 },
	];
	for (const mode of ["rpc", "print", "json"]) {
		const runner = nativeRunner(harness({ mode }));
		const { systemPromptOptions } = await runner.emitBeforeAgentStart("Resume", undefined, base);
		assert.equal(systemPromptOptions.sections.session_ui_meta, undefined);
		const removal = preparePrompt(systemPromptOptions, history);
		assert.deepEqual(removal.sections, { session_ui_meta: null });
		const resumed = [...history, removal];
		assert.deepEqual(await requestTransform(runner, systemPromptOptions)(resumed), resumed);
		assert.equal(preparePrompt(systemPromptOptions, resumed), undefined);
		assert.equal(preparePrompt(tuiOptions, resumed).sections.session_ui_meta, history[0].sections.session_ui_meta);
	}
});
