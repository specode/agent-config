import { readFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-fast";
const USAGE = "Usage: /fast [on|off|status]";

type Config = {
	enabled: boolean;
	showStatus: boolean;
	excludeModels: string[];
};
type State = {
	config: Config;
	warning?: string;
	override?: boolean;
	lastRequest?: {
		modelKey: string;
		detail: string;
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		// An invalid exclusion list must not silently turn priority on for every model.
		return {
			config: defaults,
			warning:
				"OpenAI Fast config is invalid or unreadable; injection disabled. Fix openai-fast.json and /reload",
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

function inactiveReason(
	ctx: ExtensionContext,
	state: State,
): string | undefined {
	if (state.warning) return state.warning;
	if (!ctx.model) return "no model selected";
	if (ctx.model.provider !== "openai-codex")
		return "requires the openai-codex provider";
	if (ctx.model.api !== "openai-codex-responses")
		return "requires the openai-codex-responses API";
	if (!ctx.modelRegistry.isUsingOAuth(ctx.model))
		return "requires ChatGPT OAuth, not API-key auth";
	if (state.config.excludeModels.includes(ctx.model.id))
		return "current model is in excludeModels";
	return undefined;
}

function statusMessage(ctx: ExtensionContext, state: State): string {
	const reason = inactiveReason(ctx, state);
	const mode = enabled(state) ? "on" : "off";
	const source =
		state.override === undefined ? "global config" : "session override";
	const lines = [`OpenAI Fast: ${mode} (${source}); ${modelKey(ctx)}`];
	if (reason) lines.push(`No injection: ${reason}`);
	else if (enabled(state))
		lines.push(
			"Will add priority when service_tier is absent; this may increase quota consumption",
		);
	else
		lines.push(
			"This extension does not add or remove service_tier; settings from other sources are unchanged",
		);
	if (state.lastRequest)
		lines.push(
			`Last request handling (${state.lastRequest.modelKey}): ${state.lastRequest.detail}`,
		);
	lines.push(
		"Effective backend tier: unknown (the current Pi extension API does not expose response-body service_tier)",
	);
	return lines.join("\n");
}

function updateStatus(ctx: ExtensionContext, state: State): void {
	if (!ctx.hasUI) return;
	const active =
		state.config.showStatus && enabled(state) && !inactiveReason(ctx, state);
	ctx.ui.setStatus(STATUS_KEY, active ? "fast" : undefined);
}

/** No network calls, retries, credential reads, usage patches, or model catalog. */
export function registerOpenAIFast(pi: ExtensionAPI, configPath: string): void {
	const states = new WeakMap<object, State>();
	function getState(ctx: ExtensionContext): State {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = loadConfig(configPath);
			states.set(ctx.sessionManager, state);
		}
		return state;
	}

	pi.on("session_start", (_event, ctx) => {
		const state: State = loadConfig(configPath);
		states.set(ctx.sessionManager, state);
		if (state.warning) {
			if (ctx.hasUI) ctx.ui.notify(state.warning, "warning");
			else console.error(state.warning);
		}
		updateStatus(ctx, state);
	});
	pi.on("model_select", (_event, ctx) => {
		const state = getState(ctx);
		state.lastRequest = undefined;
		updateStatus(ctx, state);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		states.delete(ctx.sessionManager);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("before_provider_request", (event, ctx) => {
		const state = getState(ctx);
		const reason = inactiveReason(ctx, state);
		let detail = reason ?? "switch is off; request unchanged";
		let result: Record<string, unknown> | undefined;
		if (enabled(state) && !reason) {
			if (!isRecord(event.payload) || event.payload.model !== ctx.model?.id) {
				detail = "invalid payload or model mismatch; request unchanged";
			} else if ("service_tier" in event.payload) {
				detail =
					"existing service_tier preserved; not overwritten by this extension";
			} else {
				result = { ...event.payload, service_tier: "priority" };
				detail =
					"added service_tier=priority (not proof of final transmission or backend confirmation)";
			}
		}
		state.lastRequest = { modelKey: modelKey(ctx), detail };
		updateStatus(ctx, state);
		return result;
	});

	pi.registerCommand("fast", {
		description:
			"Toggle OpenAI Codex priority: /fast [on|off|status], without a model-version allowlist",
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
			}
			updateStatus(ctx, state);
			ctx.ui.notify(statusMessage(ctx, state), state.warning ? "warning" : "info");
		},
	});
}
