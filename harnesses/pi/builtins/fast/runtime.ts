import { readFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "fast";
const USAGE = "Usage: /fast [on|off|status]";
const GROK_PROVIDER = "xai";
const GROK_API = "openai-responses";
const GROK_BASE_ID = "grok-4.7";
const GROK_FAST_ID = "grok-4.7-build-fast";
const GROK_PUBLIC_URL = "https://api.x.ai/v1";
const GROK_PROXY_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_PRICE_MULTIPLIER = 2;
const PROXY_HEADERS = {
	"X-XAI-Token-Auth": "xai-grok-cli",
	"x-grok-model-override": GROK_FAST_ID,
	"x-authenticateresponse": "authenticate-response",
} as const;

type Cost = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<Record<string, unknown>>;
};
type ModelLike = {
	id: string;
	provider: string;
	api: string;
	name?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	cost?: Cost;
	thinkingLevelMap?: Record<string, string | null>;
	[key: string]: unknown;
};
type Config = {
	enabled: boolean;
	showStatus: boolean;
	excludeModels: string[];
};
type State = {
	config: Config;
	warning?: string;
	override?: boolean;
	applying: boolean;
	deferred: boolean;
	baseSnapshot?: ModelLike;
	lastSwitch?: string;
	lastRequest?: {
		modelKey: string;
		detail: string;
	};
};
type HeaderMap = Record<string, string | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModel(value: unknown): value is ModelLike {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.provider === "string" &&
		typeof value.api === "string"
	);
}

function loadConfig(path: string): Pick<State, "config" | "warning"> {
	const defaults: Config = {
		enabled: false,
		showStatus: true,
		excludeModels: [],
	};
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(raw)) throw new Error("Config must be a JSON object");
		for (const key of Object.keys(raw)) {
			if (!Object.hasOwn(defaults, key))
				throw new Error(`Unknown config field: ${key}`);
		}
		for (const key of ["enabled", "showStatus"] as const) {
			if (key in raw && typeof raw[key] !== "boolean")
				throw new Error(`${key} must be a boolean`);
		}
		if (
			"excludeModels" in raw &&
			(!Array.isArray(raw.excludeModels) ||
				!raw.excludeModels.every(
					(id) => typeof id === "string" && id.length > 0 && id.trim() === id,
				))
		) {
			throw new Error(
				"excludeModels must be an array of non-empty model IDs (exact matches)",
			);
		}
		return {
			config: {
				enabled: (raw.enabled as boolean | undefined) ?? defaults.enabled,
				showStatus: (raw.showStatus as boolean | undefined) ?? defaults.showStatus,
				excludeModels:
					(raw.excludeModels as string[] | undefined) ?? defaults.excludeModels,
			},
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { config: defaults };
		return {
			config: defaults,
			warning:
				"Fast config is invalid or unreadable; fast mode disabled. Fix fast.json and /reload",
		};
	}
}

function modelKey(ctx: ExtensionContext): string {
	return ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: "no model selected";
}

function enabled(state: State): boolean {
	return state.override ?? state.config.enabled;
}

function headerValue(
	headers: Record<string, string> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const key = Object.keys(headers).find(
		(candidate) => candidate.toLowerCase() === name.toLowerCase(),
	);
	return key ? headers[key] : undefined;
}

function setHeader(headers: HeaderMap, name: string, value: string): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name.toLowerCase() && key !== name)
			delete headers[key];
	}
	headers[name] = value;
}

function scaleCost(cost: Cost | undefined, factor: number): Cost | undefined {
	if (!cost) return undefined;
	const next: Cost = { ...cost };
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (typeof next[key] === "number") next[key] *= factor;
	}
	if (Array.isArray(cost.tiers)) {
		next.tiers = cost.tiers.map((tier) => {
			const copy = { ...tier };
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				if (typeof copy[key] === "number") copy[key] *= factor;
			}
			return copy;
		});
	}
	return next;
}

function cloneModel(model: ModelLike): ModelLike {
	return {
		...model,
		thinkingLevelMap: model.thinkingLevelMap
			? { ...model.thinkingLevelMap }
			: undefined,
		headers: model.headers ? { ...model.headers } : undefined,
		cost: model.cost ? scaleCost(model.cost, 1) : undefined,
		input: Array.isArray(model.input) ? [...model.input] : model.input,
	};
}

