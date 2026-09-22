import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "fast";
const USAGE = "Usage: /fast [on|off|status]";
const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const GROK_PROVIDER = "xai";
const GROK_API = "openai-responses";
const GROK_BASE_ID = "grok-4.7";
const GROK_FAST_ID = "grok-4.7-build-fast";
const GROK_PUBLIC_URL = "https://api.x.ai/v1";
const GROK_PROXY_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_PRICE_MULTIPLIER = 2;
/** The proxy rejects callers that report no Grok CLI build, so requests claim one. */
const GROK_CLIENT_VERSION = "1.0.40";
const GROK_CLIENT_IDENTIFIER = "grok-shell";

function proxyHeaders(clientVersion: string): Record<string, string> {
	return {
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-model-override": GROK_FAST_ID,
		"x-authenticateresponse": "authenticate-response",
		"x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
		"x-grok-client-version": clientVersion,
	};
}

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
	grokClientVersion: string;
};
/** Persisted per-provider switch; providers without an entry follow the config default. */
type ProviderSwitch = { enabled: boolean; updatedAt: string };
type Switches = Record<string, ProviderSwitch>;
type State = {
	config: Config;
	switches: Switches;
	warning?: string;
	stateWarning?: string;
	applying: boolean;
	deferred: boolean;
	saveFailed: boolean;
	baseSnapshot?: ModelLike;
	switchFailure?: string;
};
type HeaderMap = Record<string, string | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function loadConfig(path: string): Pick<State, "config" | "warning"> {
	const defaults: Config = {
		enabled: false,
		showStatus: true,
		grokClientVersion: GROK_CLIENT_VERSION,
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
			"grokClientVersion" in raw &&
			(typeof raw.grokClientVersion !== "string" ||
				!/^[\w.+-]+$/.test(raw.grokClientVersion))
		) {
			throw new Error(
				"grokClientVersion must be a version string such as \"1.0.40\"",
			);
		}
		return {
			config: {
				enabled: (raw.enabled as boolean | undefined) ?? defaults.enabled,
				showStatus:
					(raw.showStatus as boolean | undefined) ?? defaults.showStatus,
				grokClientVersion:
					(raw.grokClientVersion as string | undefined) ??
					defaults.grokClientVersion,
			},
		};
	} catch (error) {
		if (isMissingFile(error)) return { config: defaults };
		return {
			config: defaults,
			warning: "config is invalid; fix fast.json and /reload",
		};
	}
}

function parseSwitches(value: unknown): Switches | undefined {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.providers))
		return undefined;
	const switches: Switches = {};
	for (const [provider, entry] of Object.entries(value.providers)) {
		if (
			!isRecord(entry) ||
			typeof entry.enabled !== "boolean" ||
			typeof entry.updatedAt !== "string" ||
			Number.isNaN(Date.parse(entry.updatedAt))
		) {
			return undefined;
		}
		switches[provider] = { enabled: entry.enabled, updatedAt: entry.updatedAt };
	}
	return switches;
}

function loadSwitches(path: string): {
	switches: Switches;
	stateWarning?: string;
} {
	try {
		const parsed = parseSwitches(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed) throw new Error("State must be a version 1 switch record");
		return { switches: parsed };
	} catch (error) {
		if (isMissingFile(error)) return { switches: {} };
		return {
			switches: {},
			stateWarning: `Fast could not read ${path}; the config default applies until the switch is set again`,
		};
	}
}

