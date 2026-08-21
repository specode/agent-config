export const UI_META_OPEN_TAG = "<ui_meta>";
export const UI_META_CLOSE_TAG = "</ui_meta>";

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
		if (!title && !session) return undefined;
		return {
			v: 1,
			kind: "turn_start",
			...(title ? { title } : {}),
			...(session ? { session } : {}),
		};
	}

	if (value.kind === "turn_end" && typeof value.recap === "string") {
		const recap = sanitizeUiMetaText(value.recap, limits.recap);
		if (!recap) return undefined;
		return { v: 1, kind: "turn_end", recap };
	}

	return undefined;
}

/**
 * Parse valid protocol records only at their required message boundaries:
 * turn_start at the beginning and turn_end at the end. Code examples in the
 * normal response are therefore not mistaken for application metadata.
 */
export function extractUiMetaRecords(
	text: string,
	limits: UiMetaLimits,
): UiMetaRecord[] {
	const records: UiMetaRecord[] = [];
	for (const match of text.matchAll(/<ui_meta>\s*([\s\S]*?)\s*<\/ui_meta>/g)) {
		const body = match[1];
		const index = match.index ?? -1;
		if (!body || body.length > 4_096 || index < 0) continue;
		try {
			const record = parseRecord(JSON.parse(body) as unknown, limits);
			if (!record) continue;
			const before = text.slice(0, index).trim();
			const after = text.slice(index + match[0].length).trim();
			if (record.kind === "turn_start" && before === "") records.push(record);
			if (record.kind === "turn_end" && after === "") records.push(record);
		} catch {
			// The metadata channel is best-effort; malformed model output stays non-fatal.
		}
	}
	return records;
}

function stripCompleteBoundaryBlocks(text: string): string {
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

function stripTrailingProtocolPrefix(text: string): string {
	const lineStart = text.lastIndexOf("\n") + 1;
	const line = text.slice(lineStart);
	const candidate = line.trimStart();
	if (
		candidate.startsWith(UI_META_OPEN_TAG) ||
		(candidate.startsWith("<") && UI_META_OPEN_TAG.startsWith(candidate))
	) {
		return text.slice(0, lineStart).replace(/\r?\n$/, "");
	}
	return text;
}

/**
 * Hide boundary metadata blocks. When hideIncomplete is true, also remove a
 * truncated boundary block so abort/error messages cannot persist protocol text.
 */
export function stripUiMetaBlocks(
	text: string,
	hideIncomplete = false,
): string {
	let output = stripCompleteBoundaryBlocks(text);
	if (hideIncomplete) output = stripTrailingProtocolPrefix(output);
	return output
		.replace(/^[\t ]*(?:\r?\n)+/, "")
		.replace(/(?:\r?\n)+[\t ]*$/, "");
}
