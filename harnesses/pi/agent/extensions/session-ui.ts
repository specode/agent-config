/**
 * session-ui — Pi 会话层 UI：工具行、状态栏、/effort
 *
 * 合并自原 compact-tools / statusline / effort。
 *
 * 能力:
 *   - 工具调用默认单行摘要（edit 始终展示 diff）
 *   - Claude Code 风格底部状态栏
 *   - 剪贴板图片显示为 [Image N]，长文本显示为 [Paste N · size]，提交时仍展开原内容
 *   - 终端标题跟随任务 summary（非原文；提交后即并行生成，思考中就会更新）
 *   - 每轮结束后在聊天记录插入处理时长（写入 session，不进模型上下文）
 *   - /effort 调节 thinking 强度
 *   - /statusline 切换自定义 / 默认 footer
 *   - /unname 清除 session 显示名（恢复自动 summary）
 *
 * Usage:
 *   auto-loaded from ~/.pi/agent/extensions/
 *   or: pi -e ~/.pi/agent/extensions/session-ui.ts
 *
 * Tips:
 *   Ctrl+O  toggle tool output expand
 *   Ctrl+T  toggle thinking visibility
 *   /effort [level|status]
 *   /statusline
 *   /unname
 */

import { getSupportedThinkingLevels, uuidv7 } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	ExtensionContext,
	FindToolDetails,
	GrepToolDetails,
	LsToolDetails,
	ReadToolDetails,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	CustomEditor,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { homedir } from "node:os";

// ─────────────────────────────────────────────────────────────
// Shared helpers (tool rows)
// ─────────────────────────────────────────────────────────────

const MAX_DETAIL_LINES = 24;
const MAX_CMD_CHARS = 90;
const MAX_PATH_CHARS = 64;
const MAX_PATTERN_CHARS = 48;

type TextResult = {
	content: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	details?: unknown;
};

function empty(): Container {
	return new Container();
}

function ellipsize(value: string, max: number): string {
	const s = value.replace(/\s+/g, " ").trim();
	if (s.length <= max) return s;
	if (max <= 1) return "…";
	return `${s.slice(0, max - 1)}…`;
}

function shortPath(path: string | undefined, fallback = "."): string {
	if (!path) return fallback;
	return ellipsize(path, MAX_PATH_CHARS);
}

function textOf(result: TextResult | undefined): string {
	if (!result?.content?.length) return "";
	return result.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text as string)
		.join("\n")
		.trim();
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function bullet(
	theme: Theme,
	kind: "ok" | "run" | "err" | "info",
	label: string,
	detail?: string,
): Text {
	const icon =
		kind === "err"
			? theme.fg("error", "✗")
			: kind === "run"
				? theme.fg("warning", "◆")
				: theme.fg("success", "◇");
	const title = theme.fg("toolTitle", theme.bold(label));
	const rest = detail ? ` ${theme.fg("accent", detail)}` : "";
	return new Text(`${icon} ${title}${rest}`, 0, 0);
}

function errorLine(
	theme: Theme,
	result: TextResult | undefined,
	fallback = "failed",
): Text {
	const raw = textOf(result).split("\n")[0] || fallback;
	return new Text(
		`${theme.fg("error", "✗")} ${theme.fg("error", ellipsize(raw, 100))}`,
		0,
		0,
	);
}

/** Copy prompt-facing metadata from a built-in tool, preserving its schema type. */
function metaFromOriginal<T extends TSchema>(tool: {
	description: string;
	parameters: T;
	promptSnippet?: string;
	promptGuidelines?: string[];
}) {
	return {
		description: tool.description,
		parameters: tool.parameters,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
	};
}

// ─────────────────────────────────────────────────────────────
// Tool rows (Grok-style one-liners)
// ─────────────────────────────────────────────────────────────

