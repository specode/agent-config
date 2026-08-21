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
		'<ui_meta>{"v":1,"kind":"turn_start","title":"设计元数据协议","session":{"action":"set","name":"优化会话标题体验"}}</ui_meta>',
		"normal response",
		'<ui_meta>{"v":1,"kind":"turn_end","recap":"完成协议设计并拆分三个消费端"}</ui_meta>',
	].join("\n");

	assert.deepEqual(extractUiMetaRecords(text, limits), [
		{
			v: 1,
			kind: "turn_start",
			title: "设计元数据协议",
			session: { action: "set", name: "优化会话标题体验" },
		},
		{
			v: 1,
			kind: "turn_end",
			recap: "完成协议设计并拆分三个消费端",
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
		'正文中的示例 <ui_meta>{"v":1,"kind":"turn_start","title":"不要应用"}</ui_meta> 仍属于正文';
	assert.deepEqual(extractUiMetaRecords(example, limits), []);
	assert.equal(stripUiMetaBlocks(example), example);
});

test("sanitizes controls, bidi overrides, whitespace, and visible length", () => {
	assert.equal(
		sanitizeUiMetaText("  修复\u001B]0;owned\u0007\n登录\u202E状态和缓存  ", 8),
		"修复 登录状态…",
	);
	assert.equal(sanitizeUiMetaText("abcdef", 4), "abc…");
});

test("strips complete metadata without removing the normal response", () => {
	const markdown = [
		'<ui_meta>{"v":1,"kind":"turn_start","title":"测试"}</ui_meta>',
		"",
		"正常回答",
		"",
		'<ui_meta>{"v":1,"kind":"turn_end","recap":"完成"}</ui_meta>',
	].join("\n");
	assert.equal(stripUiMetaBlocks(markdown), "正常回答");
});

test("hides unfinished metadata and split tag prefixes only when requested", () => {
	assert.equal(stripUiMetaBlocks('正常回答\n<ui_meta>{"v":1', true), "正常回答");
	assert.equal(stripUiMetaBlocks("", true), "");
	assert.equal(stripUiMetaBlocks("<ui_", true), "");
	assert.equal(
		stripUiMetaBlocks('正常回答\n<ui_meta>{"v":1', false),
		'正常回答\n<ui_meta>{"v":1',
	);
	assert.equal(stripUiMetaBlocks("比较结果是 1 < 2", true), "比较结果是 1 < 2");
});
