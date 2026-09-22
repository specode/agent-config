import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
type StateFile = {
	version: number;
	providers: Record<string, { enabled: boolean; updatedAt: string }>;
};

const PROXY_URL = "https://cli-chat-proxy.grok.com/v1";
const CLIENT_VERSION = "1.0.40";

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

async function harness(
	t: TestContext,
	raw: unknown = { enabled: true },
	stateRaw?: unknown,
) {
	const dir = mkdtempSync(join(tmpdir(), "pi-fast-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = join(dir, "fast.json");
	const statePath = join(dir, "state", "fast.json");
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
	registerFast(pi, configPath, statePath);
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
	function writeState(value: unknown): void {
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(
			statePath,
			typeof value === "string" ? value : JSON.stringify(value),
		);
	}
	if (stateRaw !== undefined) writeState(stateRaw);
	await emit("session_start");
	return {
		ctx,
		dir,
		emit,
		notices,
		configPath,
		statePath,
		writeState,
		state: (): StateFile | undefined => {
			try {
				return JSON.parse(readFileSync(statePath, "utf8")) as StateFile;
			} catch {
				return undefined;
			}
		},
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
		await h.command("off");
		assert.equal(h.request(payload), undefined);
		assert.equal("service_tier" in payload, true);
		assert.equal(payload.service_tier, tier);
	});
}

test("checks provider, API, auth, and missing model", async (t) => {
	const h = await harness(t);
	const model = { ...h.ctx.model! };
	h.ctx.model!.provider = "openai";
	assert.equal(h.request(), undefined);
	h.ctx.model = { ...model, api: "openai-responses" };
	assert.equal(h.request(), undefined);
	h.ctx.model = { ...model };
	h.ctx.modelRegistry.isUsingOAuth = () => false;
	assert.equal(h.request(), undefined);
	h.ctx.modelRegistry.isUsingOAuth = () => true;
	h.ctx.model = undefined;
	assert.equal(h.request(), undefined);
	h.ctx.model = { ...model };
	assert.ok(h.request());
	assert.equal(h.switches().length, 0);
});

test("a rejected payload is left alone without clearing the enabled badge", async (t) => {
	const h = await harness(t);
	assert.equal(h.footer(), "fast");
	for (const payload of [null, [], "body", 42, {}, { model: "another-model" }]) {
		assert.equal(h.request(payload), undefined);
		assert.equal(h.footer(), "fast");
		await h.command("status");
		assert.equal(h.notices.at(-1), "Fast: on");
	}
});

test("on/off are idempotent; status and invalid commands do not toggle", async (t) => {
	const h = await harness(t, {});
	assert.equal(h.request(), undefined);
	await h.command("on");
	await h.command("on");
	assert.ok(h.request());
	await h.command("status");
	assert.equal(h.notices.at(-1), "Fast: on");
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

test("the switch is saved per provider and survives a restart", async (t) => {
	const h = await harness(t, { enabled: false });
	await h.command("on");
	assert.equal(h.state()?.providers["openai-codex"]?.enabled, true);
	assert.equal("xai" in h.state()!.providers, false);
	await h.emit("session_start");
	assert.ok(h.request(), "saved switch survives a reload");
	await h.command("off");
	assert.equal(h.state()?.providers["openai-codex"]?.enabled, false);
	await h.emit("session_start");
	assert.equal(h.request(), undefined);
});

test("providers keep independent switches and the config default only fills gaps", async (t) => {
	const h = await harness(t, { enabled: true });
	await h.command("off");
	assert.equal(h.request(), undefined, "codex switched off");
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	assert.equal(
		h.ctx.model?.baseUrl,
		PROXY_URL,
		"xai still follows the config default",
	);
	await h.command("status");
	assert.equal(h.notices.at(-1), "Fast: on");
	await h.command("off");
	assert.equal(h.state()?.providers["openai-codex"]?.enabled, false);
	assert.equal(h.state()?.providers.xai?.enabled, false);
});

test("a provider without a fast strategy is never written to the state file", async (t) => {
	const h = await harness(t, { enabled: true });
	h.ctx.model = {
		id: "k3",
		provider: "kimi-coding",
		api: "anthropic-messages",
	} as Model;
	await h.command("on");
	assert.equal(
		h.notices.at(-1),
		"Fast: unavailable (no fast strategy for this provider)",
	);
	assert.equal(h.state(), undefined);
	await h.command("status");
	assert.equal(
		h.notices.at(-1),
		"Fast: unavailable (no fast strategy for this provider)",
	);
	assert.equal(h.footer(), undefined);
});

test("a concurrent writer keeps its own provider entry", async (t) => {
	const h = await harness(t, { enabled: false });
	h.writeState({
		version: 1,
		providers: {
			xai: { enabled: true, updatedAt: "2026-09-22T12:00:00.000Z" },
		},
	});
	await h.command("on");
	assert.equal(h.state()?.providers.xai?.enabled, true);
	assert.equal(h.state()?.providers["openai-codex"]?.enabled, true);
});

test("an unwritable state file keeps the session working and warns", async (t) => {
	const h = await harness(t, { enabled: false });
	writeFileSync(join(h.dir, "state"), "not a directory");
	await h.command("on");
	assert.equal(h.notices.at(-1), "Fast: on, this session only (switch not saved)");
	assert.ok(h.request(), "the switch still applies to this session");
	await h.emit("session_start");
	assert.equal(h.request(), undefined, "nothing was persisted");
});

for (const invalid of [
	"{",
	JSON.stringify({ version: 2, providers: {} }),
	JSON.stringify({ version: 1, providers: { xai: { enabled: "yes" } } }),
	JSON.stringify({ version: 1 }),
]) {
	test(`an invalid state file falls back to the config default: ${invalid.slice(0, 24)}`, async (t) => {
		const h = await harness(t, { enabled: true }, invalid);
		assert.match(h.notices[0]!, /could not read/);
		assert.ok(h.request(), "config default still applies");
		await h.command("off");
		assert.equal(h.request(), undefined);
		assert.equal(h.state()?.providers["openai-codex"]?.enabled, false);
	});
}

test("model changes keep the saved switch", async (t) => {
	const h = await harness(t, { enabled: false });
	await h.command("on");
	h.request();
	assert.equal(h.footer(), "fast");
	h.ctx.model = { id: "k3", provider: "kimi-coding", api: "x" } as Model;
	await h.emit("model_select");
	assert.equal(h.footer(), undefined);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /no fast strategy for this provider/);
	h.ctx.model = {
		id: "gpt-6-astra",
		provider: "openai-codex",
		api: "openai-codex-responses",
	} as Model;
	await h.emit("model_select");
	assert.equal(h.footer(), "fast");
	await h.command("status");
	assert.equal(h.notices.at(-1), "Fast: on");
	assert.ok(h.request());
});

test("session state is isolated and shutdown clears its footer", async (t) => {
	const h = await harness(t, { enabled: false });
	await h.command("on");
	const second = { ...h.ctx, sessionManager: {} } as ExtensionContext;
	await h.emit("session_start", undefined, second);
	assert.ok(
		await h.emit("before_provider_request", { model: second.model!.id }, second),
		"a new session reads the saved switch",
	);
	await h.emit("session_shutdown");
	assert.equal(h.footer(), undefined);
});

test("footer only shows fast when enabled and eligible", async (t) => {
	const h = await harness(t, { enabled: true });
	assert.equal(h.footer(), "fast");
	const original = { ...h.ctx.model! };
	for (const model of [
		{ ...original, provider: "openai" },
		{ ...original, api: "openai-responses" },
		undefined,
	]) {
		h.ctx.model = model;
		await h.emit("model_select");
		assert.equal(h.footer(), undefined);
		await h.command("status");
		assert.match(h.notices.at(-1)!, /^Fast: unavailable \(/);
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
	assert.equal(h.notices.at(-1), "Fast: off");
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
	{ enabled: true, excludeModels: [] },
	{ enabled: true, grokClientVersion: 1 },
	{ enabled: true, grokClientVersion: "1.0.40 (spoofed)" },
	{ enabled: true, enabledModels: ["gpt-6"] },
]) {
	test(`invalid config fails closed: ${JSON.stringify(raw)}`, async (t) => {
		const h = await harness(t, raw);
		assert.equal(h.request(), undefined);
		assert.match(h.notices[0]!, /config is invalid/);
		await h.command("on");
		assert.equal(h.request(), undefined, "on must not bypass an invalid config");
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

test("the command answers with one line and nothing else", async (t) => {
	const h = await harness(t);
	h.request();
	for (const action of ["status", "off", "on", ""]) {
		await h.command(action);
		assert.match(h.notices.at(-1)!, /^Fast: (on|off)$/);
	}
});

test("an unsupported model reports failure and drops a stale saved switch", async (t) => {
	const h = await harness(t, { enabled: false });
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.command("on");
	assert.equal(h.state()?.providers.xai?.enabled, true);
	h.ctx.model = { ...grokBase(), id: "grok-4.6" } as Model;
	await h.emit("model_select");
	await h.command("");
	assert.equal(
		h.notices.at(-1),
		"Fast: unavailable (only xai/grok-4.7 has a fast variant on this provider)",
	);
	assert.equal(
		h.state()?.providers.xai?.enabled,
		false,
		"the stale switch is overwritten, not left claiming fast",
	);
	await h.command("");
	assert.equal(h.footer(), undefined);
});

test("a broken config reports failure without touching the saved switch", async (t) => {
	const h = await harness(t, { enabled: false });
	await h.command("on");
	writeFileSync(h.configPath, "{");
	await h.emit("session_start");
	assert.equal(
		h.notices.at(-1),
		"Fast: unavailable (config is invalid; fix fast.json and /reload)",
	);
	await h.command("");
	assert.match(h.notices.at(-1)!, /^Fast: unavailable \(config is invalid/);
	assert.equal(
		h.state()?.providers["openai-codex"]?.enabled,
		true,
		"a config failure is not stale switch state",
	);
});

test("Grok keeps the catalog id and only swaps the transport", async (t) => {
	const h = await harness(t);
	const base = grokBase();
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = base;
	await h.emit("model_select");
	assert.equal(h.switches().length, 1);
	const selected = h.switches()[0]!;
	assert.equal(selected.id, "grok-4.7", "never selects a model outside the catalog");
	assert.equal(selected.provider, "xai");
	assert.equal(selected.name, "Grok 4.7");
	assert.equal(selected.baseUrl, PROXY_URL);
	assert.equal(selected.api, "openai-responses");
	assert.deepEqual(selected.headers, {
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-model-override": "grok-4.7-build-fast",
		"x-authenticateresponse": "authenticate-response",
		"x-grok-client-identifier": "grok-shell",
		"x-grok-client-version": CLIENT_VERSION,
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
		model: "grok-4.7",
		reasoning: { effort: "xhigh" },
	});
	assert.deepEqual(h.request(payload), {
		model: "grok-4.7-build-fast",
		reasoning: { effort: "xhigh" },
	});
	assert.equal("service_tier" in payload, false);
	await h.command("status");
	assert.equal(h.notices.at(-1), "Fast: on");
	await h.emit("before_agent_start");
	assert.equal(h.switches().length, 1, "an applied transport is not reapplied");
});

test("a configured client version reaches the proxy transport and headers", async (t) => {
	const h = await harness(t, { enabled: true, grokClientVersion: "1.2.3" });
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	assert.equal(h.switches()[0]?.headers?.["x-grok-client-version"], "1.2.3");
	const headers: Record<string, string | null> = {};
	h.headers(headers);
	assert.equal(headers["x-grok-client-version"], "1.2.3");
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
	assert.equal(headers["x-grok-client-identifier"], "grok-shell");
	assert.equal(headers["x-grok-client-version"], CLIENT_VERSION);
	assert.equal(headers["x-session-id"], "keep");
});

test("fast off restores the public transport and stops proxy headers", async (t) => {
	const h = await harness(t);
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	await h.command("off");
	assert.equal(h.switches().at(-1)?.id, "grok-4.7");
	assert.equal(h.switches().at(-1)?.baseUrl, "https://api.x.ai/v1");
	assert.equal(h.ctx.model?.baseUrl, "https://api.x.ai/v1");
	assert.equal(h.ctx.model?.cost?.input, 2);
	assert.equal(h.footer(), undefined);
	const headers: Record<string, string | null> = {};
	h.headers(headers);
	assert.equal(Object.keys(headers).length, 0);
	await h.command("off");
	assert.equal(h.switches().length, 2, "an already clean model is left alone");
	assert.equal(h.request({ model: "grok-4.7" }), undefined);
});

test("Grok fast does not apply without xAI OAuth", async (t) => {
	const h = await harness(t);
	h.ctx.model = grokBase();
	h.ctx.modelRegistry.isUsingOAuth = () => false;
	await h.emit("model_select");
	assert.equal(h.switches().length, 0);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /requires xAI OAuth/);
	assert.equal(h.footer(), undefined);
});

test("failed transport swap does not claim fast or rewrite the public API", async (t) => {
	const h = await harness(t);
	h.failSwitch();
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	assert.equal(h.ctx.model?.baseUrl, "https://api.x.ai/v1");
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
	} as Model;
	const payload = Object.freeze({ model: "grok-4.7-build-fast", input: [] });
	assert.deepEqual(h.request(payload), {
		model: "grok-4.7",
		input: [],
	});
	const headers: Record<string, string | null> = {};
	h.headers(headers);
	assert.equal("x-grok-model-override" in headers, false);
});

test("a legacy fast-id session is healed back to the catalog id", async (t) => {
	const h = await harness(t);
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = {
		...grokBase(),
		id: "grok-4.7-build-fast",
		name: "Grok 4.7 Fast",
		baseUrl: PROXY_URL,
		headers: {
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-model-override": "grok-4.7-build-fast",
		},
	} as Model;
	await h.emit("model_select");
	assert.equal(h.ctx.model?.id, "grok-4.7");
	assert.equal(h.ctx.model?.baseUrl, PROXY_URL);
	assert.equal(h.footer(), "fast");
	await h.command("off");
	assert.equal(h.ctx.model?.id, "grok-4.7");
	assert.equal(h.ctx.model?.baseUrl, "https://api.x.ai/v1");
});

test("an already proxied model without the client version is corrected", async (t) => {
	const h = await harness(t);
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = {
		...grokBase(),
		baseUrl: PROXY_URL,
		headers: {
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-model-override": "grok-4.7-build-fast",
		},
	} as Model;
	await h.emit("model_select");
	assert.equal(h.switches().length, 1);
	assert.equal(h.ctx.model?.headers?.["x-grok-client-version"], CLIENT_VERSION);
	assert.equal(h.ctx.model?.cost?.input, 4, "the base price is not doubled twice");
});

test("model_select during setModel does not recurse", async (t) => {
	const h = await harness(t);
	h.reenterOnSwitch();
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.model = grokBase();
	await h.emit("model_select");
	assert.equal(h.switches().length, 1);
	assert.equal(h.ctx.model?.baseUrl, PROXY_URL);
});

test("a busy turn defers the Grok transport until the next turn", async (t) => {
	const h = await harness(t, { enabled: false });
	h.ctx.model = grokBase();
	h.ctx.modelRegistry.find = () => grokBase();
	h.ctx.isIdle = () => false;
	await h.command("on");
	assert.equal(h.switches().length, 0);
	assert.equal(h.notices.at(-1), "Fast: on, applies from the next turn");
	assert.equal(h.state()?.providers.xai?.enabled, true, "the switch is saved now");
	h.ctx.isIdle = () => true;
	await h.emit("before_agent_start");
	assert.equal(h.ctx.model?.baseUrl, PROXY_URL);
	assert.equal(h.footer(), "fast");
});

test("other Grok models and APIs are left unchanged", async (t) => {
	const h = await harness(t);
	h.ctx.model = { ...grokBase(), id: "grok-4.6" } as Model;
	await h.emit("model_select");
	await h.command("status");
	assert.match(h.notices.at(-1)!, /only xai\/grok-4\.7 has a fast variant/);
	assert.match(h.notices.at(-1)!, /^Fast: unavailable \(/);
	h.ctx.model = { ...grokBase(), api: "openai-completions" } as Model;
	await h.emit("model_select");
	assert.equal(h.switches().length, 0);
	assert.equal(h.footer(), undefined);
	assert.equal(h.request({ model: "grok-4.6" }), undefined);
});
