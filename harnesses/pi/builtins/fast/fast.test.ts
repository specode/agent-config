import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerFast } from "./runtime.ts";

type Handler = (event: { payload?: unknown; headers?: unknown }, ctx: ExtensionContext) => unknown;
type Command = {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
	getArgumentCompletions: (prefix: string) => { value: string; label: string }[];
};
type Model = NonNullable<ExtensionContext["model"]> & {
	baseUrl?: string;
	headers?: Record<string, string>;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: Array<Record<string, number>>;
	};
	thinkingLevelMap?: Record<string, string | null>;
};

function grokBase(): Model {
	return {
		id: "grok-4.7",
		name: "Grok 4.7",
		provider: "xai",
		api: "openai-responses",
		baseUrl: "https://api.x.ai/v1",
		thinkingLevelMap: {
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
		},
		cost: {
			input: 2,
			output: 6,
			cacheRead: 0.5,
			cacheWrite: 0,
			tiers: [
				{
					inputTokensAbove: 200000,
					input: 4,
					output: 12,
					cacheRead: 1,
					cacheWrite: 0,
				},
			],
		},
	} as Model;
}

async function harness(t: TestContext, raw: unknown = { enabled: true }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-fast-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = join(dir, "fast.json");
	if (raw !== undefined) writeFileSync(configPath, JSON.stringify(raw));
	const handlers = new Map<string, Handler>();
	let command!: Command;
	let footer: string | undefined;
	let allowSwitch = true;
	let reenter = false;
	const notices: string[] = [];
	const switches: Model[] = [];
	const ctx = {
		model: {
			id: "gpt-6-astra",
			provider: "openai-codex",
			api: "openai-codex-responses",
		},
		modelRegistry: {
			isUsingOAuth: () => true,
			find: () => undefined,
		},
		sessionManager: {},
		hasUI: true,
		isIdle: () => true,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				assert.equal(key, "fast");
				footer = text;
			},
			notify: (text: string) => notices.push(text),
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, value: Command) => {
			assert.equal(name, "fast");
			command = value;
		},
		setModel: async (model: Model) => {
			switches.push(model);
			if (!allowSwitch) return false;
			ctx.model = model;
			if (reenter) {
				reenter = false;
				await handlers.get("model_select")?.({}, ctx);
			}
			return true;
		},
	} as unknown as ExtensionAPI;
	registerFast(pi, configPath);
	function call(event: string, payload?: unknown, context = ctx) {
		const handler = handlers.get(event);
		assert.ok(handler, `registered ${event}`);
		if (event === "before_provider_headers")
			return handler({ headers: payload }, context);
		return handler({ payload }, context);
	}
	async function emit(event: string, payload?: unknown, context = ctx) {
		return await call(event, payload, context);
	}
	await emit("session_start");
	return {
		ctx,
		emit,
		notices,
		configPath,
		command: (args: string, context = ctx) => command.handler(args, context),
		complete: (prefix: string) => command.getArgumentCompletions(prefix),
		footer: () => footer,
		switches: () => switches,
		failSwitch: () => {
			allowSwitch = false;
		},
		reenterOnSwitch: () => {
			reenter = true;
		},
		request: (payload: unknown = { model: ctx.model?.id }) =>
			call("before_provider_request", payload),
		headers: (headers: Record<string, string | null>) =>
			call("before_provider_headers", headers),
	};
}

for (const model of [
	"gpt-5.4",
	"gpt-5.5",
	"gpt-6",
	"gpt-6-astra",
	"future-model",
]) {
	test(`injects priority without a model allowlist: ${model}`, async (t) => {
		const h = await harness(t);
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
		assert.equal(h.switches().length, 0);
	});
}

