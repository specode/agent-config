import { basename } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

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
	// Reuse Pi's native registry so submission, undo, deletion, and history still
	// expand placeholders through the normal editor path. Runtime guards keep
	// private-editor changes from breaking input.
	// SAFETY: CustomEditor inherits Pi Editor's runtime `pastes` and
	// `pasteCounter` fields; the Map guard below validates them before use.
	const candidate = editor as unknown as Partial<EditorPasteRegistry>;
	if (!(candidate.pastes instanceof Map)) {
		throw new Error("Pi editor paste registry is unavailable");
	}
	return candidate as EditorPasteRegistry;
}

export function isClipboardImagePath(value: string): boolean {
	return CLIPBOARD_IMAGE_RE.test(basename(value));
}

function compactPasteCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) {
		return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
	}
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function pasteSize(content: string): string {
	const lines = content.split("\n").length;
	return lines > 10
		? `${compactPasteCount(lines)} lines`
		: `${compactPasteCount(content.length)} chars`;
}

type MarkerSpacingEdit = {
	line: string;
	markerStart: number;
	markerEnd: number;
	leadingLength: number;
	trailingLength: number;
};

function addPasteMarkerSpacing(
	line: string,
	pasteId: number,
): MarkerSpacingEdit | undefined {
	for (const match of line.matchAll(
		/\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g,
	)) {
		if (Number(match[1]) !== pasteId || match.index === undefined) continue;
		const markerStart = match.index;
		const markerEnd = markerStart + match[0].length;
		const before = line[markerStart - 1] ?? "";
		const after = line[markerEnd] ?? "";
		const leadingSpace = before && !/\s/.test(before) ? " " : "";
		const trailingSpace = after && /\s/.test(after) ? "" : " ";
		if (!leadingSpace && !trailingSpace) return undefined;
		return {
			line:
				line.slice(0, markerStart) +
				leadingSpace +
				match[0] +
				trailingSpace +
				line.slice(markerEnd),
			markerStart,
			markerEnd,
			leadingLength: leadingSpace.length,
			trailingLength: trailingSpace.length,
		};
	}
	return undefined;
}

export class CompactPasteEditor extends CustomEditor {
	onCompatibilityFallback?: (reason: string) => void;
	private compatibilityWarningShown = false;

	checkCompatibility(): void {
		try {
			pasteRegistry(this);
			// SAFETY: CustomEditor inherits Pi Editor's runtime state; every field
			// used by this adapter is validated immediately below.
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
		// SAFETY: checkCompatibility validates this inherited Editor state before
		// the editor is installed; failures fall back to Pi's native behavior.
		const internal = this as unknown as EditorStateAccess;
		for (
			let lineIndex = 0;
			lineIndex < internal.state.lines.length;
			lineIndex++
		) {
			const edit = addPasteMarkerSpacing(
				internal.state.lines[lineIndex] ?? "",
				pasteId,
			);
			if (!edit) continue;
			internal.state.lines[lineIndex] = edit.line;

			if (internal.state.cursorLine === lineIndex) {
				if (
					edit.leadingLength > 0 &&
					internal.state.cursorCol >= edit.markerStart
				) {
					internal.state.cursorCol += edit.leadingLength;
				}
				if (edit.trailingLength > 0 && internal.state.cursorCol >= edit.markerEnd) {
					internal.state.cursorCol += edit.trailingLength;
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

export function registerCompactPasteEditor(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
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
