import assert from "node:assert/strict";
import test from "node:test";
import {
	hasModelThinkingSuffix,
	parseLastModelEffortState,
	RestoreThinkingEventGate,
	shouldManageLastSelection,
	shouldRestoreLastSelection,
	type ThinkingLevel,
} from "./core.ts";

const testThinkingLevel: ThinkingLevel = "xhigh";

function isTestThinkingLevel(value: unknown): value is ThinkingLevel {
	return value === testThinkingLevel;
}

const validState = {
	version: 1,
	provider: "openai-codex",
	modelId: "gpt-5.6-sol",
	thinkingLevel: testThinkingLevel,
	updatedAt: "2026-08-25T08:00:00.000Z",
} as const;

test("parses a valid state record", () => {
	assert.deepEqual(
		parseLastModelEffortState(validState, isTestThinkingLevel),
		validState,
	);
});

test("rejects malformed state records", () => {
	assert.equal(
		parseLastModelEffortState(
			{ ...validState, thinkingLevel: "ultra" },
			isTestThinkingLevel,
		),
		undefined,
	);
	assert.equal(
		parseLastModelEffortState(
			{ ...validState, updatedAt: "not-a-date" },
			isTestThinkingLevel,
		),
		undefined,
	);
	assert.equal(
		parseLastModelEffortState(
			{ ...validState, provider: "" },
			isTestThinkingLevel,
		),
		undefined,
	);
});

test("detects a system thinking suffix on a model argument", () => {
	assert.equal(
		hasModelThinkingSuffix("openai-codex/gpt-5.6-sol:xhigh", isTestThinkingLevel),
		true,
	);
	assert.equal(
		hasModelThinkingSuffix("openai-codex/gpt-5.6-sol", isTestThinkingLevel),
		false,
	);
	assert.equal(
		hasModelThinkingSuffix("ollama/model:custom", isTestThinkingLevel),
		false,
	);
});

test("ignores pi-subagents child processes", () => {
	assert.equal(shouldManageLastSelection("1"), false);
	assert.equal(shouldManageLastSelection("0"), true);
	assert.equal(shouldManageLastSelection(undefined), true);
});

test("restores only into fresh startup or explicitly new sessions", () => {
	assert.equal(shouldRestoreLastSelection("startup", false, false), true);
	assert.equal(shouldRestoreLastSelection("new", false, false), true);
	assert.equal(shouldRestoreLastSelection("startup", true, false), false);
	assert.equal(shouldRestoreLastSelection("startup", false, true), false);
	assert.equal(shouldRestoreLastSelection("resume", false, false), false);
	assert.equal(shouldRestoreLastSelection("fork", false, false), false);
	assert.equal(shouldRestoreLastSelection("reload", false, false), false);
});

test("suppresses a restore thinking event that arrives after restoration", async () => {
	const gate = new RestoreThinkingEventGate();
	let level: ThinkingLevel = validState.thinkingLevel;
	gate.begin();
	await gate.track(
		() => level,
		() => {
			level = "low";
		},
	);
	gate.end();

	assert.equal(gate.shouldSuppressThinkingEvent(), true);
	assert.equal(gate.shouldSuppressThinkingEvent(), false);
});

test("does not retain a token for an event observed during restoration", async () => {
	const gate = new RestoreThinkingEventGate();
	let level: ThinkingLevel = "medium";
	gate.begin();
	await gate.track(
		() => level,
		() => {
			level = "high";
			assert.equal(gate.shouldSuppressThinkingEvent(), true);
		},
	);
	gate.end();

	assert.equal(gate.shouldSuppressThinkingEvent(), false);
});
