import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const profile = JSON.parse(
	readFileSync(
		new URL(
			"../harnesses/pi/plugin-configs/pi-subagents/profiles/multimodel-ggk.json",
			import.meta.url,
		),
		"utf8",
	),
);
const overrides = profile.subagents.agentOverrides;
const routing = {
	scout: ["kimi-coding/k3", "high"],
	delegate: ["openai-codex/gpt-6-astra", "xhigh"],
	researcher: ["xai/grok-4.6", "high"],
	worker: ["openai-codex/gpt-6-astra", "medium"],
	reviewer: ["xai/grok-4.6", "high"],
	oracle: ["openai-codex/gpt-6-astra", "max"],
};
const externalAgents = [
	"claude-code",
	"claude-code-writer",
	"codex-exec",
	"codex-exec-writer",
	"cursor-agent",
	"cursor-agent-writer",
];

test("multimodel profile uses one model per role without overriding builtin prompts or tools", () => {
	assert.deepEqual(Object.keys(profile), ["subagents"]);
	assert.deepEqual(Object.keys(profile.subagents), ["agentOverrides"]);
	assert.deepEqual(
		Object.keys(overrides).sort(),
		[...Object.keys(routing), ...externalAgents].sort(),
	);
	for (const [name, [model, thinking]] of Object.entries(routing)) {
		const override = overrides[name];
		assert.equal(override.model, model, name);
		assert.equal(override.thinking, thinking, name);
		for (const field of Object.keys(override)) {
			assert.ok(
				["model", "thinking", "defaultContext", "acceptanceRole"].includes(field),
				`${name}.${field} must not replace builtin behavior or reintroduce fallbackModels`,
			);
		}
	}
});

test("review is fresh and read-only while worker and oracle keep builtin context defaults", () => {
	assert.equal(overrides.reviewer.defaultContext, "fresh");
	assert.equal(overrides.reviewer.acceptanceRole, "read-only");
	assert.equal(overrides.oracle.acceptanceRole, "read-only");
	assert.equal(Object.hasOwn(overrides.worker, "defaultContext"), false);
	assert.equal(Object.hasOwn(overrides.oracle, "defaultContext"), false);
});

test("all external CLI variants remain disabled", () => {
	for (const name of externalAgents) {
		assert.deepEqual(overrides[name], { disabled: true }, name);
	}
});