function registerToolRows(pi: ExtensionAPI): void {
	const cwd = process.cwd();

	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		...metaFromOriginal(originalRead),
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createReadTool(ctx?.cwd ?? cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);
		},
		renderCall(args, theme, context) {
			const path = shortPath(args?.path);
			if (context.isPartial || !context.executionStarted) {
				return bullet(
					theme,
					context.executionStarted ? "run" : "info",
					"Read",
					path,
				);
			}
			if (context.isError) {
				return bullet(theme, "err", "Read", path);
			}
			return bullet(theme, "ok", "Read", path);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			if (context.isError)
				return expanded ? errorLine(theme, result as TextResult) : empty();
			if (!expanded) return empty();

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content?.[0];
			if (content?.type === "image") {
				return new Text(theme.fg("success", "  image"), 0, 0);
			}

			const body = textOf(result as TextResult);
			let text = "";
			if (details?.truncation?.truncated) {
				text += theme.fg(
					"warning",
					`  truncated (${details.truncation.totalLines ?? "?"} lines)\n`,
				);
			} else if (body) {
				text += theme.fg("dim", `  ${lineCount(body)} lines\n`);
			}
			const lines = body.split("\n").slice(0, MAX_DETAIL_LINES);
			text += lines.map((l) => theme.fg("dim", l)).join("\n");
			if (lineCount(body) > MAX_DETAIL_LINES) {
				text += `\n${theme.fg("muted", `… ${lineCount(body) - MAX_DETAIL_LINES} more`)}`;
			}
			return text
				? new Text(text, 0, 0)
				: new Text(theme.fg("dim", "  (empty)"), 0, 0);
		},
	});

	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		...metaFromOriginal(originalBash),
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createBashTool(ctx?.cwd ?? cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);
		},
		renderCall(args, theme, context) {
			const cmd = ellipsize(String(args?.command ?? ""), MAX_CMD_CHARS);
			if (context.isError) return bullet(theme, "err", "Run", cmd);
			if (context.isPartial) return bullet(theme, "run", "Run", cmd);
			if (!context.executionStarted) return bullet(theme, "info", "Run", cmd);
			return bullet(theme, "ok", "Run", cmd);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			if (context.isError) {
				return expanded ? errorLine(theme, result as TextResult) : empty();
			}
			if (!expanded) return empty();

			const details = result.details as BashToolDetails | undefined;
			const body = textOf(result as TextResult);
			const lines = body.split("\n").filter((l) => l.length > 0);
			const shown = lines.slice(0, MAX_DETAIL_LINES);
			let text = shown.map((l) => theme.fg("dim", l)).join("\n");
			if (details?.truncation?.truncated) {
				text += `\n${theme.fg("warning", "  [truncated]")}`;
			}
			if (lines.length > MAX_DETAIL_LINES) {
				text += `\n${theme.fg("muted", `… ${lines.length - MAX_DETAIL_LINES} more`)}`;
			}
			return text ? new Text(text, 0, 0) : empty();
		},
	});

	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		...metaFromOriginal(originalEdit),
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createEditTool(ctx?.cwd ?? cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);
		},
		renderCall(args, theme, context) {
			const path = shortPath(args?.path);
			const n = Array.isArray(args?.edits) ? args.edits.length : 0;
			const detail = n > 1 ? `${path} (${n} edits)` : path;
			if (context.isError) return bullet(theme, "err", "Edit", detail);
			if (context.isPartial) return bullet(theme, "run", "Edit", detail);
			return bullet(
				theme,
				context.executionStarted ? "ok" : "info",
				"Edit",
				detail,
			);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "  editing…"), 0, 0);
			if (context.isError) return errorLine(theme, result as TextResult);

			const details = result.details as EditToolDetails | undefined;
			const diff = details?.diff ?? "";
			if (!diff) return new Text(theme.fg("success", "  applied"), 0, 0);

			let additions = 0;
			let removals = 0;
			const diffLines = diff.split("\n");
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			const maxDiffLines = Math.max(MAX_DETAIL_LINES, 80);
			let text =
				theme.fg("success", `  +${additions}`) +
				theme.fg("dim", " / ") +
				theme.fg("error", `-${removals}`);
			for (const line of diffLines.slice(0, maxDiffLines)) {
				if (line.startsWith("+") && !line.startsWith("+++"))
					text += `\n${theme.fg("success", line)}`;
				else if (line.startsWith("-") && !line.startsWith("---"))
					text += `\n${theme.fg("error", line)}`;
				else text += `\n${theme.fg("dim", line)}`;
			}
			if (diffLines.length > maxDiffLines) {
				text += `\n${theme.fg("muted", `… ${diffLines.length - maxDiffLines} more diff lines`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		...metaFromOriginal(originalWrite),
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createWriteTool(ctx?.cwd ?? cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);
		},
		renderCall(args, theme, context) {
			const path = shortPath(args?.path);
			const n = typeof args?.content === "string" ? lineCount(args.content) : 0;
			const detail = n ? `${path} (${n} lines)` : path;
			if (context.isError) return bullet(theme, "err", "Write", detail);
			if (context.isPartial) return bullet(theme, "run", "Write", detail);
			return bullet(
				theme,
				context.executionStarted ? "ok" : "info",
				"Write",
				detail,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			if (context.isError)
				return expanded ? errorLine(theme, result as TextResult) : empty();
			if (!expanded) return empty();
			return new Text(theme.fg("success", "  written"), 0, 0);
		},
	});

	const originalGrep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		...metaFromOriginal(originalGrep),
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createGrepTool(ctx?.cwd ?? cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);
		},
		renderCall(args, theme, context) {
			const pattern = ellipsize(String(args?.pattern ?? ""), MAX_PATTERN_CHARS);
			const where = args?.path
				? shortPath(args.path)
				: args?.glob
					? String(args.glob)
					: "";
			const detail = where ? `/${pattern}/ in ${where}` : `/${pattern}/`;
			if (context.isError) return bullet(theme, "err", "Searched", detail);
			if (context.isPartial) return bullet(theme, "run", "Searched", detail);
			return bullet(
				theme,
				context.executionStarted ? "ok" : "info",
				"Searched",
				detail,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			if (context.isError)
				return expanded ? errorLine(theme, result as TextResult) : empty();

			const body = textOf(result as TextResult);
			const matches = body ? body.split("\n").filter(Boolean).length : 0;
			const details = result.details as GrepToolDetails | undefined;

			if (!expanded) {
				return empty();
			}

			let text = theme.fg("dim", `  ${matches} match${matches === 1 ? "" : "es"}`);
			if (details?.matchLimitReached)
				text += theme.fg("warning", ` (hit limit ${details.matchLimitReached})`);
			if (body) {
				const lines = body.split("\n").slice(0, MAX_DETAIL_LINES);
				text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
				if (lineCount(body) > MAX_DETAIL_LINES) {
					text += `\n${theme.fg("muted", `… ${lineCount(body) - MAX_DETAIL_LINES} more`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	const originalFind = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		...metaFromOriginal(originalFind),
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createFindTool(ctx?.cwd ?? cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);
		},
		renderCall(args, theme, context) {
			const pattern = ellipsize(String(args?.pattern ?? ""), MAX_PATTERN_CHARS);
			const where = args?.path ? ` in ${shortPath(args.path)}` : "";
			const detail = `${pattern}${where}`;
			if (context.isError) return bullet(theme, "err", "Found", detail);
			if (context.isPartial) return bullet(theme, "run", "Found", detail);
			return bullet(
				theme,
				context.executionStarted ? "ok" : "info",
				"Found",
				detail,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			if (context.isError)
				return expanded ? errorLine(theme, result as TextResult) : empty();
			if (!expanded) return empty();

			const body = textOf(result as TextResult);
			const n = body ? body.split("\n").filter(Boolean).length : 0;
			const details = result.details as FindToolDetails | undefined;
			let text = theme.fg("dim", `  ${n} path${n === 1 ? "" : "s"}`);
			if (details?.resultLimitReached)
				text += theme.fg("warning", ` (limit ${details.resultLimitReached})`);
			if (body) {
				const lines = body.split("\n").slice(0, MAX_DETAIL_LINES);
				text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
				if (lineCount(body) > MAX_DETAIL_LINES) {
					text += `\n${theme.fg("muted", `… ${lineCount(body) - MAX_DETAIL_LINES} more`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	const originalLs = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		...metaFromOriginal(originalLs),
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createLsTool(ctx?.cwd ?? cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);
		},
		renderCall(args, theme, context) {
			const path = shortPath(args?.path, ".");
			if (context.isError) return bullet(theme, "err", "Listed", path);
			if (context.isPartial) return bullet(theme, "run", "Listed", path);
			return bullet(
				theme,
				context.executionStarted ? "ok" : "info",
				"Listed",
				path,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			if (context.isError)
				return expanded ? errorLine(theme, result as TextResult) : empty();
			if (!expanded) return empty();

			const body = textOf(result as TextResult);
			const n = body ? body.split("\n").filter(Boolean).length : 0;
			const details = result.details as LsToolDetails | undefined;
			let text = theme.fg("dim", `  ${n} entr${n === 1 ? "y" : "ies"}`);
			if (details?.entryLimitReached)
				text += theme.fg("warning", ` (limit ${details.entryLimitReached})`);
			if (body) {
				const lines = body.split("\n").slice(0, MAX_DETAIL_LINES);
				text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
				if (lineCount(body) > MAX_DETAIL_LINES) {
					text += `\n${theme.fg("muted", `… ${lineCount(body) - MAX_DETAIL_LINES} more`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});
}

// ─────────────────────────────────────────────────────────────
// Compact paste placeholders
// ─────────────────────────────────────────────────────────────

const PASTE_MARKER_RE = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const CLIPBOARD_IMAGE_RE = /^pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)$/i;

type EditorPasteRegistry = {
	pastes: Map<number, string>;
	pasteCounter: number;
};

type EditorStateAccess = {
	state: {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
};

function pasteRegistry(editor: CustomEditor): EditorPasteRegistry {
	// Pi's Editor already uses this registry to keep compact paste markers while
	// submitting their expanded content. Reuse it so undo/delete/history retain
	// native behavior; if Pi changes these internals, the runtime guard falls back.
	const candidate = editor as unknown as Partial<EditorPasteRegistry>;
	if (!(candidate.pastes instanceof Map)) {
		throw new Error("Pi editor paste registry is unavailable");
	}
	return candidate as EditorPasteRegistry;
}

function isClipboardImagePath(value: string): boolean {
	return CLIPBOARD_IMAGE_RE.test(basename(value));
}

function compactPasteCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) {
		return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
	}
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function pasteSize(content: string): string {
	const lines = content.split("\n").length;
	return lines > 10
		? `${compactPasteCount(lines)} lines`
		: `${compactPasteCount(content.length)} chars`;
}

export class CompactPasteEditor extends CustomEditor {
	onCompatibilityFallback?: (reason: string) => void;
	private compatibilityWarningShown = false;

	checkCompatibility(): void {
		try {
			pasteRegistry(this);
			const internal = this as unknown as Partial<EditorStateAccess>;
			if (
				!internal.state ||
				!Array.isArray(internal.state.lines) ||
				!Number.isInteger(internal.state.cursorLine) ||
				!Number.isInteger(internal.state.cursorCol)
			) {
				throw new Error("editor state is unavailable");
			}
		} catch (error) {
			this.reportCompatibilityFallback(
				error instanceof Error ? error.message : "unknown editor change",
			);
		}
	}

	private reportCompatibilityFallback(reason: string): void {
		if (this.compatibilityWarningShown) return;
		this.compatibilityWarningShown = true;
		queueMicrotask(() => {
			try {
				this.onCompatibilityFallback?.(reason);
			} catch {
				// A compatibility warning must never break the editor.
			}
		});
	}

	override insertTextAtCursor(text: string): void {
		if (!isClipboardImagePath(text)) {
			super.insertTextAtCursor(text);
			return;
		}

		try {
			const registry = pasteRegistry(this);
			const pasteId = registry.pasteCounter + 1;
			const marker = `[paste #${pasteId}]`;
			const { line, col } = this.getCursor();
			const currentLine = this.getLines()[line] ?? "";
			const before = currentLine[col - 1] ?? "";
			const after = currentLine[col] ?? "";
			const leadingSpace = before && !/\s/.test(before) ? " " : "";
			const trailingSpace = after && /\s/.test(after) ? "" : " ";

			// Insert first so Editor's undo snapshot captures the registry before the image.
			super.insertTextAtCursor(`${leadingSpace}${marker}${trailingSpace}`);
			registry.pasteCounter = pasteId;
			registry.pastes.set(pasteId, text);
		} catch (error) {
			this.reportCompatibilityFallback(
				error instanceof Error ? error.message : "image placeholder unavailable",
			);
			// Preserve Pi's native path behavior if its private paste registry changes.
			super.insertTextAtCursor(text);
		}
	}

	override handleInput(data: string): void {
		let previousPasteIds: Set<number> | undefined;
		try {
			previousPasteIds = new Set(pasteRegistry(this).pastes.keys());
		} catch {
			// Fall through to Pi's native editor behavior.
		}

		super.handleInput(data);
		if (!previousPasteIds) return;

		try {
			const registry = pasteRegistry(this);
			let changed = false;
			for (const [pasteId, content] of registry.pastes) {
				if (!previousPasteIds.has(pasteId) && !isClipboardImagePath(content)) {
					changed = this.addMarkerSpacing(pasteId) || changed;
				}
			}
			if (changed) this.onChange?.(this.getText());
		} catch (error) {
			this.reportCompatibilityFallback(
				error instanceof Error ? error.message : "paste spacing unavailable",
			);
			// Keep the native marker untouched if Pi's editor internals change.
		}
	}

	private addMarkerSpacing(pasteId: number): boolean {
		const internal = this as unknown as EditorStateAccess;
		const markerPattern = new RegExp(
			`\\[paste #${pasteId}(?: (?:\\+\\d+ lines|\\d+ chars))?\\]`,
		);

		for (
			let lineIndex = 0;
			lineIndex < internal.state.lines.length;
			lineIndex++
		) {
			const line = internal.state.lines[lineIndex] ?? "";
			const match = markerPattern.exec(line);
			if (!match || match.index === undefined) continue;

			const markerStart = match.index;
			const markerEnd = markerStart + match[0].length;
			const before = line[markerStart - 1] ?? "";
			const after = line[markerEnd] ?? "";
			const leadingSpace = before && !/\s/.test(before) ? " " : "";
			const trailingSpace = after && /\s/.test(after) ? "" : " ";
			if (!leadingSpace && !trailingSpace) return false;

			internal.state.lines[lineIndex] =
				line.slice(0, markerStart) +
				leadingSpace +
				match[0] +
				trailingSpace +
				line.slice(markerEnd);

			if (internal.state.cursorLine === lineIndex) {
				if (leadingSpace && internal.state.cursorCol >= markerStart) {
					internal.state.cursorCol += leadingSpace.length;
				}
				if (trailingSpace && internal.state.cursorCol >= markerEnd) {
					internal.state.cursorCol += trailingSpace.length;
				}
			}
			return true;
		}
		return false;
	}

	override render(width: number): string[] {
		let registry: EditorPasteRegistry;
		try {
			registry = pasteRegistry(this);
		} catch (error) {
			this.reportCompatibilityFallback(
				error instanceof Error ? error.message : "paste rendering unavailable",
			);
			return super.render(width);
		}

		const imageNumbers = new Map<number, number>();
		const pasteNumbers = new Map<number, number>();
		let nextImageNumber = 1;
		let nextPasteNumber = 1;
		for (const match of this.getText().matchAll(PASTE_MARKER_RE)) {
			const pasteId = Number(match[1]);
			const content = registry.pastes.get(pasteId);
			if (!content) continue;
			if (isClipboardImagePath(content)) {
				imageNumbers.set(pasteId, nextImageNumber++);
			} else {
				pasteNumbers.set(pasteId, nextPasteNumber++);
			}
		}

		return super.render(width).map((line) =>
			line.replace(PASTE_MARKER_RE, (marker, rawId: string) => {
				const pasteId = Number(rawId);
				const imageNumber = imageNumbers.get(pasteId);
				if (imageNumber) return `[Image ${imageNumber}]`;

				const pasteNumber = pasteNumbers.get(pasteId);
				const content = registry.pastes.get(pasteId);
				return pasteNumber && content
					? `[Paste ${pasteNumber} · ${pasteSize(content)}]`
					: marker;
			}),
		);
	}
}

function registerCompactPasteEditor(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new CompactPasteEditor(tui, theme, keybindings);
			editor.onCompatibilityFallback = (reason) => {
				ctx.ui.notify(
					`Paste placeholder compatibility fallback (${reason}); using Pi native paste behavior.`,
					"warning",
				);
			};
			editor.checkCompatibility();
			return editor;
		});
	});
}

