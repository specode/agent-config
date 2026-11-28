import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	extractCopyItems,
	sanitizePreviewLine,
	stripTerminalControl,
	type AssistantMessageSnapshot,
	type CopyItem,
} from "./extract.ts";

export type CopyBlockPickerAction =
	| { action: "copy"; item: CopyItem }
	| { action: "edit"; item: CopyItem };

export interface PickerUiHelpers {
	visibleWidth: (text: string) => number;
	truncateToWidth: (text: string, maxWidth: number, ellipsis?: string) => string;
	matchesKey: (data: string, key: string) => boolean;
	highlightCode?: (code: string, lang?: string) => string[];
}

export interface CopyBlockPickerOptions {
	messages: readonly AssistantMessageSnapshot[];
	/** 0-based index into `messages` (0 = latest reply). */
	initialMessageOffset: number;
	tui: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } };
	theme: Pick<Theme, "fg" | "bold">;
	keybindings: Pick<KeybindingsManager, "matches">;
	helpers: PickerUiHelpers;
	onDone: (result: CopyBlockPickerAction | undefined) => void;
}

const MAX_VISIBLE_ITEMS = 7;
const MAX_PREVIEW_LINES = 14;
const OVERLAY_HEIGHT_RATIO = 0.82;
/** Chrome rows with subtitle: top, header, subtitle, 3 dividers, footer, bottom. */
const CHROME_ROWS_FULL = 8;
/** Chrome rows without subtitle on very short terminals. */
const CHROME_ROWS_COMPACT = 7;

/**
 * Interactive overlay picker for selecting and copying raw Markdown blocks
 * (code blocks, blockquotes, or full replies) with live preview and reply stepping.
 */
export class CopyBlockPickerComponent implements Component {
	private readonly messages: readonly AssistantMessageSnapshot[];
	private readonly tui: CopyBlockPickerOptions["tui"];
	private readonly theme: CopyBlockPickerOptions["theme"];
	private readonly keybindings: CopyBlockPickerOptions["keybindings"];
	private readonly helpers: PickerUiHelpers;
	private readonly onDone: CopyBlockPickerOptions["onDone"];

	private messageOffset: number;
	private items: CopyItem[] = [];
	private selectedIndex = 0;
	private listScrollOffset = 0;
	private previewScrollOffset = 0;
	private cachedHighlightedItem: CopyItem | undefined;
	private cachedPreviewLines: string[] = [];
	private cachedWidth: number | undefined;
	private cachedRows: number | undefined;
	private cachedLines: string[] | undefined;
	private lastItemRowStart = 0;
	private lastVisibleItems: { start: number; count: number } = {
		start: 0,
		count: 0,
	};
	private lastPreviewHeight = 1;

	constructor(options: CopyBlockPickerOptions) {
		this.messages = options.messages;
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.helpers = options.helpers;
		this.onDone = options.onDone;
		this.messageOffset = Math.max(
			0,
			Math.min(options.messages.length - 1, options.initialMessageOffset),
		);
		this.loadCurrentMessage();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
		this.cachedLines = undefined;
		this.cachedHighlightedItem = undefined;
	}

	private loadCurrentMessage(): void {
		const current = this.messages[this.messageOffset];
		this.items = current ? extractCopyItems(current.text) : [];
		this.selectedIndex = 0;
		this.listScrollOffset = 0;
		this.previewScrollOffset = 0;
		this.cachedHighlightedItem = undefined;
		this.cachedLines = undefined;
	}

	private getSelectedItem(): CopyItem | undefined {
		return this.items[this.selectedIndex];
	}

	private getFullItem(): CopyItem | undefined {
		return this.items.find((item) => item.kind === "full") ?? this.items[0];
	}

	private getPreviewLines(item: CopyItem): string[] {
		if (this.cachedHighlightedItem === item) {
			return this.cachedPreviewLines;
		}
		// Strip terminal control/escape sequences from untrusted content before
		// optional syntax highlighting so only highlighter SGR styling appears.
		const safeContent = stripTerminalControl(item.content);
		let lines: string[];
		if (item.kind === "code" && this.helpers.highlightCode) {
			try {
				lines = this.helpers.highlightCode(safeContent, item.lang);
			} catch {
				lines = safeContent.split("\n");
			}
		} else {
			lines = safeContent.split("\n");
		}
		this.cachedHighlightedItem = item;
		this.cachedPreviewLines = lines;
		return lines;
	}

