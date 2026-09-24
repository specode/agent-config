export const UI_META_SENTINEL = "@@PI_UI_META_V1@@";
const LEGACY_UI_META_OPEN_TAG = "<ui_meta>";
const LEGACY_UI_META_CLOSE_TAG = "</ui_meta>";
const LEGACY_UI_META_BROKEN_CLOSE = "_meta>";

export interface UiMetaLimits {
	title: number;
	recap: number;
	sessionName: number;
}

export type UiMetaSessionDirective =
	| { action: "keep" }
	| { action: "set"; name: string };

export interface UiMetaTurnStart {
	v: 1;
	kind: "turn_start";
	title?: string;
	session?: UiMetaSessionDirective;
	task?: UiMetaSessionDirective;
}

export interface UiMetaTurnEnd {
	v: 1;
	kind: "turn_end";
	recap: string;
}

export type UiMetaRecord = UiMetaTurnStart | UiMetaTurnEnd;

export interface UiMetaRunProgress {
	startReceived: boolean;
	recapReceived: boolean;
}

export function beginUiMetaRun(
	startEnabled: boolean,
	recapEnabled: boolean,
	previous: UiMetaRunProgress,
	isCompactionContinuation: boolean,
): UiMetaRunProgress {
	return isCompactionContinuation
		? previous
		: { startReceived: !startEnabled, recapReceived: !recapEnabled };
}