// ─────────────────────────────────────────────────────────────
// Statusline
// ─────────────────────────────────────────────────────────────

const I_MODEL = "\uF2DB"; // nf-fa-microchip
const I_EFFORT = "\uF0E7"; // nf-fa-bolt
const I_DIR = "\uF07B"; // nf-fa-folder
const I_BRANCH = "\uE0A0"; // powerline git branch
const I_CTX = "\uF1C0"; // nf-fa-database
const I_SESSION = "\uF02B"; // nf-fa-tag
const I_TOKENS = "\uF1C9"; // nf-fa-file-code-o
const I_CACHE = "\uF49B"; // nf-oct-cache
const I_COST = "\uF155"; // nf-fa-dollar
const I_MCP = "\uF1E6"; // nf-fa-plug
const I_SEP = "\uE0B1"; // powerline thin chevron

type StatuslineModuleId =
	| "model"
	| "effort"
	| "directory"
	| "session"
	| "branch"
	| "context"
	| "tokens"
	| "cache"
	| "cost"
	| "mcp"
	| "extensions";

/** Presentation-only config: choose/order modules without changing their data logic. */
const STATUSLINE_MODULES: ReadonlyArray<{
	id: StatuslineModuleId;
	enabled: boolean;
}> = [
	{ id: "model", enabled: true },
	{ id: "effort", enabled: true },
	{ id: "directory", enabled: true },
	{ id: "session", enabled: false },
	{ id: "branch", enabled: true },
	{ id: "context", enabled: true },
	{ id: "tokens", enabled: true },
	{ id: "cache", enabled: true },
	{ id: "cost", enabled: true },
	{ id: "mcp", enabled: true },
	{ id: "extensions", enabled: true },
];

