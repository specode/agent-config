export interface AssistantMessageSnapshot {
	/** 1-based index from latest assistant message (1 = latest). */
	index: number;
	/** Raw assistant text (Markdown source), keeping leading indentation on line 1. */
	text: string;
	/** Single-line display summary of the assistant message. */
	preview: string;
	timestamp?: string;
}

export type CopyItemKind = "code" | "quote" | "full";

export interface CopyItem {
	kind: CopyItemKind;
	label: string;
	lang?: string;
	/** Exact raw text copied to clipboard or opened in external editor. */
	content: string;
	lineCount: number;
	previewLine: string;
}

interface TextContentPart {
	type?: unknown;
	text?: unknown;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
}

interface SessionEntryLike {
	type?: unknown;
	timestamp?: unknown;
	message?: MessageLike;
}

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_APC_PM_SOS_RE = /\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)/g;
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC_2BYTE_RE = /\x1b[@-Z\\-_]/g;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const ALL_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

const QUOTE_LINE_RE = /^ {0,3}> ?(.*)$/;
const LIST_MARKER_RE = /^([ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+)(.*)$/;
const FENCE_OPEN_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const TAB_WIDTH = 4;

/**
 * Strips terminal escape sequences (OSC, DCS/APC, CSI, 2-byte ESC) and C0/C1
 * control characters so untrusted Markdown text cannot inject terminal commands.
 */
export function stripTerminalControl(text: string): string {
	return text
		.replace(OSC_RE, "")
		.replace(DCS_APC_PM_SOS_RE, "")
		.replace(CSI_RE, "")
		.replace(ESC_2BYTE_RE, "")
		.replace(CONTROL_CHAR_RE, "");
}

/** Removes terminal escapes/control chars and collapses whitespace for single-line previews. */
export function sanitizePreviewLine(text: string, maxChars = 120): string {
	const collapsed = stripTerminalControl(text)
		.replace(ALL_CONTROL_RE, " ")
		.replace(/\s+/g, " ")
		.trim();
	const chars = [...collapsed];
	if (chars.length <= maxChars) return collapsed;
	return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function firstPreviewLine(text: string): string {
	for (const line of text.split("\n")) {
		const cleaned = sanitizePreviewLine(line);
		if (cleaned.length > 0) return cleaned;
	}
	return "(empty)";
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/** Trims only leading/trailing blank lines, preserving leading indentation on the first non-blank line. */
function trimEdgeBlankLines(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	const strippedStart = normalized.replace(/^(?:[ \t]*\n)+/, "");
	const strippedEnd = strippedStart.replace(/(?:\n[ \t]*)+$/, "");
	return strippedEnd.trim().length === 0 ? "" : strippedEnd;
}

function extractAssistantText(message: MessageLike): string {
	const { content } = message;
	if (typeof content === "string") return trimEdgeBlankLines(content);
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content as TextContentPart[]) {
		if (part && part.type === "text" && typeof part.text === "string") {
			text += part.text;
		}
	}
	return trimEdgeBlankLines(text);
}

/**
 * Collects non-empty assistant text replies from session branch entries,
 * ordered newest-first with 1-based indices (1 = latest reply).
 */
export function collectAssistantMessages(
	entries: readonly unknown[],
): AssistantMessageSnapshot[] {
	const snapshots: AssistantMessageSnapshot[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as SessionEntryLike | null | undefined;
		if (!entry || entry.type !== "message") continue;
		if (!entry.message || entry.message.role !== "assistant") continue;
		const text = extractAssistantText(entry.message);
		if (!text) continue;
		snapshots.push({
			index: snapshots.length + 1,
			text,
			preview: firstPreviewLine(text),
			timestamp:
				typeof entry.timestamp === "string" ? entry.timestamp : undefined,
		});
	}
	return snapshots;
}

function stripQuotePrefixes(
	line: string,
	depth: number,
): { matched: boolean; rest: string } {
	let rest = line;
	for (let i = 0; i < depth; i++) {
		const match = QUOTE_LINE_RE.exec(rest);
		if (!match) return { matched: false, rest: line };
		rest = match[1] ?? "";
	}
	return { matched: true, rest };
}

function indentColumns(prefix: string, startCol = 0): number {
	let col = startCol;
	for (let i = 0; i < prefix.length; i++) {
		if (prefix[i] === "\t") {
			col += TAB_WIDTH - (col % TAB_WIDTH);
		} else {
			col += 1;
		}
	}
	return col - startCol;
}

/**
 * Strips up to `maxCols` columns of leading spaces/tabs (with tabs expanding
 * to 4-column stops), preserving any remainder of a partially consumed tab.
 */
function stripLeadingIndent(line: string, maxCols: number): string {
	if (maxCols <= 0) return line;
	let col = 0;
	let i = 0;
	while (i < line.length && col < maxCols) {
		const ch = line[i];
		if (ch === " ") {
			col += 1;
			i += 1;
		} else if (ch === "\t") {
			const tabAdvance = TAB_WIDTH - (col % TAB_WIDTH);
			if (col + tabAdvance <= maxCols) {
				col += tabAdvance;
				i += 1;
			} else {
				const remaining = col + tabAdvance - maxCols;
				return " ".repeat(remaining) + line.slice(i + 1);
			}
		} else {
			break;
		}
	}
	return line.slice(i);
}

interface OpenFence {
	char: "`" | "~";
	length: number;
	lang?: string;
	quoteDepth: number;
	indent: number;
	lines: string[];
}

function tryOpenFence(line: string): OpenFence | undefined {
	let quoteDepth = 0;
	let rest = line;
	while (true) {
		const quoteMatch = QUOTE_LINE_RE.exec(rest);
		if (!quoteMatch) break;
		quoteDepth++;
		rest = quoteMatch[1] ?? "";
	}

	let extraIndent = 0;
	const listMatch = LIST_MARKER_RE.exec(rest);
	if (listMatch) {
		const leading = listMatch[1] ?? "";
		const marker = listMatch[2] ?? "";
		const afterMarker = listMatch[3] ?? "";
		if (FENCE_OPEN_RE.test(afterMarker)) {
			extraIndent = indentColumns(leading + marker);
			rest = afterMarker;
		}
	}

	const fenceMatch = FENCE_OPEN_RE.exec(rest);
	if (!fenceMatch) return undefined;

	const leadingWhitespace = fenceMatch[1] ?? "";
	const marker = fenceMatch[2] ?? "";
	const info = (fenceMatch[3] ?? "").trim();
	const char = marker[0] as "`" | "~";

	// CommonMark forbids backticks in backtick fence info strings, preventing
	// inline triple-backtick code spans from matching as fenced blocks.
	if (char === "`" && info.includes("`")) return undefined;

	const rawLang = info.split(/\s+/)[0] || undefined;
	const lang = rawLang ? sanitizePreviewLine(rawLang, 32) || undefined : undefined;
	return {
		char,
		length: marker.length,
		lang,
		quoteDepth,
		indent: extraIndent + indentColumns(leadingWhitespace, extraIndent),
		lines: [],
	};
}

function isClosingFence(line: string, fence: OpenFence): boolean {
	const trimmedLeading = stripLeadingIndent(line, fence.indent);
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(trimmedLeading);
	if (!match) return false;
	const marker = match[1] ?? "";
	return marker[0] === fence.char && marker.length >= fence.length;
}

function trimBlankEdgeLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]!.trim() === "") start++;
	while (end > start && lines[end - 1]!.trim() === "") end--;
	return lines.slice(start, end);
}