	private computeLayoutBudgets(termRows: number): {
		showSubtitle: boolean;
		maxListRows: number;
		previewRows: number;
	} {
		const maxOverlayRows = Math.max(
			1,
			Math.min(Math.floor(termRows * OVERLAY_HEIGHT_RATIO), Math.max(1, termRows - 2)),
		);
		const showSubtitle = maxOverlayRows >= CHROME_ROWS_FULL + 3;
		const chrome = showSubtitle ? CHROME_ROWS_FULL : CHROME_ROWS_COMPACT;
		const contentBudget = Math.max(2, maxOverlayRows - chrome);

		const itemCount = Math.max(1, this.items.length);
		const desiredList = Math.min(
			MAX_VISIBLE_ITEMS,
			itemCount,
			Math.max(1, Math.floor(contentBudget * 0.45)),
		);
		const maxListRows = Math.max(1, Math.min(desiredList, contentBudget - 1));
		const previewRows = Math.max(
			1,
			Math.min(MAX_PREVIEW_LINES, contentBudget - maxListRows),
		);
		return { showSubtitle, maxListRows, previewRows };
	}

	private ensureSelectionVisible(maxListRows: number): void {
		if (this.selectedIndex < this.listScrollOffset) {
			this.listScrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.listScrollOffset + maxListRows) {
			this.listScrollOffset = this.selectedIndex - maxListRows + 1;
		}
		const maxOffset = Math.max(0, this.items.length - maxListRows);
		this.listScrollOffset = Math.max(0, Math.min(maxOffset, this.listScrollOffset));
	}