export function canCommitUiMetaRecap(
	stopReason: string,
	hasToolCalls: boolean,
): boolean {
	return stopReason === "stop" && !hasToolCalls;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove terminal/control sequences, collapse whitespace, and enforce a visible length. */
export function sanitizeUiMetaText(value: string, maxLength: number): string {
	const normalized = value
		// OSC, including hyperlinks and terminal-title writes.
		.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
		// DCS/SOS/PM/APC strings.
		.replace(/\u001B[P^_X][\s\S]*?\u001B\\/g, "")
		// CSI sequences.
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		// Invisible direction/word-join controls must not affect the visible label.
		.replace(/[\u200B-\u200D\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "")
		// Remaining C0/C1 controls are word boundaries, never executable text.
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const characters = Array.from(normalized);
	if (characters.length <= maxLength) return normalized;
	if (maxLength <= 1) return "…";
	return `${characters.slice(0, maxLength - 1).join("")}…`;
}

function parseSessionDirective(
	value: unknown,
	limits: UiMetaLimits,
): UiMetaSessionDirective | undefined {
	if (!isObject(value)) return undefined;
	if (value.action === "keep") return { action: "keep" };
	if (value.action !== "set" || typeof value.name !== "string") return undefined;
	const name = sanitizeUiMetaText(value.name, limits.sessionName);
	return name ? { action: "set", name } : undefined;
}

function parseRecord(
	value: unknown,
	limits: UiMetaLimits,
): UiMetaRecord | undefined {
	if (!isObject(value) || value.v !== 1) return undefined;

	if (value.kind === "turn_start") {
		const title =
			typeof value.title === "string"
				? sanitizeUiMetaText(value.title, limits.title)
				: undefined;
		const session = parseSessionDirective(value.session, limits);
		const task = parseSessionDirective(value.task, limits);
		if (!title && !session && !task) return undefined;
		return {
			v: 1,
			kind: "turn_start",
			...(title ? { title } : {}),
			...(session ? { session } : {}),
			...(task ? { task } : {}),
		};
	}

	if (value.kind === "turn_end" && typeof value.recap === "string") {
		const recap = sanitizeUiMetaText(value.recap, limits.recap);
		if (!recap) return undefined;
		return { v: 1, kind: "turn_end", recap };
	}

	return undefined;
}

function protocolBody(line: string): string | undefined {
	const candidate = line.trim();
	if (candidate.startsWith(UI_META_SENTINEL)) {
		return candidate.slice(UI_META_SENTINEL.length).trim();
	}
	if (!candidate.startsWith(LEGACY_UI_META_OPEN_TAG)) return undefined;

	let body = candidate.slice(LEGACY_UI_META_OPEN_TAG.length).trim();
	if (body.endsWith(LEGACY_UI_META_CLOSE_TAG)) {
		body = body.slice(0, -LEGACY_UI_META_CLOSE_TAG.length).trim();
	} else if (body.endsWith(LEGACY_UI_META_BROKEN_CLOSE)) {
		body = body.slice(0, -LEGACY_UI_META_BROKEN_CLOSE.length).trim();
	}
	return body;
}

function parseProtocolBody(
	body: string | undefined,
	limits: UiMetaLimits,
): UiMetaRecord | undefined {
	if (!body || body.length > 4_096) return undefined;
	try {
		return parseRecord(JSON.parse(body) as unknown, limits);
	} catch {
		// The metadata channel is best-effort; malformed model output stays non-fatal.
		return undefined;
	}
}

function parseProtocolLine(
	line: string,
	limits: UiMetaLimits,
): UiMetaRecord | undefined {
	return parseProtocolBody(protocolBody(line), limits);
}

/** Index of an end record appended to prose on the same line, or -1. */
function inlineSentinelIndex(line: string): number {
	const index = line.lastIndexOf(UI_META_SENTINEL);
	return index > 0 && line.slice(0, index).trim() ? index : -1;
}

/** Models sometimes append turn_end to the last prose line instead of a new line. */
function parseInlineTurnEnd(
	line: string,
	limits: UiMetaLimits,
): UiMetaRecord | undefined {
	const index = inlineSentinelIndex(line);
	if (index < 0) return undefined;
	const record = parseProtocolBody(
		line.slice(index + UI_META_SENTINEL.length).trim(),
		limits,
	);
	return record?.kind === "turn_end" ? record : undefined;
}

function boundaryLineIndexes(lines: string[]): number[] {
	let first = 0;
	while (first < lines.length && !lines[first]?.trim()) first++;
	if (first >= lines.length) return [];

	let last = lines.length - 1;
	while (last > first && !lines[last]?.trim()) last--;
	return first === last ? [first] : [first, last];
}

/**
 * Parse one-line protocol records only at their required message boundaries:
 * turn_start at the beginning and turn_end at the end. The legacy XML-shaped
 * format remains readable so in-flight and restored sessions stay compatible.
 */
export function extractUiMetaRecords(
	text: string,
	limits: UiMetaLimits,
): UiMetaRecord[] {
	const lines = text.split(/\r?\n/);
	const indexes = boundaryLineIndexes(lines);
	const records: UiMetaRecord[] = [];
	for (const [position, index] of indexes.entries()) {
		const line = lines[index];
		if (line === undefined) continue;
		const isLast = index === indexes.at(-1);
		const record =
			parseProtocolLine(line, limits) ??
			(isLast ? parseInlineTurnEnd(line, limits) : undefined);
		if (!record) continue;
		if (record.kind === "turn_start" && position === 0) records.push(record);
		if (record.kind === "turn_end" && isLast) records.push(record);
	}
	return records;
}

export type UiMetaRecapMiss =
	| { reason: "missing" }
	| { reason: "invalid" | "misplaced"; snippet: string };

const RECAP_MISS_SNIPPET_LENGTH = 160;

function protocolMarkerIndex(line: string): number {
	const indexes = [UI_META_SENTINEL, LEGACY_UI_META_OPEN_TAG]
		.map((marker) => line.indexOf(marker))
		.filter((index) => index >= 0);
	return indexes.length ? Math.min(...indexes) : -1;
}

function protocolSnippet(line: string, markerIndex: number): string {
	return sanitizeUiMetaText(line.slice(markerIndex), RECAP_MISS_SNIPPET_LENGTH);
}

/**
 * Explain why a final response produced no turn_end record, using the raw text
 * before metadata stripping. The result is diagnostic only and never displayed.
 */
export function diagnoseUiMetaRecapMiss(
	text: string,
	limits: UiMetaLimits,
): UiMetaRecapMiss {
	const lines = text.split(/\r?\n/);
	const lastIndex = boundaryLineIndexes(lines).at(-1);
	const last = lastIndex === undefined ? undefined : lines[lastIndex];
	if (last !== undefined) {
		const markerIndex = protocolMarkerIndex(last);
		if (
			markerIndex >= 0 &&
			parseProtocolLine(last, limits)?.kind !== "turn_start"
		) {
			return { reason: "invalid", snippet: protocolSnippet(last, markerIndex) };
		}
	}
	for (const [index, line] of lines.entries()) {
		if (index === lastIndex) continue;
		const markerIndex = protocolMarkerIndex(line);
		if (markerIndex >= 0 && line.includes("turn_end", markerIndex)) {
			return {
				reason: "misplaced",
				snippet: protocolSnippet(line, markerIndex),
			};
		}
	}
	return { reason: "missing" };
}

function stripCompleteLegacyBoundaryBlocks(text: string): string {
	let output = text;
	let previous = "";
	while (output !== previous) {
		previous = output;
		output = output
			.replace(
				/^[\t \r\n]*<ui_meta>(?:(?!<ui_meta>)[\s\S])*?<\/ui_meta>[\t ]*(?:\r?\n)*/,
				"",
			)
			.replace(
				/(?:\r?\n)?[\t ]*<ui_meta>(?:(?!<ui_meta>)[\s\S])*?<\/ui_meta>[\t \r\n]*$/,
				"",
			);
	}
	return output;
}

function isProtocolBoundaryLine(
	line: string,
	hideIncomplete: boolean,
): boolean {
	const candidate = line.trimStart();
	if (!candidate) return false;
	for (const marker of [UI_META_SENTINEL, LEGACY_UI_META_OPEN_TAG]) {
		if (candidate.startsWith(marker)) return true;
		if (hideIncomplete && marker.startsWith(candidate)) return true;
	}
	return false;
}

function stripProtocolBoundaryLines(
	text: string,
	hideIncomplete: boolean,
): string {
	const lines = text.split(/\r?\n/);
	while (true) {
		const indexes = boundaryLineIndexes(lines);
		const first = indexes[0];
		if (
			first === undefined ||
			!isProtocolBoundaryLine(lines[first] ?? "", hideIncomplete)
		)
			break;
		lines.splice(first, 1);
	}
	while (true) {
		const indexes = boundaryLineIndexes(lines);
		const last = indexes.at(-1);
		if (
			last === undefined ||
			!isProtocolBoundaryLine(lines[last] ?? "", hideIncomplete)
		)
			break;
		lines.splice(last, 1);
	}
	stripInlineTurnEnd(lines, hideIncomplete);
	return lines.join("\n");
}

const MIN_INLINE_SENTINEL_PREFIX = 3;

function stripInlineTurnEnd(lines: string[], hideIncomplete: boolean): void {
	const last = boundaryLineIndexes(lines).at(-1);
	const line = last === undefined ? undefined : lines[last];
	if (last === undefined || line === undefined) return;

	const index = inlineSentinelIndex(line);
	if (index >= 0) {
		const body = line.slice(index + UI_META_SENTINEL.length).trim();
		// A complete record ends the line; an unfinished one has not closed yet.
		if (body.endsWith("}") || (hideIncomplete && !body.includes("}"))) {
			lines[last] = line.slice(0, index).trimEnd();
		}
		return;
	}
	if (!hideIncomplete) return;
	for (
		let length = Math.min(UI_META_SENTINEL.length - 1, line.length - 1);
		length >= MIN_INLINE_SENTINEL_PREFIX;
		length--
	) {
		if (line.endsWith(UI_META_SENTINEL.slice(0, length))) {
			lines[last] = line.slice(0, -length).trimEnd();
			return;
		}
	}
}

/**
 * Hide reserved boundary metadata lines. Streaming cleanup also hides a split
 * marker prefix; final cleanup removes malformed records before persistence.
 */
export function stripUiMetaBlocks(
	text: string,
	hideIncomplete = false,
): string {
	const output = stripProtocolBoundaryLines(
		stripCompleteLegacyBoundaryBlocks(text),
		hideIncomplete,
	);
	return output
		.replace(/^[\t ]*(?:\r?\n)+/, "")
		.replace(/(?:\r?\n)+[\t ]*$/, "");
}