function isGrokPair(model: ModelLike | undefined): boolean {
	return (
		model?.provider === GROK_PROVIDER &&
		model.api === GROK_API &&
		(model.id === GROK_BASE_ID || model.id === GROK_FAST_ID)
	);
}

function transportReady(model: ModelLike | undefined): boolean {
	return (
		model?.id === GROK_FAST_ID &&
		model.baseUrl === GROK_PROXY_URL &&
		headerValue(model.headers, "x-grok-model-override") === GROK_FAST_ID &&
		headerValue(model.headers, "x-xai-token-auth") === "xai-grok-cli"
	);
}

function excluded(state: State, id: string): boolean {
	return state.config.excludeModels.includes(id);
}

function codexReason(
	ctx: ExtensionContext,
	state: State,
): string | undefined {
	if (!ctx.model || ctx.model.provider !== "openai-codex") return undefined;
	if (ctx.model.api !== "openai-codex-responses")
		return "requires the openai-codex-responses API";
	if (!ctx.modelRegistry.isUsingOAuth(ctx.model))
		return "requires ChatGPT OAuth, not API-key auth";
	if (excluded(state, ctx.model.id)) return "current model is in excludeModels";
	return undefined;
}

function grokReason(
	ctx: ExtensionContext,
	state: State,
): string | undefined {
	if (!isGrokPair(ctx.model as ModelLike | undefined)) return undefined;
	if (!ctx.modelRegistry.isUsingOAuth(ctx.model!))
		return "Grok fast requires xAI OAuth, not API-key auth";
	if (
		excluded(state, GROK_BASE_ID) ||
		excluded(state, GROK_FAST_ID) ||
		excluded(state, ctx.model!.id)
	) {
		return "current model is in excludeModels";
	}
	return undefined;
}

function inactiveReason(
	ctx: ExtensionContext,
	state: State,
): string | undefined {
	if (state.warning) return state.warning;
	if (!ctx.model) return "no model selected";
	const codex = codexReason(ctx, state);
	if (ctx.model.provider === "openai-codex") return codex;
	const grok = grokReason(ctx, state);
	if (isGrokPair(ctx.model as ModelLike)) return grok;
	return "no fast strategy for this model";
}

function rememberBase(ctx: ExtensionContext, state: State): void {
	const model = ctx.model as ModelLike | undefined;
	if (model?.provider === GROK_PROVIDER && model.id === GROK_BASE_ID)
		state.baseSnapshot = cloneModel(model);
}

function findBase(ctx: ExtensionContext, state: State): ModelLike | undefined {
	const registry = ctx.modelRegistry as {
		find?: (provider: string, id: string) => ModelLike | undefined;
	};
	const found = registry.find?.(GROK_PROVIDER, GROK_BASE_ID);
	if (found) return cloneModel(found);
	if (state.baseSnapshot) return cloneModel(state.baseSnapshot);
	const current = ctx.model as ModelLike | undefined;
	if (current?.id !== GROK_FAST_ID) return undefined;
	const restored = cloneModel(current);
	restored.id = GROK_BASE_ID;
	restored.name = "Grok 4.7";
	restored.baseUrl = GROK_PUBLIC_URL;
	restored.headers = undefined;
	if (current.baseUrl === GROK_PROXY_URL)
		restored.cost = scaleCost(current.cost, 1 / GROK_PRICE_MULTIPLIER);
	return restored;
}

function fastModel(base: ModelLike): ModelLike {
	const next = cloneModel(base);
	next.id = GROK_FAST_ID;
	next.name = "Grok 4.7 Fast";
	next.provider = GROK_PROVIDER;
	next.api = GROK_API;
	next.baseUrl = GROK_PROXY_URL;
	next.headers = { ...PROXY_HEADERS };
	next.cost = scaleCost(base.cost, GROK_PRICE_MULTIPLIER);
	return next;
}

function applyFastTransport(target: ModelLike, base: ModelLike): void {
	const desired = fastModel(base);
	target.baseUrl = desired.baseUrl;
	target.name = desired.name;
	target.api = desired.api;
	target.headers = desired.headers;
	target.cost = desired.cost;
}