function shortenHomePath(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
	return p;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function pctColor(pct: number): ThemeColor {
	if (pct >= 80) return "error";
	if (pct >= 50) return "warning";
	return "success";
}

function thinkingColor(level: string): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "thinkingHigh";
	}
}

interface CacheUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

interface CacheHitRates {
	current?: number;
	rolling5?: number;
	session?: number;
}

function tokenWeightedHitRate(
	usages: readonly CacheUsage[],
): number | undefined {
	let cacheRead = 0;
	let promptTokens = 0;

	for (const usage of usages) {
		cacheRead += usage.cacheRead;
		promptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
	}

	return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
}

function calculateCacheHitRates(usages: readonly CacheUsage[]): CacheHitRates {
	const current = tokenWeightedHitRate(usages.slice(-1));
	const rolling5 = tokenWeightedHitRate(usages.slice(-5));
	const session = tokenWeightedHitRate(usages);

	return {
		...(current === undefined ? {} : { current }),
		...(rolling5 === undefined ? {} : { rolling5 }),
		...(session === undefined ? {} : { session }),
	};
}

function formatCacheHitRates(rates: CacheHitRates): string | undefined {
	const values = [rates.current, rates.rolling5, rates.session];
	if (values.every((rate) => rate === undefined)) return undefined;

	return values
		.map((rate) => (rate === undefined ? "-" : `${Math.round(rate)}%`))
		.join("/");
}

interface Stats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRates: CacheHitRates;
}

/** Mirror Pi's built-in footer accounting; this footer only changes presentation. */
function collectStats(entries: readonly unknown[]): Stats {
	const stats: Stats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		cacheHitRates: {},
	};
	const assistantUsages: CacheUsage[] = [];

	for (const entry of entries as Array<{
		type?: string;
		message?: { role?: string; usage?: Usage };
		usage?: Usage;
	}>) {
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			usage = entry.message.usage;
			if (usage) {
				assistantUsages.push({
					input: usage.input,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				});
			}
		} else if (entry.type === "message" && entry.message?.role === "toolResult") {
			usage = entry.message.usage;
		} else if (
			(entry.type === "branch_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			usage = entry.usage;
		}

		if (!usage) continue;
		stats.input += usage.input;
		stats.output += usage.output;
		stats.cacheRead += usage.cacheRead;
		stats.cacheWrite += usage.cacheWrite;
		stats.cost += usage.cost.total;
	}

	stats.cacheHitRates = calculateCacheHitRates(assistantUsages);
	return stats;
}

function isUsingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (model.provider === "kimi-coding") return true;
	return (
		ctx.modelRegistry.isUsingOAuth(model) &&
		ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription ===
			true
	);
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function seg(
	theme: Theme,
	iconColor: ThemeColor,
	icon: string,
	value: string,
): string {
	return theme.fg(iconColor, icon) + " " + value;
}

function joinSegs(theme: Theme, parts: string[]): string {
	const sep = "  " + theme.fg("accent", I_SEP) + "  ";
	return parts.filter(Boolean).join(sep);
}

type McpStatusView = {
	connectedCount: number;
	enabledCount: number;
	connectedNames: string[];
};

/** Parse pi-mcp-adapter footer text (compact or full). */
function parseMcpFooterText(text: string): McpStatusView | undefined {
	const raw = sanitizeStatusText(text);
	// compact: "MCP 1/2"
	const compact = raw.match(/^MCP\s+(\d+)\s*\/\s*(\d+)$/i);
	if (compact) {
		return {
			connectedCount: Number(compact[1]),
			enabledCount: Number(compact[2]),
			connectedNames: [],
		};
	}
	// full: "🔌 MCP: 2 servers enabled (1 connected)" / "MCP: 1 server enabled"
	const body = raw
		.replace(/^🔌\s*/u, "")
		.replace(/^MCP[:\s]+/i, "")
		.trim();
	const full = body.match(
		/^(\d+)\s+servers?\s+enabled(?:\s+\((\d+)\s+connected\))?/i,
	);
	if (full) {
		return {
			connectedCount: full[2] ? Number(full[2]) : 0,
			enabledCount: Number(full[1]),
			connectedNames: [],
		};
	}
	return undefined;
}