	private moveSelection(delta: number): void {
		if (this.items.length === 0) return;
		this.selectedIndex =
			(this.selectedIndex + delta + this.items.length) % this.items.length;
		this.previewScrollOffset = 0;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	private selectIndex(index: number): void {
		if (index < 0 || index >= this.items.length || index === this.selectedIndex) {
			return;
		}
		this.selectedIndex = index;
		this.previewScrollOffset = 0;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	private switchMessage(delta: number): void {
		if (this.messages.length <= 1) return;
		const next = this.messageOffset + delta;
		if (next < 0 || next >= this.messages.length) return;
		this.messageOffset = next;
		this.loadCurrentMessage();
		this.tui.requestRender();
	}

	private scrollPreview(delta: number): void {
		const item = this.getSelectedItem();
		if (!item) return;
		const total = this.getPreviewLines(item).length;
		const maxOffset = Math.max(0, total - this.lastPreviewHeight);
		const next = Math.max(0, Math.min(maxOffset, this.previewScrollOffset + delta));
		if (next === this.previewScrollOffset) return;
		this.previewScrollOffset = next;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const { matchesKey } = this.helpers;

		if (
			this.keybindings.matches(data, "tui.select.cancel") ||
			matchesKey(data, "q")
		) {
			this.onDone(undefined);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const item = this.getSelectedItem();
			this.onDone(item ? { action: "copy", item } : undefined);
			return;
		}

		if (
			this.keybindings.matches(data, "tui.select.up") ||
			matchesKey(data, "k")
		) {
			this.moveSelection(-1);
			return;
		}

		if (
			this.keybindings.matches(data, "tui.select.down") ||
			matchesKey(data, "j")
		) {
			this.moveSelection(1);
			return;
		}

		// Left / h / [ steps back to an older reply; Right / l / ] steps to a newer reply.
		if (
			matchesKey(data, "left") ||
			matchesKey(data, "h") ||
			matchesKey(data, "[")
		) {
			this.switchMessage(1);
			return;
		}

		if (
			matchesKey(data, "right") ||
			matchesKey(data, "l") ||
			matchesKey(data, "]")
		) {
			this.switchMessage(-1);
			return;
		}

		if (
			this.keybindings.matches(data, "tui.select.pageDown") ||
			matchesKey(data, "ctrl+d")
		) {
			this.scrollPreview(Math.max(1, Math.floor(this.lastPreviewHeight / 2)));
			return;
		}

		if (
			this.keybindings.matches(data, "tui.select.pageUp") ||
			matchesKey(data, "ctrl+u")
		) {
			this.scrollPreview(-Math.max(1, Math.floor(this.lastPreviewHeight / 2)));
			return;
		}

		if (matchesKey(data, "shift+e")) {
			const full = this.getFullItem();
			if (full) this.onDone({ action: "edit", item: full });
			return;
		}

		if (matchesKey(data, "e")) {
			const item = this.getSelectedItem();
			if (item) this.onDone({ action: "edit", item });
			return;
		}

		if (matchesKey(data, "f")) {
			const full = this.getFullItem();
			if (full) this.onDone({ action: "copy", item: full });
			return;
		}

		for (let n = 1; n <= 9; n++) {
			if (matchesKey(data, String(n))) {
				this.selectIndex(n - 1);
				return;
			}
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			if (event.y >= this.lastItemRowStart + this.lastVisibleItems.count) {
				this.scrollPreview(event.wheelDelta);
			} else {
				this.moveSelection(event.wheelDelta > 0 ? 1 : -1);
			}
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			const listRow = event.y - this.lastItemRowStart;
			if (listRow >= 0 && listRow < this.lastVisibleItems.count) {
				const targetIndex = this.lastVisibleItems.start + listRow;
				if (targetIndex === this.selectedIndex && (event.clickCount ?? 1) >= 2) {
					const item = this.getSelectedItem();
					if (item) this.onDone({ action: "copy", item });
				} else {
					this.selectIndex(targetIndex);
				}
				return { handled: true, render: false };
			}
		}
		return undefined;
	}

	private boxLine(content: string, innerWidth: number): string {
		const { visibleWidth, truncateToWidth } = this.helpers;
		const truncated = truncateToWidth(content, innerWidth, "…");
		const pad = Math.max(0, innerWidth - visibleWidth(truncated));
		const border = (s: string) => this.theme.fg("border", s);
		return `${border("│")} ${truncated}${" ".repeat(pad)} ${border("│")}`;
	}

	private dividerLine(innerWidth: number, title?: string): string {
		const { visibleWidth, truncateToWidth } = this.helpers;
		const border = (s: string) => this.theme.fg("border", s);
		const total = innerWidth + 2;
		if (!title) {
			return border(`├${"─".repeat(total)}┤`);
		}
		const label = truncateToWidth(` ${title} `, Math.max(0, total - 2), "…");
		const labelWidth = visibleWidth(label);
		const rightRule = Math.max(0, total - 1 - labelWidth);
		return `${border("├─")}${this.theme.fg("muted", label)}${border("─".repeat(rightRule))}${border("┤")}`;
	}

	private buildFooter(innerWidth: number): string {
		const hasMultiple = this.messages.length > 1;
		const candidates = hasMultiple
			? [
					"Enter copy · e/E edit · f full · ←/→ reply · Esc cancel",
					"Enter copy · e edit · f full · ←/→ · Esc",
					"Enter copy · e edit · Esc",
				]
			: [
					"Enter copy · e edit · E edit full · f full · Esc cancel",
					"Enter copy · e/E edit · f full · Esc",
					"Enter copy · e edit · Esc",
				];
		for (const candidate of candidates) {
			if (this.helpers.visibleWidth(candidate) <= innerWidth) {
				return candidate;
			}
		}
		return candidates[candidates.length - 1]!;
	}

	render(width: number): string[] {
		const termRows = this.tui.terminal?.rows ?? 32;
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedRows === termRows
		) {
			return this.cachedLines;
		}

		const innerWidth = Math.max(0, width - 4);
		if (width < 4) {
			const fallback = [this.helpers.truncateToWidth("Copy", width, "")];
			this.cachedWidth = width;
			this.cachedRows = termRows;
			this.cachedLines = fallback;
			return fallback;
		}
		const border = (s: string) => this.theme.fg("border", s);
		const { showSubtitle, maxListRows, previewRows } =
			this.computeLayoutBudgets(termRows);
		this.lastPreviewHeight = previewRows;
		this.ensureSelectionVisible(maxListRows);

		const currentMsg = this.messages[this.messageOffset];
		const replyPos = `${this.messageOffset + 1}/${this.messages.length}`;
		const lines: string[] = [];

		lines.push(border(`╭${"─".repeat(innerWidth + 2)}╮`));

		const headerLeft = this.theme.bold(this.theme.fg("accent", "Copy Block"));
		const wideBadge =
			this.messages.length > 1
				? `Reply ${replyPos} (← older · newer →)`
				: `Reply ${replyPos}`;
		const shortBadge = `Reply ${replyPos}`;
		const badgeText =
			this.helpers.visibleWidth(headerLeft) +
				1 +
				this.helpers.visibleWidth(wideBadge) <=
			innerWidth
				? wideBadge
				: shortBadge;
		const replyBadge = this.theme.fg("muted", badgeText);
		const gap = Math.max(
			1,
			innerWidth -
				this.helpers.visibleWidth(headerLeft) -
				this.helpers.visibleWidth(replyBadge),
		);
		lines.push(
			this.boxLine(`${headerLeft}${" ".repeat(gap)}${replyBadge}`, innerWidth),
		);

		if (showSubtitle) {
			const replySnippet = currentMsg
				? this.theme.fg("dim", sanitizePreviewLine(currentMsg.preview, innerWidth))
				: this.theme.fg("dim", "(no assistant reply)");
			lines.push(this.boxLine(replySnippet, innerWidth));
		}

		lines.push(this.dividerLine(innerWidth));

		this.lastItemRowStart = lines.length;
		const visibleEnd = Math.min(
			this.items.length,
			this.listScrollOffset + maxListRows,
		);
		this.lastVisibleItems = {
			start: this.listScrollOffset,
			count: Math.max(0, visibleEnd - this.listScrollOffset),
		};

		for (let i = this.listScrollOffset; i < visibleEnd; i++) {
			const item = this.items[i]!;
			const selected = i === this.selectedIndex;
			const cursor = selected ? this.theme.fg("accent", "▸ ") : "  ";
			const num = i < 9 ? `${i + 1}. ` : "   ";
			const lineNoun = item.lineCount === 1 ? "line" : "lines";
			const tag = `${item.label} (${item.lineCount} ${lineNoun})`;
			const styledTag = selected
				? this.theme.bold(this.theme.fg("accent", tag))
				: this.theme.fg("text", tag);
			const separator = this.theme.fg("dim", " — ");
			const snippet = this.theme.fg("muted", item.previewLine);
			lines.push(
				this.boxLine(
					`${cursor}${this.theme.fg("dim", num)}${styledTag}${separator}${snippet}`,
					innerWidth,
				),
			);
		}

		const selectedItem = this.getSelectedItem();
		const previewAll = selectedItem ? this.getPreviewLines(selectedItem) : [];
		const maxPreviewOffset = Math.max(0, previewAll.length - previewRows);
		if (this.previewScrollOffset > maxPreviewOffset) {
			this.previewScrollOffset = maxPreviewOffset;
		}
		const previewSlice = previewAll.slice(
			this.previewScrollOffset,
			this.previewScrollOffset + previewRows,
		);

		const rangeLabel =
			previewAll.length > previewRows
				? `Preview · lines ${this.previewScrollOffset + 1}-${this.previewScrollOffset + previewSlice.length}/${previewAll.length} (PgUp/PgDn)`
				: "Preview";
		lines.push(this.dividerLine(innerWidth, rangeLabel));

		for (let row = 0; row < previewRows; row++) {
			const rawLine = previewSlice[row];
			if (rawLine === undefined) {
				lines.push(this.boxLine("", innerWidth));
			} else {
				const expanded = rawLine.replace(/\t/g, "  ");
				lines.push(this.boxLine(expanded, innerWidth));
			}
		}

		lines.push(this.dividerLine(innerWidth));
		lines.push(this.boxLine(this.theme.fg("dim", this.buildFooter(innerWidth)), innerWidth));
		lines.push(border(`╰${"─".repeat(innerWidth + 2)}╯`));

		this.cachedWidth = width;
		this.cachedRows = termRows;
		this.cachedLines = lines;
		return lines;
	}
}