function statusMessage(ctx: ExtensionContext, state: State): string {
	const reason = inactiveReason(ctx, state);
	const mode = enabled(state) ? "on" : "off";
	const source =
		state.override === undefined ? "global config" : "session override";
	const lines = [`Fast: ${mode} (${source}); ${modelKey(ctx)}`];
	if (state.deferred)
		lines.push("Model switch is deferred until the agent is idle");
	if (reason) lines.push(`No fast action: ${reason}`);
	else if (!enabled(state))
		lines.push(
			"This extension does not add or remove service_tier, and does not keep a Grok fast model selected",
		);
	else if (ctx.model?.provider === "openai-codex")
		lines.push(
			"Will add priority when service_tier is absent; this may increase quota consumption",
		);
	else if (isGrokPair(ctx.model as ModelLike))
		lines.push(
			"Will use grok-4.7-build-fast on the Grok Build proxy at 2x catalog rate; this may increase quota consumption",
		);
	if (state.lastSwitch) lines.push(`Last model switch: ${state.lastSwitch}`);
	if (state.lastRequest)
		lines.push(
			`Last request handling (${state.lastRequest.modelKey}): ${state.lastRequest.detail}`,
		);
	if (ctx.model?.provider === "openai-codex")
		lines.push(
			"Effective backend tier: unknown (the current Pi extension API does not expose response-body service_tier)",
		);
	else if (isGrokPair(ctx.model as ModelLike))
		lines.push(
			"Proxy acceptance: unknown (a model switch is not confirmation that the proxy accepted the token)",
		);
	return lines.join("\n");
}

function updateStatus(ctx: ExtensionContext, state: State): void {
	if (!ctx.hasUI) return;
	const model = ctx.model as ModelLike | undefined;
	const active =
		state.config.showStatus &&
		enabled(state) &&
		!inactiveReason(ctx, state) &&
		(model?.provider === "openai-codex" || transportReady(model));
	ctx.ui.setStatus(STATUS_KEY, active ? "fast" : undefined);
}

function requestDetail(
	payload: unknown,
	ctx: ExtensionContext,
	state: State,
): { result?: Record<string, unknown>; detail: string } {
	const reason = inactiveReason(ctx, state);
	const model = ctx.model as ModelLike | undefined;
	if (!enabled(state) || reason) {
		if (
			isRecord(payload) &&
			payload.model === GROK_FAST_ID &&
			model?.baseUrl !== GROK_PROXY_URL
		) {
			return {
				result: { ...payload, model: GROK_BASE_ID },
				detail:
					"refused to send the fast model id to a non-proxy endpoint; request model reset to grok-4.7",
			};
		}
		return {
			detail: reason ?? "switch is off; request unchanged",
		};
	}
	if (model?.provider === "openai-codex") {
		if (!isRecord(payload) || payload.model !== model.id)
			return { detail: "invalid payload or model mismatch; request unchanged" };
		if ("service_tier" in payload)
			return {
				detail:
					"existing service_tier preserved; not overwritten by this extension",
			};
		return {
			result: { ...payload, service_tier: "priority" },
			detail:
				"added service_tier=priority (not proof of final transmission or backend confirmation)",
		};
	}
	if (!isGrokPair(model))
		return { detail: "no fast strategy for this model" };
	if (!isRecord(payload))
		return { detail: "invalid payload; request unchanged" };
	if (model?.baseUrl !== GROK_PROXY_URL) {
		if (payload.model === GROK_FAST_ID)
			return {
				result: { ...payload, model: GROK_BASE_ID },
				detail:
					"refused to send the fast model id to the public xAI API; request model reset to grok-4.7",
			};
		return {
			detail: "Grok fast transport is not active; request unchanged",
		};
	}
	if (payload.model === GROK_BASE_ID)
		return {
			result: { ...payload, model: GROK_FAST_ID },
			detail:
				"rewrote model id to grok-4.7-build-fast on the proxy request (not proof the proxy accepted it)",
		};
	if (payload.model === GROK_FAST_ID)
		return {
			detail:
				"fast model id already set (not proof the proxy accepted the request)",
		};
	return { detail: "invalid payload or model mismatch; request unchanged" };
}