function registerStatusline(pi: ExtensionAPI): void {
	let enabled = true;
	let requestRender: (() => void) | undefined;
	/** Preferred source: pi-mcp-adapter status event snapshot. */
	let mcpFromEvent: McpStatusView | undefined;
	/** Official-style session totals cached per entry count; renders between turns are O(1). */
	let statsCache: { len: number; stats: Stats } | undefined;

	pi.events.on("pi-mcp-adapter/status/v1", (data) => {
		if (typeof data !== "object" || data === null) return;
		const snap = data as {
			servers?: unknown;
			connectedCount?: unknown;
			disabledCount?: unknown;
		};
		const servers = Array.isArray(snap.servers) ? snap.servers : [];
		const connectedNames = servers
			.flatMap((server) => {
				if (typeof server !== "object" || server === null) return [];
				const { name, status } = server as {
					name?: unknown;
					status?: unknown;
				};
				return status === "connected" && typeof name === "string" ? [name] : [];
			})
			.sort((a, b) => a.localeCompare(b));
		const disabledCount =
			typeof snap.disabledCount === "number" ? snap.disabledCount : 0;
		const connectedCount =
			typeof snap.connectedCount === "number"
				? snap.connectedCount
				: connectedNames.length;
		const enabledCount = Math.max(0, servers.length - disabledCount);
		mcpFromEvent =
			enabledCount > 0 || connectedCount > 0 || servers.length > 0
				? { connectedCount, enabledCount, connectedNames }
				: undefined;
		requestRender?.();
	});

	function getStats(ctx: ExtensionContext): Stats {
		const entries = ctx.sessionManager.getEntries();
		if (statsCache?.len !== entries.length) {
			statsCache = { len: entries.length, stats: collectStats(entries) };
		}
		return statsCache.stats;
	}

	function apply(ctx: ExtensionContext) {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			requestRender = undefined;
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => {
				statsCache = undefined;
				tui.requestRender();
			});

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					return [renderLine(ctx, theme, footerData, width)];
				},
			};
		});
	}

	function renderLine(
		ctx: ExtensionContext,
		theme: Theme,
		footerData: {
			getGitBranch(): string | null;
			getExtensionStatuses(): ReadonlyMap<string, string>;
		},
		width: number,
	): string {
		const extensionStatuses = footerData.getExtensionStatuses();
		const modelName = ctx.model?.name || ctx.model?.id || "no-model";
		const fastStatus = extensionStatuses.get("openai-fast");
		const modelLabel =
			theme.bold(modelName) +
			(fastStatus === "fast" ? ` ${theme.fg("success", theme.bold("fast"))}` : "");
		const modelSeg = seg(theme, "accent", I_MODEL, modelLabel);

		const thinking = pi.getThinkingLevel();
		const effortSeg =
			thinking && thinking !== "off"
				? seg(theme, thinkingColor(thinking), I_EFFORT, thinking)
				: "";

		const dirSeg = seg(theme, "mdLink", I_DIR, shortenHomePath(ctx.cwd));
		const sessionName = ctx.sessionManager.getSessionName();
		const sessionSeg = sessionName
			? seg(theme, "muted", I_SESSION, sanitizeStatusText(sessionName))
			: "";

		const branch = footerData.getGitBranch();
		const branchSeg = branch
			? seg(theme, "warning", I_BRANCH, sanitizeStatusText(branch))
			: "";

		const usage = ctx.getContextUsage();
		let ctxSeg = "";
		if (usage) {
			const contextWindow = usage.contextWindow || ctx.model?.contextWindow || 0;
			if (usage.percent == null) {
				ctxSeg = seg(theme, "success", I_CTX, `?%/${fmtTokens(contextWindow)}`);
			} else {
				const pct = Math.round(usage.percent);
				const color = pctColor(pct);
				ctxSeg = seg(
					theme,
					"success",
					I_CTX,
					`${theme.fg(color, theme.bold(`${pct}%`))}/${fmtTokens(contextWindow)}`,
				);
			}
		}

		const stats = getStats(ctx);
		const tokenSeg =
			stats.input > 0 || stats.output > 0
				? seg(
						theme,
						"accent",
						I_TOKENS,
						`↑${fmtTokens(stats.input)} ↓${fmtTokens(stats.output)}`,
					)
				: "";
		const cacheHitRates = formatCacheHitRates(stats.cacheHitRates);
		const cacheSeg = cacheHitRates
			? seg(theme, "success", I_CACHE, cacheHitRates)
			: "";
		let costSeg = "";
		if (stats.cost > 0 || isUsingSubscription(ctx)) {
			costSeg = seg(theme, "success", I_COST, stats.cost.toFixed(3));
		}

		const mcpSegs: string[] = [];
		const extSegs: string[] = [];
		const sortedExtensionStatuses = Array.from(extensionStatuses.entries()).sort(
			([a], [b]) => a.localeCompare(b),
		);
		let hasMcpFooterStatus = false;
		let mcpFromFooter: McpStatusView | undefined;
		for (const [id, text] of sortedExtensionStatuses) {
			if (id === "pi-lens-lsp" || id === "openai-fast" || !text) continue;
			if (id === "mcp") {
				hasMcpFooterStatus = true;
				mcpFromFooter = parseMcpFooterText(text);
				continue;
			}
			if (id.startsWith("mcp-")) continue;
			extSegs.push(sanitizeStatusText(text));
		}
		// Footer presence controls visibility, preserving mcpFooterStatus="off".
		// When visible, prefer the event snapshot and fall back to parsed text.
		const mcpView = hasMcpFooterStatus
			? (mcpFromEvent ?? mcpFromFooter)
			: undefined;
		if (mcpView && mcpView.enabledCount > 0) {
			const names = (mcpFromEvent?.connectedNames ?? mcpView.connectedNames)
				.map(sanitizeStatusText)
				.filter(Boolean)
				.join(", ");
			const activeSuffix = names ? ` (${names})` : "";
			mcpSegs.push(
				seg(
					theme,
					"accent",
					I_MCP,
					`MCP: ${mcpView.connectedCount}/${mcpView.enabledCount}${activeSuffix}`,
				),
			);
		}

		const moduleSegments: Record<StatuslineModuleId, string[]> = {
			model: [modelSeg],
			effort: [effortSeg],
			directory: [dirSeg],
			session: [sessionSeg],
			branch: [branchSeg],
			context: [ctxSeg],
			tokens: [tokenSeg],
			cache: [cacheSeg],
			cost: [costSeg],
			mcp: mcpSegs,
			extensions: extSegs,
		};
		const ordered = STATUSLINE_MODULES.flatMap(({ id, enabled }) =>
			enabled ? moduleSegments[id].filter(Boolean) : [],
		);

		for (let n = ordered.length; n >= 1; n--) {
			const line = joinSegs(theme, ordered.slice(0, n));
			if (visibleWidth(line) <= width) return line;
		}

		return truncateToWidth(modelSeg, width);
	}

	pi.on("session_start", async (_event, ctx) => {
		apply(ctx);
	});

	const refresh = () => requestRender?.();
	pi.on("turn_end", refresh);
	pi.on("agent_settled", refresh);
	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);

	pi.registerCommand("statusline", {
		description: "Toggle Claude Code style statusline",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(
				enabled ? "Custom statusline enabled" : "Default footer restored",
				"info",
			);
		},
	});
}

// ─────────────────────────────────────────────────────────────
// /effort
// ─────────────────────────────────────────────────────────────

type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

const ALL_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const EFFORT_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "关闭推理",
	minimal: "极简推理",
	low: "轻度推理",
	medium: "中等推理",
	high: "深度推理",
	xhigh: "超高推理",
	max: "最大推理",
};

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (ALL_LEVELS as string[]).includes(value);
}

function availableLevels(ctx: ExtensionContext): ThinkingLevel[] {
	const model = ctx.model;
	if (!model) return ALL_LEVELS;
	return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

function modelLabel(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model) return "(no model)";
	return `${model.provider}/${model.id}`;
}

function formatEffortStatus(
	ctx: ExtensionContext,
	level: ThinkingLevel,
): string {
	const levels = availableLevels(ctx);
	return `${modelLabel(ctx)}  effort=${level}  [${levels.join(", ")}]`;
}

function centerEffortCell(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	const padding = Math.max(0, width - visibleWidth(clipped));
	const left = Math.floor(padding / 2);
	return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
}

