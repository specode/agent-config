import assert from "node:assert/strict";
import test from "node:test";
import {
	beginUiMetaRun,
	canCommitUiMetaRecap,
	extractUiMetaRecords,
	sanitizeUiMetaText,
	stripUiMetaBlocks,
	type UiMetaLimits,
} from "./ui-meta-core.ts";

const limits: UiMetaLimits = {
	title: 12,
	recap: 40,
	sessionName: 16,
};

test("preserves protocol progress only for compaction continuations", () => {
	const previous = { startReceived: true, recapReceived: false };
	assert.deepEqual(beginUiMetaRun(true, true, previous, true), previous);
	assert.deepEqual(beginUiMetaRun(true, true, previous, false), {
		startReceived: false,
		recapReceived: false,
	});
	assert.deepEqual(beginUiMetaRun(false, false, previous, false), {
		startReceived: true,
		recapReceived: true,
	});
});

test("commits recap only for a successful tool-free final response", () => {
	assert.equal(canCommitUiMetaRecap("stop", false), true);
	assert.equal(canCommitUiMetaRecap("stop", true), false);
	assert.equal(canCommitUiMetaRecap("aborted", false), false);
	assert.equal(canCommitUiMetaRecap("length", false), false);
});

test("extracts typed start and end records", () => {
	const text = [
		'<ui_meta>{"v":1,"kind":"turn_start","title":"Meta design","session":{"action":"set","name":"Session titles"}}</ui_meta>',
		"normal response",
		'<ui_meta>{"v":1,"kind":"turn_end","recap":"Designed protocol and split consumers"}</ui_meta>',
	].join("\n");

	assert.deepEqual(extractUiMetaRecords(text, limits), [
		{
			v: 1,
			kind: "turn_start",
			title: "Meta design",
			session: { action: "set", name: "Session titles" },
		},
		{
			v: 1,
			kind: "turn_end",
			recap: "Designed protocol and split consumers",
		},
	]);
});

test("accepts keep and ignores malformed or unsupported records", () => {
	const text = [
		'<ui_meta>{"v":1,"kind":"turn_start","session":{"action":"keep"}}</ui_meta>',
		'<ui_meta>{"v":2,"kind":"turn_end","recap":"wrong version"}</ui_meta>',
		"<ui_meta>{not json}</ui_meta>",
		'<ui_meta>{"v":1,"kind":"turn_start","session":{"action":"set"}}</ui_meta>',
	].join("\n");

	assert.deepEqual(extractUiMetaRecords(text, limits), [
		{ v: 1, kind: "turn_start", session: { action: "keep" } },
	]);
});

test("ignores valid-looking metadata examples away from protocol boundaries", () => {
	const example =
		'Inline example <ui_meta>{"v":1,"kind":"turn_start","title":"Do not apply"}</ui_meta> remains body text';
	assert.deepEqual(extractUiMetaRecords(example, limits), []);
	assert.equal(stripUiMetaBlocks(example), example);
});

test("sanitizes controls, bidi overrides, whitespace, and visible length", () => {
	assert.equal(
		sanitizeUiMetaText("  Fix\u001B]0;owned\u0007\nlogin\u202E state cache  ", 8),
		"Fix log…",
	);
	assert.equal(sanitizeUiMetaText("abcdef", 4), "abc…");
});

test("strips complete metadata without removing the normal response", () => {
	const markdown = [
		'<ui_meta>{"v":1,"kind":"turn_start","title":"Test"}</ui_meta>',
		"",
		"Normal response",
		"",
		'<ui_meta>{"v":1,"kind":"turn_end","recap":"Done"}</ui_meta>',
	].join("\n");
	assert.equal(stripUiMetaBlocks(markdown), "Normal response");
});

test("hides unfinished metadata and split tag prefixes only when requested", () => {
	assert.equal(
		stripUiMetaBlocks('Normal response\n<ui_meta>{"v":1', true),
		"Normal response",
	);
	assert.equal(stripUiMetaBlocks("", true), "");
	assert.equal(stripUiMetaBlocks("<ui_", true), "");
	assert.equal(
		stripUiMetaBlocks('Normal response\n<ui_meta>{"v":1', false),
		'Normal response\n<ui_meta>{"v":1',
	);
	assert.equal(stripUiMetaBlocks("Result is 1 < 2", true), "Result is 1 < 2");
});