async function reconcile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
): Promise<void> {
	if (state.applying) return;
	rememberBase(ctx, state);
	const model = ctx.model as ModelLike | undefined;
	const shouldUseFast = enabled(state) && !inactiveReason(ctx, state);
	if (!isGrokPair(model)) return;

	if (!shouldUseFast) {
		if (model?.id !== GROK_FAST_ID) return;
		const base = findBase(ctx, state);
		if (!base) {
			state.lastSwitch =
				"could not restore grok-4.7; fast model remains selected";
			return;
		}
		state.applying = true;
		try {
			const ok = await pi.setModel(base);
			state.lastSwitch = ok
				? "restored session model to xai/grok-4.7"
				: "setModel returned false; fast model remains selected";
		} catch (error) {
			state.lastSwitch = `setModel failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			state.applying = false;
		}
		return;
	}

	const base = findBase(ctx, state) ?? (model?.id === GROK_BASE_ID ? model : undefined);
	if (!base) {
		state.lastSwitch = "could not find xai/grok-4.7 to build the fast model";
		return;
	}
	if (model?.id === GROK_FAST_ID) {
		if (transportReady(model)) return;
		applyFastTransport(model, base);
		state.lastSwitch =
			"corrected the selected fast model onto the Grok Build proxy without another session model change";
		return;
	}
	state.applying = true;
	try {
		const ok = await pi.setModel(fastModel(base));
		state.lastSwitch = ok
			? "switched session model to xai/grok-4.7-build-fast on the Grok Build proxy (not proof the proxy accepted the token)"
			: "setModel returned false; session model unchanged";
	} catch (error) {
		state.lastSwitch = `setModel failed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		state.applying = false;
	}
}

function proxySelected(model: ModelLike | undefined): boolean {
	return model?.id === GROK_FAST_ID && model.baseUrl === GROK_PROXY_URL;
}

function applyProxyHeaders(
	headers: HeaderMap,
	ctx: ExtensionContext,
	state: State,
): void {
	const model = ctx.model as ModelLike | undefined;
	if (!enabled(state) || inactiveReason(ctx, state) || !proxySelected(model))
		return;
	for (const [name, value] of Object.entries(PROXY_HEADERS))
		setHeader(headers, name, value);
}

/** No credential reads, extra network calls, retries, or usage patches. */
export function registerFast(pi: ExtensionAPI, configPath: string): void {
	const states = new WeakMap<object, State>();
	function getState(ctx: ExtensionContext): State {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = { ...loadConfig(configPath), applying: false, deferred: false };
			states.set(ctx.sessionManager, state);
		}
		return state;
	}

	pi.on("session_start", async (_event, ctx) => {
		const state: State = {
			...loadConfig(configPath),
			applying: false,
			deferred: false,
		};
		states.set(ctx.sessionManager, state);
		if (state.warning) {
			if (ctx.hasUI) ctx.ui.notify(state.warning, "warning");
			else console.error(state.warning);
		}
		await reconcile(pi, ctx, state);
		updateStatus(ctx, state);
	});
	pi.on("model_select", async (_event, ctx) => {
		const state = getState(ctx);
		if (state.applying) return;
		state.lastRequest = undefined;
		state.lastSwitch = undefined;
		await reconcile(pi, ctx, state);
		updateStatus(ctx, state);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		const state = getState(ctx);
		state.deferred = false;
		await reconcile(pi, ctx, state);
		updateStatus(ctx, state);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		states.delete(ctx.sessionManager);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isRecord(event.headers)) return;
		applyProxyHeaders(event.headers as HeaderMap, ctx, getState(ctx));
	});
	pi.on("before_provider_request", (event, ctx) => {
		const state = getState(ctx);
		const handled = requestDetail(event.payload, ctx, state);
		state.lastRequest = { modelKey: modelKey(ctx), detail: handled.detail };
		updateStatus(ctx, state);
		return handled.result;
	});

	pi.registerCommand("fast", {
		description:
			"Toggle Fast: /fast [on|off|status]. Codex adds service_tier; Grok 4.7 switches to the proxy fast model",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim();
			if (!["", "on", "off", "status"].includes(action)) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			const state = getState(ctx);
			if (action !== "status") {
				state.override = action === "" ? !enabled(state) : action === "on";
				state.lastRequest = undefined;
				state.lastSwitch = undefined;
				const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
				if (!idle) {
					state.deferred = true;
					updateStatus(ctx, state);
					ctx.ui.notify(statusMessage(ctx, state), "info");
					return;
				}
				state.deferred = false;
				await reconcile(pi, ctx, state);
			}
			updateStatus(ctx, state);
			ctx.ui.notify(statusMessage(ctx, state), state.warning ? "warning" : "info");
		},
	});
}