async function pickEffortLevel(
	ctx: ExtensionContext,
	current: ThinkingLevel,
	levels: ThinkingLevel[],
): Promise<ThinkingLevel | undefined> {
	// Claude Code 风格的横向 snap slider；支持 ←/→/h/l 与 ↑/↓/j/k 导航。
	return await ctx.ui.custom<ThinkingLevel | undefined>(
		(tui, theme, kb, done) => {
			let selectedIndex = Math.max(0, levels.indexOf(current));

			const moveSelection = (delta: -1 | 1): void => {
				const next = Math.max(
					0,
					Math.min(levels.length - 1, selectedIndex + delta),
				);
				if (next === selectedIndex) return;
				selectedIndex = next;
				tui.requestRender();
			};

			return {
				render: (width: number) => {
					const selected = levels[selectedIndex]!;
					const maxLabelWidth = Math.max(
						6,
						...levels.map((level) => visibleWidth(level)),
					);
					const targetWidth = Math.min(77, width);
					const segmentWidth = Math.floor(targetWidth / levels.length);
					const panelWidth = segmentWidth * levels.length;
					const statusText = `current: ● ${current}`;
					const minHeaderWidth =
						visibleWidth("Effort") + 2 + visibleWidth(statusText);
					const useVerticalLayout =
						width < 18 || segmentWidth < maxLabelWidth || panelWidth < minHeaderWidth;

					// 宽度不足时降级为垂直模式，避免轨道、标签或状态被截断。
					if (useVerticalLayout) {
						const lines = [
							theme.fg("accent", theme.bold("Effort")),
							theme.fg("dim", "current: ") +
								theme.fg("success", "●") +
								theme.fg("muted", ` ${current}`),
							"",
						];
						for (let i = 0; i < levels.length; i++) {
							const lvl = levels[i]!;
							if (i === selectedIndex) {
								lines.push(theme.fg("accent", `→ [ ${lvl} ]`));
							} else if (lvl === current) {
								lines.push(theme.fg("success", `  ● ${lvl}`));
							} else {
								lines.push(theme.fg("muted", `    ${lvl}`));
							}
						}
						lines.push(
							"",
							theme.fg("dim", "←/→ adjust · enter confirm · esc cancel"),
						);
						return lines.map((line) => truncateToWidth(line, width));
					}

					// 标题栏优先保留右侧状态，模型名按剩余空间截断。
					const title = theme.fg("accent", theme.bold("Effort"));
					const rightStatus =
						theme.fg("dim", "current: ") +
						theme.fg("success", "●") +
						theme.fg("muted", ` ${current}`);
					const modelBudget =
						panelWidth - visibleWidth("Effort") - visibleWidth(statusText) - 2;
					const clippedModel =
						modelBudget >= 3
							? truncateToWidth(modelLabel(ctx), modelBudget - 2, "…")
							: "";
					const leftTitle =
						title + (clippedModel ? theme.fg("dim", `  ${clippedModel}`) : "");
					const headerGap = Math.max(
						2,
						panelWidth - visibleWidth(leftTitle) - visibleWidth(rightStatus),
					);

					// 两极提示（← Faster / Smarter →）
					const poleLeft = theme.fg("dim", "← Faster");
					const poleRight = theme.fg("dim", "Smarter →");
					const poleGap = Math.max(
						1,
						panelWidth - visibleWidth("← Faster") - visibleWidth("Smarter →"),
					);

					// 轨道行：根据当前节点状态渲染 ─○─ / ─●─ / ─◆─
					const trackParts: string[] = [];
					for (let i = 0; i < levels.length; i++) {
						const lvl = levels[i]!;
						const isSelected = i === selectedIndex;
						const isCurrent = lvl === current;

						let node: string;
						if (isSelected) {
							node = theme.fg("accent", theme.bold("◆"));
						} else if (isCurrent) {
							node = theme.fg("success", "●");
						} else {
							node = theme.fg("dim", "○");
						}

						const leftDash = Math.floor((segmentWidth - 1) / 2);
						const rightDash = segmentWidth - 1 - leftDash;
						trackParts.push(
							theme.fg("dim", "─".repeat(leftDash)) +
								node +
								theme.fg("dim", "─".repeat(rightDash)),
						);
					}

					// 档位标签行：选中项带方括号并高亮，当前生效项标绿
					const labelParts: string[] = [];
					for (let i = 0; i < levels.length; i++) {
						const lvl = levels[i]!;
						const isSelected = i === selectedIndex;
						const isCurrent = lvl === current;

						let labelText: string;
						if (isSelected) {
							const bracketed =
								segmentWidth >= lvl.length + 4
									? `[ ${lvl} ]`
									: segmentWidth >= lvl.length + 2
										? `[${lvl}]`
										: lvl;
							labelText = theme.fg(
								"accent",
								theme.bold(centerEffortCell(bracketed, segmentWidth)),
							);
						} else if (isCurrent) {
							labelText = theme.fg("success", centerEffortCell(lvl, segmentWidth));
						} else {
							labelText = theme.fg("muted", centerEffortCell(lvl, segmentWidth));
						}
						labelParts.push(labelText);
					}

					const lines = [
						leftTitle + " ".repeat(headerGap) + rightStatus,
						"",
						poleLeft + " ".repeat(poleGap) + poleRight,
						trackParts.join(""),
						labelParts.join(""),
						"",
						theme.fg("dim", "←/→ adjust · enter confirm · esc cancel"),
					];

					return lines.map((line) => truncateToWidth(line, width));
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					const previous =
						kb.matches(data, "tui.editor.cursorLeft") ||
						kb.matches(data, "tui.select.up") ||
						data === "h" ||
						data === "k";
					const next =
						kb.matches(data, "tui.editor.cursorRight") ||
						kb.matches(data, "tui.select.down") ||
						data === "l" ||
						data === "j";

					if (previous) {
						moveSelection(-1);
					} else if (next) {
						moveSelection(1);
					} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
						done(levels[selectedIndex]);
					} else if (kb.matches(data, "tui.select.cancel")) {
						done(undefined);
					}
				},
			};
		},
	);
}
function applyLevel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	level: ThinkingLevel,
): void {
	const before = pi.getThinkingLevel() as ThinkingLevel;
	const levels = availableLevels(ctx);

	if (!levels.includes(level)) {
		ctx.ui.notify(
			`当前模型不支持 "${level}"。可用: ${levels.join(", ")}`,
			"warning",
		);
		return;
	}

	pi.setThinkingLevel(level);
	const after = pi.getThinkingLevel() as ThinkingLevel;

	if (after === before) {
		ctx.ui.notify(`effort 已是 ${after}`, "info");
		return;
	}

	if (after !== level) {
		ctx.ui.notify(
			`effort ${before} → ${after}（请求 ${level}，已按模型能力调整）`,
			"info",
		);
		return;
	}

	ctx.ui.notify(`effort ${before} → ${after}`, "info");
}

function registerEffort(pi: ExtensionAPI): void {
	pi.registerCommand("effort", {
		description: "调节 thinking / reasoning 强度（effort）",
		getArgumentCompletions: (prefix) => {
			const raw = prefix.trim().toLowerCase();
			const options = [...ALL_LEVELS, "status", "show", "current"];
			const matched = options.filter((item) => item.startsWith(raw));
			if (matched.length === 0) return null;
			return matched.map((item) => ({
				value: item,
				label: item,
				description: isThinkingLevel(item)
					? EFFORT_DESCRIPTIONS[item]
					: "显示当前 effort",
			}));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const current = pi.getThinkingLevel() as ThinkingLevel;
			const levels = availableLevels(ctx);

			if (arg === "status" || arg === "show" || arg === "current") {
				ctx.ui.notify(formatEffortStatus(ctx, current), "info");
				return;
			}

			if (!arg) {
				if (levels.length === 0) {
					ctx.ui.notify("当前模型没有可用的 effort 档位", "warning");
					return;
				}

				const level = await pickEffortLevel(ctx, current, levels);
				if (!level) return;

				applyLevel(pi, ctx, level);
				return;
			}

			if (!isThinkingLevel(arg)) {
				ctx.ui.notify(
					`未知 effort: "${arg}"。可用: ${levels.join(", ")} 或 status`,
					"warning",
				);
				return;
			}

			applyLevel(pi, ctx, arg);
		},
	});
}

// ─────────────────────────────────────────────────────────────
// Terminal title (summary-backed, not raw prompt)
// ─────────────────────────────────────────────────────────────

const TITLE_MAX = 48;
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function clipTitle(value: string, max = TITLE_MAX): string {
	const s = value.replace(/\s+/g, " ").trim();
	if (s.length <= max) return s;
	if (max <= 1) return "…";
	return `${s.slice(0, max - 1)}…`;
}