/**
 * Extracts copyable blocks (fenced code blocks, blockquotes, and the full
 * raw Markdown response) from an assistant message without display padding.
 */
export function extractCopyItems(markdown: string): CopyItem[] {
	const normalized = trimEdgeBlankLines(markdown);
	if (!normalized) return [];

	const lines = normalized.split("\n");
	const items: CopyItem[] = [];
	let openFence: OpenFence | undefined;
	let quoteLines: string[] = [];

	const flushQuote = () => {
		const trimmed = trimBlankEdgeLines(quoteLines);
		quoteLines = [];
		if (trimmed.length === 0) return;
		const content = trimmed.join("\n");
		items.push({
			kind: "quote",
			label: "quote",
			content,
			lineCount: countLines(content),
			previewLine: firstPreviewLine(content),
		});
	};

	const flushFence = () => {
		if (!openFence) return;
		const content = openFence.lines.join("\n");
		const lang = openFence.lang;
		openFence = undefined;
		if (content.trim().length === 0) return;
		items.push({
			kind: "code",
			label: lang ? `code · ${lang}` : "code",
			lang,
			content,
			lineCount: countLines(content),
			previewLine: firstPreviewLine(content),
		});
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		if (openFence) {
			let bodyLine = line;
			if (openFence.quoteDepth > 0) {
				const stripped = stripQuotePrefixes(line, openFence.quoteDepth);
				if (!stripped.matched) {
					flushFence();
					i--;
					continue;
				}
				bodyLine = stripped.rest;
			}

			if (isClosingFence(bodyLine, openFence)) {
				flushFence();
				continue;
			}

			openFence.lines.push(stripLeadingIndent(bodyLine, openFence.indent));
			continue;
		}

		const opened = tryOpenFence(line);
		if (opened) {
			flushQuote();
			openFence = opened;
			continue;
		}

		const quoteMatch = QUOTE_LINE_RE.exec(line);
		if (quoteMatch) {
			quoteLines.push(quoteMatch[1] ?? "");
			continue;
		}

		flushQuote();
	}

	flushFence();
	flushQuote();

	items.push({
		kind: "full",
		label: "Full response",
		content: normalized,
		lineCount: countLines(normalized),
		previewLine: firstPreviewLine(normalized),
	});

	return items;
}

