import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type AnimationConfig = {
	enabled: boolean;
	intervalMs: number;
	widgetPlacement: "aboveEditor" | "belowEditor";
};

type ActiveTool = {
	phase: string;
};

const DEFAULT_CONFIG: AnimationConfig = {
	enabled: true,
	intervalMs: 180,
	widgetPlacement: "aboveEditor",
};
const CONFIG_PATH =
	process.env.PI_WORK_ANIMATION_CONFIG ??
	join(process.env.HOME ?? "", ".pi", "agent", "extensions", "work-animation.json");
const WIDGET_ID = "work-animation";
const UI_META_STATE_TYPE = "session-ui:ui-meta-state";
const TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MASCOT_FRAMES = ["ᕕ( ᐛ )ᕗ", "ᕗ( ᐛ )ᕕ"];

function loadConfig(): AnimationConfig {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AnimationConfig>;
		return {
			enabled:
				typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			intervalMs:
				typeof raw.intervalMs === "number" &&
				Number.isFinite(raw.intervalMs) &&
				raw.intervalMs >= 100 &&
				raw.intervalMs <= 500
					? Math.round(raw.intervalMs)
					: DEFAULT_CONFIG.intervalMs,
			widgetPlacement:
				raw.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: AnimationConfig): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function phaseForTool(toolName: string): string {
	const name = toolName.toLowerCase();
	if (name === "read" || name.includes("fetch")) return "Reading...";
	if (name === "edit" || name === "write") return "Editing...";
	if (name === "bash") return "Running command...";
	if (name.includes("search") || name.includes("grep")) return "Searching...";
	if (name.includes("diagnostic") || name.includes("lsp")) return "Checking code...";
	if (name.includes("subagent")) return "Coordinating...";
	if (name.includes("image")) return "Processing image...";
	const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "tool";
	return `Using ${safeName}...`;
}

function latestTaskTitle(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (
			entry?.type !== "custom" ||
			entry.customType !== UI_META_STATE_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}
		const data = entry.data as { v?: unknown; title?: unknown };
		if (data.v === 1 && typeof data.title === "string" && data.title.trim()) {
			return data.title.trim();
		}
	}
	return undefined;
}

function titleWithPrefix(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prefix: string,
): string {
	const directory = basename(ctx.cwd || process.cwd()) || "pi";
	const task = latestTaskTitle(ctx) || pi.getSessionName()?.trim() || directory;
	return task === directory
		? `${prefix} · ${directory}`
		: `${prefix} · ${task} · ${directory}`;
}

export default function workAnimation(pi: ExtensionAPI): void {
	let config = loadConfig();
	let activeContext: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;
	let frameIndex = 0;
	let phase = "Working...";
	const activeTools = new Map<string, ActiveTool>();

	const renderOnce = () => requestRender?.();

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const showIdleTitle = (ctx: ExtensionContext) => {
		ctx.ui.setTitle(titleWithPrefix(pi, ctx, "π"));
	};

	const applyEnabledState = (ctx: ExtensionContext) => {
		ctx.ui.setWorkingVisible(!config.enabled);
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
		if (!running) showIdleTitle(ctx);
		renderOnce();
	};

	const startTimer = (ctx: ExtensionContext) => {
		stopTimer();
		timer = setInterval(() => {
			frameIndex++;
			const frame = TITLE_FRAMES[frameIndex % TITLE_FRAMES.length]!;
			ctx.ui.setTitle(titleWithPrefix(pi, ctx, `${frame} π`));
			renderOnce();
		}, config.intervalMs);
	};

	const start = (ctx: ExtensionContext, nextPhase = "Working...") => {
		if (!config.enabled) return;
		activeContext = ctx;
		running = true;
		frameIndex = 0;
		phase = nextPhase;
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setTitle(titleWithPrefix(pi, ctx, `${TITLE_FRAMES[0]} π`));
		startTimer(ctx);
		renderOnce();
	};

	const stop = (ctx: ExtensionContext) => {
		running = false;
		activeTools.clear();
		stopTimer();
		frameIndex = 0;
		showIdleTitle(ctx);
		renderOnce();
	};

	const updatePhase = () => {
		phase = [...activeTools.values()].at(-1)?.phase ?? "Wrapping up...";
		renderOnce();
	};

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		stopTimer();
		running = false;
		frameIndex = 0;
		phase = "Working...";
		activeTools.clear();
		applyEnabledState(ctx);

		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET_ID,
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					render(width: number): string[] {
						if (!running || !config.enabled) return [];
						const mascot = MASCOT_FRAMES[frameIndex % MASCOT_FRAMES.length]!;
						const line = `${theme.fg("accent", mascot)} ${theme.fg("muted", phase)}`;
						return [truncateToWidth(line, Math.max(1, width), "")];
					},
					invalidate() {},
				};
			},
			{ placement: config.widgetPlacement },
		);
	});

	pi.on("agent_start", (_event, ctx) => {
		start(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!config.enabled) return;
		const toolName = event.toolName || "tool";
		const toolPhase = phaseForTool(toolName);
		activeTools.set(event.toolCallId, { phase: toolPhase });
		if (!running) start(ctx, toolPhase);
		else updatePhase();
	});

	pi.on("tool_execution_end", (event) => {
		if (!config.enabled) return;
		activeTools.delete(event.toolCallId);
		updatePhase();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (running) stop(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		running = false;
		activeTools.clear();
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setWorkingMessage();
			ctx.ui.setWorkingIndicator();
			ctx.ui.setTitle(titleWithPrefix(pi, ctx, "π"));
		}
		requestRender = undefined;
		activeContext = undefined;
	});

	pi.registerCommand("work-animation", {
		description: "Configure the mascot and titlebar work animation: on, off, status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";

			if (action === "status") {
				ctx.ui.notify(
					`Work animation: ${config.enabled ? "on" : "off"} · ${config.intervalMs}ms · ${config.widgetPlacement}`,
					"info",
				);
				return;
			}

			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /work-animation [on|off|status]", "error");
				return;
			}

			if (running && activeContext) stop(activeContext);
			config = { ...config, enabled: action === "on" };
			applyEnabledState(ctx);
			try {
				saveConfig(config);
			} catch (error) {
				ctx.ui.notify(
					`Animation changed but could not save: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(`Work animation ${config.enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
