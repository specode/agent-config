import assert from "node:assert/strict";
import test from "node:test";
import {
	phaseForTool,
	withWorkAnimationEnabled,
} from "./work-animation-core.ts";

test("phaseForTool maps common tool families", () => {
	assert.equal(phaseForTool("read"), "Reading...");
	assert.equal(phaseForTool("web_search"), "Searching...");
	assert.equal(phaseForTool("lsp_diagnostics"), "Checking code...");
	assert.equal(phaseForTool("subagent"), "Coordinating...");
	assert.equal(phaseForTool("generate_image"), "Processing image...");
	assert.equal(phaseForTool("@@@"), "Using tool...");
});

test("withWorkAnimationEnabled preserves the combined session-ui config", () => {
	const source = {
		toolActivity: { enabled: true },
		workAnimation: {
			enabled: true,
			intervalMs: 180,
			placement: "aboveEditor",
		},
	};

	assert.deepEqual(withWorkAnimationEnabled(source, false), {
		toolActivity: { enabled: true },
		workAnimation: {
			enabled: false,
			intervalMs: 180,
			placement: "aboveEditor",
		},
	});
	assert.equal(source.workAnimation.enabled, true);
});

test("withWorkAnimationEnabled rejects an invalid config root", () => {
	assert.throws(
		() => withWorkAnimationEnabled([], true),
		/session-ui config root must be an object/,
	);
});
