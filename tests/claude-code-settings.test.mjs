import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Claude Code enables language servers without the Codex plugin or marketplace", () => {
	const settings = JSON.parse(
		readFileSync(new URL("../harnesses/claude-code/settings.json", import.meta.url), "utf8"),
	);
	assert.equal(settings.tui, "fullscreen");
	assert.equal(settings.enabledPlugins["swift-lsp@claude-plugins-official"], true);
	assert.equal(settings.enabledPlugins["gopls-lsp@claude-plugins-official"], true);
	assert.equal(Object.hasOwn(settings.enabledPlugins, "codex@openai-codex"), false);
	assert.equal(Object.hasOwn(settings.extraKnownMarketplaces ?? {}, "openai-codex"), false);
});

test("Claude Code aligns model selection and full-page scrolling with Pi", () => {
	const keys = JSON.parse(
		readFileSync(new URL("../harnesses/claude-code/keybindings.json", import.meta.url), "utf8"),
	);
	const chat = keys.bindings.find(({ context }) => context === "Chat").bindings;
	const scroll = keys.bindings.find(({ context }) => context === "Scroll").bindings;
	assert.equal(chat["ctrl+l"], "chat:modelPicker");
	assert.equal(chat["alt+p"], null);
	assert.equal(scroll["alt+k"], "scroll:fullPageUp");
	assert.equal(scroll["alt+j"], "scroll:fullPageDown");
	assert.equal(scroll["alt+u"], "scroll:halfPageUp");
	assert.equal(scroll["alt+d"], "scroll:halfPageDown");
	assert.equal(scroll["alt+,"], "scroll:top");
	assert.equal(scroll["alt+."], "scroll:bottom");
});
