import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const TURN_DURATION_TYPE = "session-ui:turn-duration";
const I_DURATION = "\u{F051B}";

interface TurnDurationData {
	ms: number;
	startedAt: number;
	endedAt: number;
}

export function formatTurnDuration(ms: number): string {
	const clamped = Math.max(0, ms);
	if (clamped < 10_000) return `${(clamped / 1_000).toFixed(1)}s`;
	const totalSeconds = Math.round(clamped / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return [
			`${hours}h`,
			minutes > 0 ? `${minutes}m` : "",
			seconds > 0 ? `${seconds}s` : "",
		]
			.filter(Boolean)
			.join(" ");
	}
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function registerTurnDuration(pi: ExtensionAPI): void {
	let enabledForSession = false;
	let startedAt: number | undefined;
	let lastCompleted: TurnDurationData | undefined;
	let pendingCompaction: TurnDurationData | undefined;
	let continueAfterCompaction = false;

	const reset = () => {
		startedAt = undefined;
		lastCompleted = undefined;
		pendingCompaction = undefined;
		continueAfterCompaction = false;
	};

	const markStart = () => {
		if (!enabledForSession || startedAt !== undefined) return;
		startedAt =
			continueAfterCompaction && pendingCompaction
				? pendingCompaction.startedAt
				: Date.now();
		pendingCompaction = undefined;
		continueAfterCompaction = false;
	};

	const emit = (endedAt: number) => {
		if (startedAt === undefined) return;
		const completed: TurnDurationData = {
			ms: Math.max(0, endedAt - startedAt),
			startedAt,
			endedAt,
		};
		startedAt = undefined;
		lastCompleted = completed;
		pi.appendEntry<TurnDurationData>(TURN_DURATION_TYPE, completed);
	};

	pi.registerEntryRenderer<TurnDurationData>(
		TURN_DURATION_TYPE,
		(entry, _options, theme) =>
			new Text(
				theme.fg("dim", `${I_DURATION} ${formatTurnDuration(entry.data?.ms ?? 0)}`),
				0,
				0,
			),
	);

	pi.on("session_start", (_event, ctx) => {
		reset();
		enabledForSession = ctx.mode === "tui";
	});

	pi.on("input", (event) => {
		if (!enabledForSession) return;
		continueAfterCompaction =
			pendingCompaction !== undefined && event.source === "extension";
		if (!continueAfterCompaction) pendingCompaction = undefined;
	});
	pi.on("before_agent_start", () => markStart());
	pi.on("agent_start", () => markStart());

	pi.on("agent_settled", (_event, ctx) => {
		const endedAt = startedAt === undefined ? undefined : Date.now();
		if (endedAt === undefined || !ctx.isIdle()) return;
		emit(endedAt);
	});

	pi.on("session_compact", () => {
		if (!enabledForSession) return;
		pendingCompaction = startedAt === undefined ? lastCompleted : undefined;
	});

	pi.on("session_shutdown", () => {
		enabledForSession = false;
		reset();
	});
}