/** Re-reads before writing so a concurrent Pi only loses the provider it changed. */
function saveSwitch(path: string, provider: string, enabled: boolean): Switches {
	const merged: Switches = {
		...loadSwitches(path).switches,
		[provider]: { enabled, updatedAt: new Date().toISOString() },
	};
	const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	try {
		writeFileSync(
			temporary,
			`${JSON.stringify({ version: 1, providers: merged }, null, "\t")}\n`,
		);
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	return merged;
}

/** Providers with a fast strategy; the switch is stored per provider, not per model. */
function switchKey(ctx: ExtensionContext): string | undefined {
	const provider = ctx.model?.provider;
	return provider === CODEX_PROVIDER || provider === GROK_PROVIDER
		? provider
		: undefined;
}

function switchValue(state: State, provider: string): boolean {
	return state.switches[provider]?.enabled ?? state.config.enabled;
}

function switchOn(ctx: ExtensionContext, state: State): boolean {
	const key = switchKey(ctx);
	return key ? switchValue(state, key) : false;
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

/** Grok 4.7 is the only catalog model with a fast variant on the Build proxy. */
function isGrokFastModel(model: ModelLike | undefined): boolean {
	return (
		model?.provider === GROK_PROVIDER &&
		model.api === GROK_API &&
		(model.id === GROK_BASE_ID || model.id === GROK_FAST_ID)
	);
}

function transportActive(
	model: ModelLike | undefined,
	clientVersion: string,
): boolean {
	return (
		model?.provider === GROK_PROVIDER &&
		model.baseUrl === GROK_PROXY_URL &&
		headerValue(model.headers, "x-grok-model-override") === GROK_FAST_ID &&
		headerValue(model.headers, "x-xai-token-auth") === "xai-grok-cli" &&
		headerValue(model.headers, "x-grok-client-version") === clientVersion
	);
}

/** Why the current model cannot run Fast, ignoring the config and the switch. */
function modelReason(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as ModelLike | undefined;
	if (!model) return "no model selected";
	if (model.provider === CODEX_PROVIDER) {
		if (model.api !== CODEX_API)
			return "requires the openai-codex-responses API";
		if (!ctx.modelRegistry.isUsingOAuth(ctx.model!))
			return "requires ChatGPT OAuth, not API-key auth";
		return undefined;
	}
	if (model.provider === GROK_PROVIDER) {
		if (model.api !== GROK_API || !isGrokFastModel(model))
			return `only ${GROK_PROVIDER}/${GROK_BASE_ID} has a fast variant on this provider`;
		if (!ctx.modelRegistry.isUsingOAuth(ctx.model!))
			return "Grok fast requires xAI OAuth, not API-key auth";
		return undefined;
	}
	return "no fast strategy for this provider";
}

/** Why the strategy cannot run, independent of the switch. */
function inactiveReason(
	ctx: ExtensionContext,
	state: State,
): string | undefined {
	return state.warning ?? modelReason(ctx);
}

function rememberBase(ctx: ExtensionContext, state: State): void {
	const model = ctx.model as ModelLike | undefined;
	if (
		model?.provider === GROK_PROVIDER &&
		model.id === GROK_BASE_ID &&
		model.baseUrl !== GROK_PROXY_URL
	) {
		state.baseSnapshot = cloneModel(model);
	}
}

function findBase(ctx: ExtensionContext, state: State): ModelLike | undefined {
	const registry = ctx.modelRegistry as {
		find?: (provider: string, id: string) => ModelLike | undefined;
	};
	const found = registry.find?.(GROK_PROVIDER, GROK_BASE_ID);
	if (found) return cloneModel(found);
	if (state.baseSnapshot) return cloneModel(state.baseSnapshot);
	const current = ctx.model as ModelLike | undefined;
	if (current?.provider !== GROK_PROVIDER) return undefined;
	const restored = cloneModel(current);
	restored.id = GROK_BASE_ID;
	restored.name = "Grok 4.7";
	restored.headers = undefined;
	if (current.baseUrl === GROK_PROXY_URL) {
		restored.baseUrl = GROK_PUBLIC_URL;
		restored.cost = scaleCost(current.cost, 1 / GROK_PRICE_MULTIPLIER);
	}
	return restored;
}

/**
 * Keeps the catalog identity `xai/grok-4.7` and only swaps the transport, so the
 * session transcript, model scope and model memory never see the proxy-only id.
 */
function fastTransport(base: ModelLike, clientVersion: string): ModelLike {
	const next = cloneModel(base);
	next.id = GROK_BASE_ID;
	next.provider = GROK_PROVIDER;
	next.api = GROK_API;
	next.baseUrl = GROK_PROXY_URL;
	next.headers = proxyHeaders(clientVersion);
	next.cost = scaleCost(base.cost, GROK_PRICE_MULTIPLIER);
	return next;
}

function resultLine(ctx: ExtensionContext, state: State): string {
	const reason = inactiveReason(ctx, state);
	if (reason) return `Fast: unavailable (${reason})`;
	const line = switchOn(ctx, state) ? "Fast: on" : "Fast: off";
	if (state.switchFailure) return `${line}, not applied (${state.switchFailure})`;
	if (state.deferred) return `${line}, applies from the next turn`;
	if (state.saveFailed) return `${line}, this session only (switch not saved)`;
	return line;
}

function updateStatus(ctx: ExtensionContext, state: State): void {
	if (!ctx.hasUI) return;
	const model = ctx.model as ModelLike | undefined;
	const active =
		state.config.showStatus &&
		switchOn(ctx, state) &&
		!inactiveReason(ctx, state) &&
		(model?.provider === CODEX_PROVIDER ||
			transportActive(model, state.config.grokClientVersion));
	ctx.ui.setStatus(STATUS_KEY, active ? "fast" : undefined);
}

/** Returns a replacement payload, or undefined to send the request unchanged. */
function applyRequest(
	payload: unknown,
	ctx: ExtensionContext,
	state: State,
): Record<string, unknown> | undefined {
	const model = ctx.model as ModelLike | undefined;
	const onProxy = model?.baseUrl === GROK_PROXY_URL;
	if (!switchOn(ctx, state) || inactiveReason(ctx, state)) {
		// The proxy-only id must never reach a public endpoint, switch or not.
		if (isRecord(payload) && payload.model === GROK_FAST_ID && !onProxy)
			return { ...payload, model: GROK_BASE_ID };
		return undefined;
	}
	if (model?.provider === CODEX_PROVIDER) {
		if (!isRecord(payload) || payload.model !== model.id) return undefined;
		if ("service_tier" in payload) return undefined;
		return { ...payload, service_tier: "priority" };
	}
	if (model?.provider !== GROK_PROVIDER || !isRecord(payload)) return undefined;
	if (!onProxy)
		return payload.model === GROK_FAST_ID
			? { ...payload, model: GROK_BASE_ID }
			: undefined;
	return payload.model === GROK_BASE_ID
		? { ...payload, model: GROK_FAST_ID }
		: undefined;
}

async function swapTransport(
	pi: ExtensionAPI,
	state: State,
	model: ModelLike,
): Promise<void> {
	state.applying = true;
	try {
		const ok = await pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]);
		state.switchFailure = ok
			? undefined
			: "setModel returned false; the session transport is unchanged";
	} catch (error) {
		state.switchFailure = `setModel failed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		state.applying = false;
	}
}

async function reconcile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
): Promise<void> {
	if (state.applying) return;
	rememberBase(ctx, state);
	state.switchFailure = undefined;
	const model = ctx.model as ModelLike | undefined;
	if (model?.provider !== GROK_PROVIDER || !isGrokFastModel(model)) return;
	const version = state.config.grokClientVersion;
	const shouldUseFast = switchOn(ctx, state) && !inactiveReason(ctx, state);
	const applied = transportActive(model, version) && model.id === GROK_BASE_ID;
	const clean = !transportActive(model, version) && model.id === GROK_BASE_ID;

	if (shouldUseFast) {
		if (applied) return;
		const base = findBase(ctx, state);
		if (!base) {
			state.switchFailure =
				"could not resolve xai/grok-4.7 to apply the fast transport";
			return;
		}
		await swapTransport(pi, state, fastTransport(base, version));
		return;
	}

	if (clean) return;
	const base = findBase(ctx, state);
	if (!base) {
		state.switchFailure =
			"could not resolve xai/grok-4.7; the proxy transport is still selected";
		return;
	}
	await swapTransport(pi, state, base);
}

function applyProxyHeaders(
	headers: HeaderMap,
	ctx: ExtensionContext,
	state: State,
): void {
	const model = ctx.model as ModelLike | undefined;
	if (
		!switchOn(ctx, state) ||
		inactiveReason(ctx, state) ||
		model?.baseUrl !== GROK_PROXY_URL
	) {
		return;
	}
	for (const [name, value] of Object.entries(
		proxyHeaders(state.config.grokClientVersion),
	)) {
		setHeader(headers, name, value);
	}
}

/**
 * No credential reads, extra network calls, retries, or usage patches. Proxy requests
 * do claim a Grok CLI build, which is what the Grok Build proxy gates on.
 */
export function registerFast(
	pi: ExtensionAPI,
	configPath: string,
	statePath: string,
): void {
	const states = new WeakMap<object, State>();

	function freshState(): State {
		return {
			...loadConfig(configPath),
			...loadSwitches(statePath),
			applying: false,
			deferred: false,
			saveFailed: false,
		};
	}

	/** Persists the switch, falling back to a session-only value when the write fails. */
	function writeSwitch(state: State, provider: string, enabled: boolean): void {
		try {
			state.switches = saveSwitch(statePath, provider, enabled);
			state.saveFailed = false;
		} catch {
			state.switches = {
				...state.switches,
				[provider]: { enabled, updatedAt: new Date().toISOString() },
			};
			state.saveFailed = true;
		}
	}

	function getState(ctx: ExtensionContext): State {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = freshState();
			states.set(ctx.sessionManager, state);
		}
		return state;
	}

	pi.on("session_start", async (_event, ctx) => {
		const state = freshState();
		states.set(ctx.sessionManager, state);
		for (const message of [
			state.warning && `Fast: unavailable (${state.warning})`,
			state.stateWarning,
		]) {
			if (!message) continue;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.error(message);
		}
		await reconcile(pi, ctx, state);
		updateStatus(ctx, state);
	});
	pi.on("model_select", async (_event, ctx) => {
		const state = getState(ctx);
		if (state.applying) return;
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
		const result = applyRequest(event.payload, ctx, state);
		updateStatus(ctx, state);
		return result;
	});

	pi.registerCommand("fast", {
		description:
			"Toggle Fast for the current model: /fast [on|off|status]. Codex adds service_tier; only Grok 4.7 uses the Build proxy",
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
			const key = switchKey(ctx);
			if (inactiveReason(ctx, state) || !key) {
				// A saved "on" this model cannot honor is stale, so drop it instead of
				// leaving the switch claiming a mode that never runs.
				if (key && !state.warning && state.switches[key]?.enabled)
					writeSwitch(state, key, false);
				updateStatus(ctx, state);
				ctx.ui.notify(resultLine(ctx, state), "warning");
				return;
			}
			if (action !== "status") {
				writeSwitch(
					state,
					key,
					action === "" ? !switchValue(state, key) : action === "on",
				);
				state.deferred =
					typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
				if (!state.deferred) await reconcile(pi, ctx, state);
			}
			updateStatus(ctx, state);
			ctx.ui.notify(
				resultLine(ctx, state),
				state.saveFailed || state.switchFailure ? "warning" : "info",
			);
		},
	});
}
