import assert from "node:assert/strict";
import test from "node:test";
import {
	addPasteMarkerSpacing,
	compactPasteCount,
	imageMimeType,
	isClipboardImagePath,
	pasteSize,
	supportsImagePreviewMime,
} from "./compact-paste-core.ts";

test("recognizes Pi clipboard image paths", () => {
	assert.equal(isClipboardImagePath("/tmp/pi-clipboard-dead-beef.png"), true);
	assert.equal(isClipboardImagePath("pi-clipboard-a1b2.jpeg"), true);
	assert.equal(isClipboardImagePath("pi-clipboard-a1b2.webp"), true);
	assert.equal(isClipboardImagePath("pi-clipboard-a1b2.gif"), true);
	assert.equal(isClipboardImagePath("regular-image.png"), false);
	assert.equal(isClipboardImagePath("pi-clipboard-not-hex.png"), false);
});

test("maps image extensions to MIME types", () => {
	assert.equal(imageMimeType("image.png"), "image/png");
	assert.equal(imageMimeType("image.jpg"), "image/jpeg");
	assert.equal(imageMimeType("image.jpeg"), "image/jpeg");
	assert.equal(imageMimeType("image.webp"), "image/webp");
	assert.equal(imageMimeType("image.gif"), "image/gif");
});

test("allows only PNG payloads through the Kitty protocol", () => {
	assert.equal(supportsImagePreviewMime("kitty", "image/png"), true);
	assert.equal(supportsImagePreviewMime("kitty", "image/jpeg"), false);
	assert.equal(supportsImagePreviewMime("kitty", "image/webp"), false);
	assert.equal(supportsImagePreviewMime("iterm2", "image/jpeg"), true);
	assert.equal(supportsImagePreviewMime(undefined, "image/gif"), true);
});

test("formats compact paste sizes", () => {
	assert.equal(compactPasteCount(999), "999");
	assert.equal(compactPasteCount(1_000), "1k");
	assert.equal(compactPasteCount(12_500), "13k");
	assert.equal(compactPasteCount(1_500_000), "1.5m");
	assert.equal(pasteSize("a".repeat(1_000)), "1k chars");
	assert.equal(
		pasteSize(Array.from({ length: 11 }, () => "x").join("\n")),
		"11 lines",
	);
});

test("adds spacing around a newly inserted paste marker", () => {
	assert.deepEqual(addPasteMarkerSpacing("before[paste #3]after", 3), {
		line: "before [paste #3] after",
		markerStart: 6,
		markerEnd: 16,
		leadingLength: 1,
		trailingLength: 1,
	});
	assert.equal(addPasteMarkerSpacing("before [paste #3] after", 3), undefined);
	assert.equal(addPasteMarkerSpacing("before[paste #3]after", 4), undefined);
});