function extractGoalFromSummary(summary: string): string | undefined {
	const goalBlock = summary.match(/##\s*Goal\s*\n+([\s\S]*?)(?=\n##\s|\n<|$)/i);
	if (goalBlock?.[1]) {
		const line = goalBlock[1]
			.split("\n")
			.map((l) => l.replace(/^[-*]\s*/, "").trim())
			.find((l) => l && !l.startsWith("#") && !/^\[.*\]$/.test(l));
		if (line) return line;
	}

	// unstructured fallback: first meaningful line
	const line = summary
		.split("\n")
		.map((l) => l.trim())
		.find(
			(l) =>
				l &&
				!l.startsWith("#") &&
				!l.startsWith("<") &&
				!l.startsWith("-") &&
				!/^\[.*\]$/.test(l),
		);
	return line;
}

function latestSummaryTask(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; summary?: string };
		if (
			(entry.type === "compaction" || entry.type === "branch_summary") &&
			typeof entry.summary === "string" &&
			entry.summary.trim()
		) {
			const goal = extractGoalFromSummary(entry.summary);
			if (goal) return goal;
		}
	}
	return undefined;
}

/** True for `/cmd` / `/cmd args`, false for absolute paths like `/var/...` or `/Users/...`. */
function isSlashCommandText(text: string): boolean {
	if (!text.startsWith("/")) return false;
	const firstToken = text.slice(1).split(/\s/, 1)[0] ?? "";
	if (!firstToken || firstToken.includes("/")) return false;
	return /^[a-zA-Z][\w-]*$/.test(firstToken);
}

function userMessageText(content: unknown): string | undefined {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.filter(
				(c): c is { type: string; text?: string } =>
					!!c && typeof c === "object" && (c as { type?: string }).type === "text",
			)
			.map((c) => c.text ?? "")
			.join("\n");
	}
	text = text.replace(/\s+/g, " ").trim();
	// skip real slash-commands / empty — not filesystem paths that start with /
	if (!text || isSlashCommandText(text)) return undefined;
	return text;
}

/** Recent real user prompts on the active branch (chronological). */
function listUserPrompts(ctx: ExtensionContext, limit = 8): string[] {
	const out: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = (entry as { message?: { role?: string; content?: unknown } })
			.message;
		if (msg?.role !== "user") continue;
		const text = userMessageText(msg.content);
		if (text) out.push(text);
	}
	return out.slice(-Math.max(1, limit));
}

/**
 * Build summarize input from recent turns.
 * `key` is the latest user prompt — a new user message triggers refresh.
 * `pendingPrompt` covers before_agent_start, where the new user message
 * may not be in the session branch yet.
 */
function buildSummarizeSource(
	ctx: ExtensionContext,
	pendingPrompt?: string,
): { key: string; text: string } | undefined {
	const prompts = listUserPrompts(ctx, 8);
	if (pendingPrompt) {
		const pending = pendingPrompt.replace(/\s+/g, " ").trim();
		if (
			pending &&
			!isSlashCommandText(pending) &&
			prompts[prompts.length - 1] !== pending
		) {
			prompts.push(pending);
		}
	}
	if (prompts.length === 0) return undefined;

	const recent = prompts.slice(-4);
	const latest = recent[recent.length - 1];
	if (!latest || latest.length < 4) return undefined;

	const text =
		recent.length === 1
			? latest
			: recent
					.map((p, i) => {
						const body = p.slice(0, 400);
						return i === recent.length - 1
							? `Current task:\n${body}`
							: `Earlier:\n${body}`;
					})
					.join("\n\n");

	return { key: latest, text };
}

/** Lowest thinking level the model supports; "off" → omit the option entirely. */
function lowestThinkingEffort(
	model: NonNullable<ExtensionContext["model"]>,
): ThinkingLevel | undefined {
	const lowest = getSupportedThinkingLevels(model)[0];
	return lowest === "off" ? undefined : (lowest as ThinkingLevel);
}

async function summarizeTaskTitle(
	ctx: ExtensionContext,
	sourceText: string,
): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return undefined;

	const instruction =
		"Summarize the user's CURRENT coding task into a short terminal title.\n" +
		"If earlier messages are provided, treat them as context only; title the latest goal.\n" +
		"Rules:\n" +
		"- At most 12 Chinese characters OR 6 English words\n" +
		"- No quotes, no trailing punctuation, no explanation\n" +
		"- Prefer verb + object (e.g. 修复登录态 / Add title summary)\n" +
		"- Output ONLY the title\n\n" +
		`${sourceText.slice(0, 1600)}`;

	try {
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text" as const, text: instruction }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				reasoningEffort: lowestThinkingEffort(model),
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
		);

		const raw = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ")
			.replace(/[\r\n]+/g, " ")
			.replace(/^[-*"'`]+|[-*"'`]+$/g, "")
			.trim();

		if (!raw || raw.length > 80) return undefined;
		return clipTitle(raw, 36);
	} catch {
		return undefined;
	}
}

