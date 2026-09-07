import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerOpenAIFast } from "./runtime.ts";

type Handler = (event: { payload?: unknown }, ctx: ExtensionContext) => unknown;
type Command = {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
	getArgumentCompletions: (prefix: string) => { value: string; label: string }[];
};

function harness(t: TestContext, raw: unknown = { enabled: true }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-openai-fast-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = join(dir, "openai-fast.json");
	if (raw !== undefined) writeFileSync(configPath, JSON.stringify(raw));
	const handlers = new Map<string, Handler>();
	let command!: Command;
	let footer: string | undefined;
	const notices: string[] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, value: Command) => {
			assert.equal(name, "fast");
			command = value;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		model: {
			id: "gpt-6-astra",
			provider: "openai-codex",
			api: "openai-codex-responses",
		},
		modelRegistry: { isUsingOAuth: () => true },
		sessionManager: {},
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				assert.equal(key, "openai-fast");
				footer = text;
			},
			notify: (text: string) => notices.push(text),
		},
	} as unknown as ExtensionContext;
	registerOpenAIFast(pi, configPath);
	function emit(event: string, payload?: unknown, context = ctx) {
		const handler = handlers.get(event);
		assert.ok(handler, `registered ${event}`);
		return handler({ payload }, context);
	}
	emit("session_start");
	return {
		ctx,
		emit,
		notices,
		configPath,
		command: (args: string, context = ctx) => command.handler(args, context),
		complete: (prefix: string) => command.getArgumentCompletions(prefix),
		footer: () => footer,
		request: (payload: unknown = { model: ctx.model?.id }) =>
			emit("before_provider_request", payload),
	};
}

for (const model of [
	"gpt-5.4",
	"gpt-5.5",
	"gpt-6",
	"gpt-6-astra",
	"future-model",
]) {
	test(`injects priority without a model allowlist: ${model}`, (t) => {
		const h = harness(t);
		h.ctx.model!.id = model;
		const payload = Object.freeze({
			model,
			reasoning: { effort: "high" },
			input: [],
		});
		assert.deepEqual(h.request(payload), {
			...payload,
			service_tier: "priority",
		});
		assert.equal("service_tier" in payload, false);
		assert.equal(h.footer(), "fast");
	});
}

for (const tier of ["auto", "default", "priority", "flex", null, undefined]) {
	test(`preserves existing service_tier including ${tier}`, async (t) => {
		const h = harness(t);
		const payload = Object.freeze({ model: h.ctx.model!.id, service_tier: tier });
		assert.equal(h.request(payload), undefined);
		assert.equal(payload.service_tier, tier);
		assert.equal(h.footer(), "fast");
		await h.command("status");
		assert.match(h.notices.at(-1)!, /existing service_tier preserved/);
		await h.command("off");
		assert.equal(h.request(payload), undefined);
		assert.equal("service_tier" in payload, true);
		assert.equal(payload.service_tier, tier);
	});
}

test("checks provider, API, auth, missing model, and exact exclusions", (t) => {
	const h = harness(t, { enabled: true, excludeModels: ["excluded"] });
	const model = { ...h.ctx.model! };
	h.ctx.model!.provider = "openai";
	assert.equal(h.request(), undefined);
	h.ctx.model = { ...model, api: "openai-responses" };
	assert.equal(h.request(), undefined);
	h.ctx.model = { ...model };
	h.ctx.modelRegistry.isUsingOAuth = () => false;
	assert.equal(h.request(), undefined);
	h.ctx.modelRegistry.isUsingOAuth = () => true;
	h.ctx.model!.id = "excluded";
	assert.equal(h.request(), undefined);
	h.ctx.model = undefined;
	assert.equal(h.request(), undefined);
	h.ctx.model = { ...model, id: "excluded-but-not-exact" };
	assert.deepEqual(h.request(), {
		model: "excluded-but-not-exact",
		service_tier: "priority",
	});
});

test("rejected payload details are queryable without changing the enabled badge", async (t) => {
	const h = harness(t);
	assert.equal(h.footer(), "fast");
	for (const payload of [null, [], "body", 42, {}, { model: "another-model" }]) {
		assert.equal(h.request(payload), undefined);
		assert.equal(h.footer(), "fast");
		await h.command("status");
		assert.match(h.notices.at(-1)!, /invalid payload or model mismatch/);
	}
});

test("on/off are idempotent; status and invalid commands do not toggle", async (t) => {
	const h = harness(t, {});
	assert.equal(h.request(), undefined);
	await h.command("on");
	await h.command("on");
	assert.ok(h.request());
	await h.command("status");
	assert.match(h.notices.at(-1)!, /on \(session override\)/);
	assert.match(h.notices.at(-1)!, /Effective backend tier: unknown/);
	await h.command("invalid");
	assert.match(h.notices.at(-1)!, /Usage/);
	assert.ok(h.request());
	await h.command("off");
	await h.command("off");
	assert.equal(h.request(), undefined);
	assert.equal(h.footer(), undefined);
	await h.command("");
	assert.ok(h.request());
	await h.command("");
	assert.equal(h.request(), undefined);
	assert.deepEqual(
		h.complete("o").map((entry) => entry.value),
		["on", "off"],
	);
});