for (const tier of ["auto", "default", "priority", "flex", null, undefined]) {
	test(`preserves existing service_tier including ${tier}`, async (t) => {
		const h = await harness(t);
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

test("checks provider, API, auth, missing model, and exact exclusions", async (t) => {
	const h = await harness(t, { enabled: true, excludeModels: ["excluded"] });
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
	assert.equal(h.switches().length, 0);
});

test("rejected payload details are queryable without changing the enabled badge", async (t) => {
	const h = await harness(t);
	assert.equal(h.footer(), "fast");
	for (const payload of [null, [], "body", 42, {}, { model: "another-model" }]) {
		assert.equal(h.request(payload), undefined);
		assert.equal(h.footer(), "fast");
		await h.command("status");
		assert.match(h.notices.at(-1)!, /invalid payload or model mismatch/);
	}
});

test("on/off are idempotent; status and invalid commands do not toggle", async (t) => {
	const h = await harness(t, {});
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
	const h = await harness(t, { enabled: false });
	await h.command("on");
	h.request();
	assert.equal(h.footer(), "fast");
	h.ctx.model!.provider = "xai";
	await h.emit("model_select");
	assert.equal(h.footer(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /on \(session override\)/);
	assert.match(h.notices.at(-1)!, /no fast strategy for this model/);
	h.ctx.model!.provider = "openai-codex";
	await h.emit("model_select");
	assert.equal(h.footer(), "fast");
	await h.command("status");
	assert.doesNotMatch(h.notices.at(-1)!, /Last request handling/);
	assert.ok(h.request());
});

test("session start/reload/resume reset overrides and reread config", async (t) => {
	const h = await harness(t);
	await h.command("off");
	assert.equal(h.request(), undefined);
	await h.emit("session_start");
	assert.ok(h.request());
	writeFileSync(h.configPath, JSON.stringify({ enabled: false }));
	await h.emit("session_start");
	assert.equal(h.request(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /off \(global config\)/);
	assert.doesNotMatch(h.notices.at(-1)!, /added service_tier/);
});

test("session state is isolated and shutdown clears its footer and override", async (t) => {
	const h = await harness(t, { enabled: false });
	await h.command("on");
	const second = { ...h.ctx, sessionManager: {} } as ExtensionContext;
	await h.emit("session_start", undefined, second);
	assert.equal(
		await h.emit("before_provider_request", { model: second.model!.id }, second),
		undefined,
	);
	assert.ok(h.request());
	await h.emit("session_shutdown");
	assert.equal(h.footer(), undefined);
	await h.emit("session_start");
	assert.equal(h.request(), undefined);
});

test("footer only shows fast when enabled and eligible", async (t) => {
	const h = await harness(t, { enabled: true, excludeModels: ["excluded"] });
	assert.equal(h.footer(), "fast");
	const original = { ...h.ctx.model! };
	for (const model of [
		{ ...original, provider: "openai" },
		{ ...original, api: "openai-responses" },
		{ ...original, id: "excluded" },
		undefined,
	]) {
		h.ctx.model = model;
		await h.emit("model_select");
		assert.equal(h.footer(), undefined);
		await h.command("status");
		assert.match(h.notices.at(-1)!, /No fast action:/);
	}
	h.ctx.model = original;
	h.ctx.modelRegistry.isUsingOAuth = () => false;
	await h.emit("model_select");
	assert.equal(h.footer(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /requires ChatGPT OAuth/);
	h.ctx.modelRegistry.isUsingOAuth = () => true;
	await h.emit("model_select");
	assert.equal(h.footer(), "fast");
	await h.command("off");
	assert.equal(h.footer(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /off \(session override\)/);
	assert.equal(h.footer(), undefined);
});

test("showStatus=false and non-UI requests do not affect injection", async (t) => {
	const h = await harness(t, { enabled: true, showStatus: false });
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
		const h = await harness(t, raw);
		assert.equal(h.request(), undefined);
		assert.match(h.notices[0], /config is invalid/);
		await h.command("on");
		assert.equal(
			h.request(),
			undefined,
			"on must not bypass invalid exclusion config",
		);
		assert.equal(h.footer(), undefined);
		assert.equal(h.switches().length, 0);
	});
}

test("missing config defaults off; malformed JSON disables injection", async (t) => {
	const h = await harness(t);
	rmSync(h.configPath);
	await h.emit("session_start");
	assert.equal(h.request(), undefined);
	await h.command("on");
	assert.ok(h.request());
	writeFileSync(h.configPath, "{");
	await h.emit("session_start");
	assert.equal(h.request(), undefined);
	assert.match(h.notices.at(-1)!, /config is invalid/);
});

test("request history reports preparation, never server confirmation", async (t) => {
	const h = await harness(t);
	h.request();
	await h.command("status");
	assert.match(
		h.notices.at(-1)!,
		/not proof of final transmission or backend confirmation/,
	);
	assert.match(h.notices.at(-1)!, /Effective backend tier: unknown/);
});

test("switches Grok 4.7 to the proxy fast model without adding service_tier", async (t) => {
	const h = await harness(t);
	const base = grokBase();
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = base;
	await h.emit("model_select");
	assert.equal(h.switches().length, 1);
	const selected = h.switches()[0]!;
	assert.equal(selected.id, "grok-4.7-build-fast");
	assert.equal(selected.name, "Grok 4.7 Fast");
	assert.equal(selected.baseUrl, "https://cli-chat-proxy.grok.com/v1");
	assert.equal(selected.api, "openai-responses");
	assert.deepEqual(selected.headers, {
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-model-override": "grok-4.7-build-fast",
		"x-authenticateresponse": "authenticate-response",
	});
	assert.equal(selected.cost?.input, 4);
	assert.equal(selected.cost?.output, 12);
	assert.equal(selected.cost?.cacheRead, 1);
	assert.equal(selected.cost?.tiers?.[0]?.input, 8);
	assert.equal(selected.cost?.tiers?.[0]?.inputTokensAbove, 200000);
	assert.equal(base.cost?.input, 2);
	assert.equal(selected.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(h.footer(), "fast");
	const payload = Object.freeze({
		model: "grok-4.7-build-fast",
		reasoning: { effort: "xhigh" },
	});
	assert.equal(h.request(payload), undefined);
	assert.equal("service_tier" in payload, false);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /Proxy acceptance: unknown/);
	assert.match(h.notices.at(-1)!, /2x catalog rate/);
});

test("proxy header hook replaces a mismatched model override", async (t) => {
	const h = await harness(t);
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	const headers: Record<string, string | null> = {
		"X-Grok-Model-Override": "grok-4.7",
		"x-session-id": "keep",
	};
	h.headers(headers);
	assert.equal(headers["x-grok-model-override"], "grok-4.7-build-fast");
	assert.equal("X-Grok-Model-Override" in headers, false);
	assert.equal(headers["X-XAI-Token-Auth"], "xai-grok-cli");
	assert.equal(headers["x-authenticateresponse"], "authenticate-response");
	assert.equal(headers["x-session-id"], "keep");
});

test("fast off restores the catalog Grok model and stops proxy headers", async (t) => {
	const h = await harness(t);
	const base = grokBase();
	h.ctx.modelRegistry.find = () => base;
	h.ctx.model = grokBase();
	await h.emit("model_select");
	await h.command("off");
	assert.equal(h.switches().at(-1)?.id, "grok-4.7");
	assert.equal(h.ctx.model?.id, "grok-4.7");
	assert.equal(h.footer(), undefined);
	const headers: Record<string, string | null> = {};
	h.headers(headers);
	assert.equal(Object.keys(headers).length, 0);
	await h.command("off");
	assert.equal(h.switches().length, 2);
});

test("Grok fast does not switch without OAuth or when excluded", async (t) => {
	const h = await harness(t, {
		enabled: true,
		excludeModels: ["grok-4.7-build-fast"],
	});
	h.ctx.model = grokBase();
	h.ctx.modelRegistry.isUsingOAuth = () => false;
	await h.emit("model_select");
	assert.equal(h.switches().length, 0);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /requires xAI OAuth/);
	h.ctx.modelRegistry.isUsingOAuth = () => true;
	await h.emit("model_select");
	assert.equal(h.switches().length, 0);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /excludeModels/);
});

test("failed model switch does not claim fast or rewrite the public API", async (t) => {
	const h = await harness(t);
	h.failSwitch();
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	assert.equal(h.ctx.model?.id, "grok-4.7");
	assert.equal(h.footer(), undefined);
	assert.equal(h.request({ model: "grok-4.7" }), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /setModel returned false/);
});

test("refuses to send the fast model id to the public xAI API", async (t) => {
	const h = await harness(t);
	h.ctx.model = {
		...grokBase(),
		id: "grok-4.7-build-fast",
		baseUrl: "https://api.x.ai/v1",
	} as ExtensionContext["model"];
	const payload = Object.freeze({ model: "grok-4.7-build-fast", input: [] });
	assert.deepEqual(h.request(payload), {
		model: "grok-4.7",
		input: [],
	});
	const headers: Record<string, string | null> = {};
	h.headers(headers);
	assert.equal("x-grok-model-override" in headers, false);
});

test("rewrites only a proxy request that still carries the standard model id", async (t) => {
	const h = await harness(t);
	h.ctx.model = {
		...grokBase(),
		id: "grok-4.7-build-fast",
		name: "Grok 4.7 Fast",
		baseUrl: "https://cli-chat-proxy.grok.com/v1",
		headers: {
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-model-override": "grok-4.7-build-fast",
		},
	} as ExtensionContext["model"];
	await h.emit("model_select");
	assert.equal(h.switches().length, 0);
	assert.deepEqual(h.request({ model: "grok-4.7", store: false }), {
		model: "grok-4.7-build-fast",
		store: false,
	});
});

test("model_select during setModel does not recurse", async (t) => {
	const h = await harness(t);
	h.reenterOnSwitch();
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	assert.equal(h.switches().length, 1);
	assert.equal(h.ctx.model?.id, "grok-4.7-build-fast");
});

test("a busy turn defers the Grok switch until the next turn", async (t) => {
	const h = await harness(t, { enabled: false });
	h.ctx.model = grokBase();
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.isIdle = () => false;
	await h.command("on");
	assert.equal(h.switches().length, 0);
	assert.match(h.notices.at(-1)!, /deferred/);
	h.ctx.isIdle = () => true;
	await h.emit("before_agent_start");
	assert.equal(h.ctx.model?.id, "grok-4.7-build-fast");
	assert.equal(h.footer(), "fast");
});

test("reload returns to config and can switch Grok again", async (t) => {
	const h = await harness(t);
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	await h.command("off");
	assert.equal(h.ctx.model?.id, "grok-4.7");
	await h.emit("session_start");
	assert.equal(h.ctx.model?.id, "grok-4.7-build-fast");
	await h.command("status");
	assert.match(h.notices.at(-1)!, /on \(global config\)/);
});

test("corrects a restored fast id onto the proxy without another model change", async (t) => {
	const h = await harness(t);
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = {
		...grokBase(),
		id: "grok-4.7-build-fast",
		baseUrl: "https://api.x.ai/v1",
	} as ExtensionContext["model"];
	await h.emit("model_select");
	assert.equal(h.switches().length, 0);
	assert.equal(h.ctx.model?.baseUrl, "https://cli-chat-proxy.grok.com/v1");
	assert.equal(h.ctx.model?.cost && "input" in h.ctx.model.cost ? h.ctx.model.cost.input : undefined, 4);
	assert.equal(h.footer(), "fast");
});

test("other Grok models and APIs are left unchanged", async (t) => {
	const h = await harness(t);
	h.ctx.model = { ...grokBase(), id: "grok-4.6" } as ExtensionContext["model"];
	await h.emit("model_select");
	h.ctx.model = { ...grokBase(), api: "openai-completions" } as ExtensionContext["model"];
	await h.emit("model_select");
	assert.equal(h.switches().length, 0);
	assert.equal(h.footer(), undefined);
});