function registerTerminalTitle(pi: ExtensionAPI): void {
	let taskSummary = "";
	let autoNamed = false;
	let summarizing = false;
	let working = false;
	/** Latest user-prompt key we already attempted (one LLM call per prompt, success or not). */
	let lastSummarizedKey = "";
	/** Circuit breaker: consecutive failures disable auto-titles for this session. */
	let summarizeFailures = 0;
	let summarizeDisabled = false;
	const MAX_SUMMARIZE_FAILURES = 3;
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let lastCtx: ExtensionContext | undefined;

	const resolveTask = (ctx: ExtensionContext): string => {
		const named = pi.getSessionName()?.trim();
		if (named) return named;

		const fromCompaction = latestSummaryTask(ctx);
		if (fromCompaction) return clipTitle(fromCompaction, 36);

		return taskSummary;
	};

	const paint = (ctx?: ExtensionContext, forceWorking?: boolean) => {
		const active = ctx ?? lastCtx;
		if (!active?.hasUI) return;
		lastCtx = active;

		const cwd = basename(active.cwd || process.cwd()) || "pi";
		const task = resolveTask(active);
		const isWorking = forceWorking ?? working;
		const mid = task || cwd;

		if (isWorking) {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			active.ui.setTitle(`${frame} π · ${mid} · ${cwd}`);
		} else {
			active.ui.setTitle(`π · ${mid} · ${cwd}`);
		}
	};

	const stopSpinner = (ctx?: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		working = false;
		paint(ctx, false);
	};

	const startSpinner = (ctx: ExtensionContext) => {
		working = true;
		lastCtx = ctx;
		if (timer) clearInterval(timer);
		frameIndex = 0;
		paint(ctx, true);
		timer = setInterval(() => {
			frameIndex++;
			paint(undefined, true);
		}, 80);
	};

	const adoptSummary = (
		ctx: ExtensionContext,
		summary: string,
		opts?: { setName?: boolean },
	) => {
		const next = clipTitle(summary, 36);
		if (!next) return;
		taskSummary = next;

		const currentName = pi.getSessionName()?.trim();
		if (opts?.setName !== false && (!currentName || autoNamed)) {
			if (currentName === next) {
				autoNamed = true;
			} else {
				// Mark auto before setSessionName so session_info_changed keeps autoNamed.
				autoNamed = true;
				pi.setSessionName(next);
			}
		}
		paint(ctx);
	};

	const maybeAutoSummarize = async (
		ctx: ExtensionContext,
		pendingPrompt?: string,
	) => {
		if (summarizing || summarizeDisabled) return;

		const named = pi.getSessionName()?.trim();
		// Manual /name (or resumed pre-named session): do not overwrite.
		if (named && !autoNamed) return;

		const source = buildSummarizeSource(ctx, pendingPrompt);
		if (!source) {
			if (!named && !taskSummary) {
				const fromCompaction = latestSummaryTask(ctx);
				if (fromCompaction) {
					adoptSummary(ctx, fromCompaction, { setName: true });
				}
			}
			return;
		}

		// One attempt per user turn — a failed attempt doesn't retry until a new prompt.
		if (source.key === lastSummarizedKey) return;

		summarizing = true;
		lastSummarizedKey = source.key;
		try {
			const title = await summarizeTaskTitle(ctx, source.text);
			if (!title) {
				summarizeFailures++;
				if (summarizeFailures >= MAX_SUMMARIZE_FAILURES) {
					summarizeDisabled = true;
					ctx.ui.notify(
						"Auto session title disabled (summarize kept failing); /name to set one manually",
						"warning",
					);
				}
				return;
			}
			summarizeFailures = 0;

			// Re-check lock in case user /name'd during the request.
			const nameNow = pi.getSessionName()?.trim();
			if (nameNow && !autoNamed) return;

			if (title === (nameNow || taskSummary)) {
				autoNamed = true;
				taskSummary = title;
				return;
			}
			adoptSummary(ctx, title, { setName: true });
		} finally {
			summarizing = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		taskSummary = "";
		autoNamed = false;
		summarizing = false;
		lastSummarizedKey = "";
		summarizeFailures = 0;
		summarizeDisabled = false;
		stopSpinner(ctx);

		const named = pi.getSessionName()?.trim();
		if (named) {
			// Resumed / pre-named: treat as manual lock until /unname.
			taskSummary = named;
			autoNamed = false;
		} else {
			const fromCompaction = latestSummaryTask(ctx);
			if (fromCompaction) adoptSummary(ctx, fromCompaction, { setName: true });
		}
		paint(ctx, false);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		const named = pi.getSessionName()?.trim();
		if (named) {
			// manual /name or RPC rename wins when it differs from our auto title
			if (!autoNamed || named !== taskSummary) {
				autoNamed = false;
				// New manual name: don't immediately re-auto on same prompt.
				const latest = listUserPrompts(ctx, 1)[0];
				if (latest) lastSummarizedKey = latest;
			}
			taskSummary = named;
		} else {
			// explicit clear (/unname or empty session_info)
			taskSummary = "";
			autoNamed = false;
			lastSummarizedKey = "";
		}
		paint(ctx);
	});

	pi.registerCommand("unname", {
		description: "清除 session 显示名；下一轮 settle 按最新任务自动 summary",
		handler: async (_args, ctx) => {
			const prev = pi.getSessionName()?.trim();
			if (!prev && !taskSummary) {
				ctx.ui.notify("Session name already empty", "info");
				paint(ctx);
				return;
			}

			// Core treats empty name as clear (getSessionName -> undefined).
			pi.setSessionName("");
			taskSummary = "";
			autoNamed = false;
			lastSummarizedKey = "";
			paint(ctx, false);
			ctx.ui.notify(
				prev ? `Session name cleared (was: ${prev})` : "Session name cleared",
				"info",
			);
		},
	});

	pi.on("session_compact", async (event, ctx) => {
		const summary = event.compactionEntry?.summary;
		if (!summary) return;
		const goal = extractGoalFromSummary(summary);
		if (goal) adoptSummary(ctx, goal, { setName: true });
	});

	pi.on("session_tree", async (event, ctx) => {
		const summary = event.summaryEntry?.summary;
		if (summary) {
			const goal = extractGoalFromSummary(summary);
			if (goal) adoptSummary(ctx, goal, { setName: true });
			return;
		}
		// tree nav may land on a branch that already has compaction
		const fromCompaction = latestSummaryTask(ctx);
		if (fromCompaction && (!pi.getSessionName()?.trim() || autoNamed)) {
			adoptSummary(ctx, fromCompaction, { setName: true });
		} else {
			paint(ctx);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Summarize in parallel with the agent run so the title updates while
		// it is still thinking; agent_settled stays as the deduped fallback.
		if (!ctx.hasUI) return;
		void maybeAutoSummarize(ctx, event.prompt);
	});

	pi.on("agent_start", async (_event, ctx) => {
		startSpinner(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopSpinner(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await maybeAutoSummarize(ctx);
		paint(ctx, false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopSpinner(ctx);
	});
}

// ─────────────────────────────────────────────────────────────
// Turn duration (chat transcript, not sent to the model)
// ─────────────────────────────────────────────────────────────

const TURN_DURATION_TYPE = "session-ui:turn-duration";
const I_DURATION = "\u{F051B}"; // nf-md-timer-outline

type TurnDurationData = {
	ms: number;
	startedAt: number;
	endedAt: number;
};

function formatTurnDuration(ms: number): string {
	const clamped = Math.max(0, ms);
	if (clamped < 10_000) return `${(clamped / 1000).toFixed(1)}s`;

	const totalSec = Math.round(clamped / 1000);
	if (totalSec < 60) return `${totalSec}s`;

	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) {
		const parts = [`${hours}h`];
		if (minutes > 0) parts.push(`${minutes}m`);
		if (seconds > 0) parts.push(`${seconds}s`);
		return parts.join(" ");
	}
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function registerTurnDuration(pi: ExtensionAPI): void {
	let startedAt: number | undefined;

	const markStart = () => {
		if (startedAt === undefined) startedAt = Date.now();
	};

	const emit = (endedAt: number) => {
		if (startedAt === undefined) return;
		const started = startedAt;
		startedAt = undefined;
		pi.appendEntry<TurnDurationData>(TURN_DURATION_TYPE, {
			ms: Math.max(0, endedAt - started),
			startedAt: started,
			endedAt,
		});
	};

	pi.registerEntryRenderer<TurnDurationData>(
		TURN_DURATION_TYPE,
		(entry, _options, theme) => {
			const ms = entry.data?.ms ?? 0;
			return new Text(
				theme.fg("dim", `${I_DURATION} ${formatTurnDuration(ms)}`),
				0,
				0,
			);
		},
	);

	// First start wins so retries / compaction / follow-ups stay one wall clock.
	pi.on("before_agent_start", async () => {
		markStart();
	});
	pi.on("agent_start", async () => {
		markStart();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Snapshot immediately: later settled handlers are awaited serially
		// (title summarize in this file, then other extensions).
		const endedAt = startedAt === undefined ? undefined : Date.now();
		// Another extension may have started a new run; keep the clock running.
		if (endedAt === undefined || !ctx.isIdle()) return;
		emit(endedAt);
	});

	pi.on("session_start", async () => {
		startedAt = undefined;
	});
	pi.on("session_shutdown", async () => {
		startedAt = undefined;
	});
}

// ─────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────

export default function sessionUi(pi: ExtensionAPI) {
	// Duration first so its settled snapshot precedes title summarize.
	registerTurnDuration(pi);
	registerToolRows(pi);
	registerCompactPasteEditor(pi);
	registerStatusline(pi);
	registerEffort(pi);
	registerTerminalTitle(pi);
}