test("model changes clear request observations but retain the override", async (t) => {
	const h = harness(t, { enabled: false });
	await h.command("on");
	h.request();
	assert.equal(h.footer(), "fast");
	h.ctx.model!.provider = "xai";
	h.emit("model_select");
	assert.equal(h.footer(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /on \(session override\)/);
	assert.match(h.notices.at(-1)!, /requires the openai-codex provider/);
	h.ctx.model!.provider = "openai-codex";
	h.emit("model_select");
	assert.equal(h.footer(), "fast");
	await h.command("status");
	assert.doesNotMatch(h.notices.at(-1)!, /Last request handling/);
	assert.ok(h.request());
});

test("session start/reload/resume reset overrides and reread config", async (t) => {
	const h = harness(t);
	await h.command("off");
	assert.equal(h.request(), undefined);
	h.emit("session_start");
	assert.ok(h.request());
	writeFileSync(h.configPath, JSON.stringify({ enabled: false }));
	h.emit("session_start");
	assert.equal(h.request(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /off \(global config\)/);
	assert.doesNotMatch(h.notices.at(-1)!, /added service_tier/);
});

test("session state is isolated and shutdown clears its footer and override", async (t) => {
	const h = harness(t, { enabled: false });
	await h.command("on");
	const second = { ...h.ctx, sessionManager: {} } as ExtensionContext;
	h.emit("session_start", undefined, second);
	assert.equal(
		h.emit("before_provider_request", { model: second.model!.id }, second),
		undefined,
	);
	assert.ok(h.request());
	h.emit("session_shutdown");
	assert.equal(h.footer(), undefined);
	h.emit("session_start");
	assert.equal(h.request(), undefined);
});

test("footer only shows fast when enabled and eligible", async (t) => {
	const h = harness(t, { enabled: true, excludeModels: ["excluded"] });
	assert.equal(h.footer(), "fast");
	const original = { ...h.ctx.model! };
	for (const model of [
		{ ...original, provider: "openai" },
		{ ...original, api: "openai-responses" },
		{ ...original, id: "excluded" },
		undefined,
	]) {
		h.ctx.model = model;
		h.emit("model_select");
		assert.equal(h.footer(), undefined);
		await h.command("status");
		assert.match(h.notices.at(-1)!, /No injection:/);
	}
	h.ctx.model = original;
	h.ctx.modelRegistry.isUsingOAuth = () => false;
	h.emit("model_select");
	assert.equal(h.footer(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /requires ChatGPT OAuth/);
	h.ctx.modelRegistry.isUsingOAuth = () => true;
	h.emit("model_select");
	assert.equal(h.footer(), "fast");
	await h.command("off");
	assert.equal(h.footer(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /off \(session override\)/);
	assert.equal(h.footer(), undefined);
});

test("showStatus=false and non-UI requests do not affect injection", (t) => {
	const h = harness(t, { enabled: true, showStatus: false });
	assert.equal(h.footer(), undefined);
	assert.ok(h.request());
	assert.equal(h.footer(), undefined);
	h.ctx.hasUI = false;
	h.ctx.ui.setStatus = () => {
		throw new Error("must not render without UI");
	};
	assert.ok(h.request());
});

for (const raw of [
	null,
	[],
	{ enabled: "true" },
	{ enabled: true, showStatus: 1 },
	{ enabled: true, excludeModels: "gpt-6" },
	{ enabled: true, excludeModels: [123] },
	{ enabled: true, excludeModels: [""] },
	{ enabled: true, excludeModels: [" gpt-6"] },
	{ enabled: true, excludedModels: ["gpt-6"] },
]) {
	test(`invalid config fails closed: ${JSON.stringify(raw)}`, async (t) => {
		const h = harness(t, raw);
		assert.equal(h.request(), undefined);
		assert.match(h.notices[0], /config is invalid/);
		await h.command("on");
		assert.equal(
			h.request(),
			undefined,
			"on must not bypass invalid exclusion config",
		);
		assert.equal(h.footer(), undefined);
	});
}

test("missing config defaults off; malformed JSON disables injection", async (t) => {
	const h = harness(t);
	rmSync(h.configPath);
	h.emit("session_start");
	assert.equal(h.request(), undefined);
	await h.command("on");
	assert.ok(h.request());
	writeFileSync(h.configPath, "{");
	h.emit("session_start");
	assert.equal(h.request(), undefined);
	assert.match(h.notices.at(-1)!, /config is invalid/);
});

test("request history reports preparation, never server confirmation", async (t) => {
	const h = harness(t);
	h.request();
	await h.command("status");
	assert.match(
		h.notices.at(-1)!,
		/not proof of final transmission or backend confirmation/,
	);
	assert.match(h.notices.at(-1)!, /Effective backend tier: unknown/);
});
