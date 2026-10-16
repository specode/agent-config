import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionUiConfig } from "./config.ts";
import {
	BackgroundTaskTracker,
	formatProcessDuration,
	readLinuxCommandLine,
	watchProcessTable,
	type BackgroundTask,
} from "./background-tasks-core.ts";

const WIDGET_ID = "session-ui:background-tasks";

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function renderTasks(tasks: BackgroundTask[], theme: Theme, width: number, maxItems: number): string[] {
	if (width <= 0 || tasks.length === 0) return [];
	const hidden = Math.max(0, tasks.length - maxItems);
	const title = `Background · ${plural(tasks.length, "task")}${hidden > 0 ? ` · ${hidden} hidden` : ""}`;
	return [theme.fg("dim", title), ...tasks.slice(0, maxItems).map((task) => {
		const lead = `${theme.fg("warning", "◆")} `;
		const processes = task.processCount > 1 ? ` · ${task.processCount} procs` : "";
		const tail = theme.fg(
			"dim",
			` · pid ${task.pid}${processes} · ${formatProcessDuration(task.elapsedSeconds)}`,
		);
		// Keep pid and duration visible when a long command needs truncating.
		const budget = Math.max(0, width - visibleWidth(lead) - visibleWidth(tail));
		return `${lead}${theme.fg("accent", truncateToWidth(task.command, budget))}${tail}`;
	})].map((line) => truncateToWidth(line, width));
}

/**
 * Read-only view of processes left running after Pi's shell commands returned. Foreground
 * commands stay in tool activity; this widget is independent of tool and turn lifetimes.
 */
export function registerBackgroundTasks(
	pi: ExtensionAPI,
	config: SessionUiConfig["backgroundTasks"],
	watch: typeof watchProcessTable = watchProcessTable,
): void {
	let stopWatching: (() => void) | undefined;
	let activeContext: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let tasks: BackgroundTask[] = [];
	let generation = 0;
	// Processes belong to the Pi process rather than a session, so group evidence survives
	// session switches; a reload starts without evidence of earlier commands.
	const tracker = new BackgroundTaskTracker(
		process.pid,
		process.platform === "linux" ? readLinuxCommandLine : undefined,
	);

	const stop = () => {
		generation++;
		stopWatching?.();
		stopWatching = undefined;
		tasks = [];
		activeContext?.ui.setWidget(WIDGET_ID, undefined);
		activeContext = undefined;
		requestRender = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		if (!config.enabled || !ctx.hasUI || ctx.mode !== "tui") return;
		if (process.platform !== "darwin" && process.platform !== "linux") {
			ctx.ui.notify("Background tasks require macOS or Linux", "warning");
			return;
		}
		activeContext = ctx;
		const currentGeneration = generation;
		let warned = false;
		ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				render: (width: number) => renderTasks(tasks, theme, width, config.maxItems),
				invalidate() {},
			};
		}, { placement: config.placement });
		stopWatching = watch((rows) => {
			if (currentGeneration !== generation) return;
			tasks = tracker.update(rows);
			requestRender?.();
		}, () => {
			if (currentGeneration !== generation) return;
			// Stale rows would claim processes are still running; keep the group evidence.
			tasks = [];
			requestRender?.();
			if (warned) return;
			warned = true;
			ctx.ui.notify("Background tasks unavailable; retrying in the background", "warning");
		});
	});
	pi.on("session_shutdown", stop);
}
