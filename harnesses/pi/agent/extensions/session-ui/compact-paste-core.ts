import { basename, extname } from "node:path";

export const PASTE_MARKER_RE =
	/\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const CLIPBOARD_IMAGE_RE = /^pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)$/i;

export function imageMimeType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return "image/png";
	}
}

export function supportsImagePreviewMime(
	protocol: string | undefined,
	mimeType: string,
): boolean {
	// pi-tui currently declares every Kitty payload as PNG (f=100), so raw
	// JPEG, WebP, and GIF bytes must not be sent through that protocol.
	return protocol !== "kitty" || mimeType === "image/png";
}

export function isClipboardImagePath(value: string): boolean {
	return CLIPBOARD_IMAGE_RE.test(basename(value));
}

export function compactPasteCount(value: number): string {
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

export type MarkerSpacingEdit = {
	line: string;
	markerStart: number;
	markerEnd: number;
	leadingLength: number;
	trailingLength: number;
};

export function addPasteMarkerSpacing(
	line: string,
	pasteId: number,
): MarkerSpacingEdit | undefined {
	for (const match of line.matchAll(PASTE_MARKER_RE)) {
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