/**
 * Parses `/copy-block [N]` arguments into a 1-based assistant reply index.
 */
export function parseMessageIndexArg(
	rawArgs: string,
	totalMessages: number,
): { ok: true; index: number } | { ok: false; error: string } {
	const trimmed = rawArgs.trim();
	if (!trimmed) return { ok: true, index: 1 };
	if (!/^\d+$/.test(trimmed)) {
		return {
			ok: false,
			error: "Usage: /copy-block [N] (N is 1 for the latest reply, 2 for the previous, etc.)",
		};
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (parsed === 0) {
		return {
			ok: false,
			error: "Reply index must be a positive integer starting at 1.",
		};
	}
	if (!Number.isSafeInteger(parsed) || parsed > totalMessages) {
		return {
			ok: false,
			error: `Only ${totalMessages} assistant ${totalMessages === 1 ? "reply" : "replies"} available in this branch.`,
		};
	}
	return { ok: true, index: parsed };
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
	bash: "sh",
	c: "c",
	cc: "cc",
	cpp: "cpp",
	cs: "cs",
	css: "css",
	diff: "diff",
	dockerfile: "dockerfile",
	go: "go",
	graphql: "graphql",
	hcl: "hcl",
	html: "html",
	ini: "ini",
	java: "java",
	javascript: "js",
	js: "js",
	json: "json",
	json5: "json5",
	jsonc: "jsonc",
	jsx: "jsx",
	kotlin: "kt",
	kt: "kt",
	lua: "lua",
	markdown: "md",
	md: "md",
	nix: "nix",
	patch: "patch",
	php: "php",
	ps1: "ps1",
	powershell: "ps1",
	py: "py",
	python: "py",
	rb: "rb",
	rs: "rs",
	ruby: "rb",
	rust: "rs",
	scss: "scss",
	sh: "sh",
	shell: "sh",
	sql: "sql",
	swift: "swift",
	text: "txt",
	toml: "toml",
	ts: "ts",
	tsx: "tsx",
	txt: "txt",
	typescript: "ts",
	xml: "xml",
	yaml: "yml",
	yml: "yml",
	zig: "zig",
	zsh: "sh",
};

/** Maps a fenced code language tag to a safe temp-file extension for editor syntax highlighting. */
export function sanitizeFileExtension(lang?: string): string {
	if (!lang) return "md";
	const lower = lang.trim().toLowerCase();
	if (lower in LANGUAGE_EXTENSIONS) return LANGUAGE_EXTENSIONS[lower]!;
	const cleaned = lower.replace(/[^a-z0-9]/g, "").slice(0, 12);
	return cleaned || "txt";
}
