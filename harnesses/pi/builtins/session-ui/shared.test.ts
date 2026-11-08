import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ellipsize } from "./shared.ts";

const LONE_SURROGATE_RE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("returns normalized ASCII unchanged when it fits within max width", () => {
	assert.equal(ellipsize("hello world", 11), "hello world");
	assert.equal(ellipsize("  hello\n\tworld  ", 11), "hello world");
});

test("truncates ASCII with a single-character ellipsis and no ANSI resets", () => {
	const result = ellipsize("hello world", 8);
	assert.equal(result, "hello w…");
	assert.equal(visibleWidth(result), 8);
	assert.equal(ellipsize("hello", 1), "…");
	assert.equal(ellipsize("hello", 0), "");
});

test("respects terminal column width for CJK strings without splitting wide characters", () => {
	const source = "修复会话界面的中文标题截断";
	for (const max of [4, 5, 8, 9, 10]) {
		const result = ellipsize(source, max);
		assert.ok(visibleWidth(result) <= max, `width ${visibleWidth(result)} > ${max}`);
		assert.equal(result.endsWith("…"), true);
		assert.equal(LONE_SURROGATE_RE.test(result), false);
	}
	assert.equal(ellipsize("中文", 4), "中文");
	assert.equal(ellipsize("中文标题", 5), "中文…");
	assert.equal(visibleWidth(ellipsize("中文标题", 5)), 5);
	assert.equal(ellipsize("中文标题", 4), "中…");
	assert.equal(visibleWidth(ellipsize("中文标题", 4)), 3);
});

test("does not leave lone surrogates when an emoji straddles the truncation boundary", () => {
	for (const max of [17, 18, 19]) {
		const result = ellipsize("abcdefghijklmnop😀rest", max);
		assert.ok(visibleWidth(result) <= max);
		assert.equal(LONE_SURROGATE_RE.test(result), false);
		assert.equal(result.endsWith("…"), true);
	}
});

test("returns empty string for empty or whitespace-only input", () => {
	assert.equal(ellipsize("", 10), "");
	assert.equal(ellipsize("   \n\t  ", 10), "");
});
