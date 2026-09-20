import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadSessionUiConfig } from "./config.ts";

const TEST_ROOT = `/tmp/mozi-test/session-ui-config-${process.pid}-${Date.now()}`;

function withConfig(raw: unknown) {
	mkdirSync(TEST_ROOT, { recursive: true });
	const path = join(
		TEST_ROOT,
		`config-${Math.random().toString(16).slice(2)}.json`,
	);
	writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");
	const previous = process.env.PI_SESSION_UI_CONFIG;
	process.env.PI_SESSION_UI_CONFIG = path;
	try {
		return loadSessionUiConfig();
	} finally {
		if (previous === undefined) delete process.env.PI_SESSION_UI_CONFIG;
		else process.env.PI_SESSION_UI_CONFIG = previous;
	}
}

test.after(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
});

test("loads the integrated workAnimation config", () => {
	const loaded = withConfig({
		workAnimation: {
			enabled: false,
			intervalMs: 500,
			placement: "belowEditor",
		},
	});

	assert.deepEqual(loaded.config.workAnimation, {
		enabled: false,
		intervalMs: 500,
		placement: "belowEditor",
	});
	assert.deepEqual(loaded.warnings, []);
});

test("falls back and warns for invalid workAnimation values", () => {
	const loaded = withConfig({
		workAnimation: {
			enabled: "yes",
			intervalMs: 99,
			placement: "besideEditor",
		},
	});

	assert.deepEqual(loaded.config.workAnimation, {
		enabled: true,
		intervalMs: 180,
		placement: "aboveEditor",
	});
	assert.deepEqual(loaded.warnings, [
		"workAnimation.placement must be aboveEditor or belowEditor",
		"workAnimation.enabled must be a boolean",
		"workAnimation.intervalMs must be an integer between 100 and 500",
	]);
});
