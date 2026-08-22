import assert from "node:assert/strict";
import test from "node:test";
import {
	findUnknownStatusSegments,
	fitStatuslineItems,
	isExtensionStatusExcluded,
	matchesStatusPattern,
	parseMcpFooterText,
	parseMcpStatusEvent,
	type StatuslineLayoutItem,
} from "./statusline-core.ts";

function item(
	id: string,
	width: number,
	options: Partial<StatuslineLayoutItem> = {},
): StatuslineLayoutItem {
	return {
		id,
		priority: 50,
		required: false,
		value: id,
		width,
		...options,
	};
}

test("drop-right preserves the configured prefix", () => {
	const items = [item("model", 5), item("effort", 4), item("branch", 6)];
	assert.deepEqual(
		fitStatuslineItems(items, 11, 2, "drop-right").map(({ id }) => id),
		["model", "effort"],
	);
	assert.deepEqual(
		fitStatuslineItems(items, 10, 2, "drop-right").map(({ id }) => id),
		["model"],
	);
});

test("priority compacts low-priority items before removing them", () => {
	const items = [
		item("model", 5, { priority: 100, required: true }),
		item("cache", 6, {
			priority: 10,
			compactValue: "c",
			compactWidth: 1,
		}),
		item("context", 4, { priority: 90, required: true }),
	];
	assert.deepEqual(
		fitStatuslineItems(items, 12, 1, "priority").map(({ value }) => value),
		["model", "c", "context"],
	);
	assert.deepEqual(
		fitStatuslineItems(items, 10, 1, "priority").map(({ id }) => id),
		["model", "context"],
	);
});

test("extension status filters support exact ids and star wildcards", () => {
	assert.equal(matchesStatusPattern("mcp-kimi-cu", "mcp-*"), true);
	assert.equal(matchesStatusPattern("openai-fast", "openai-fast"), true);
	assert.equal(matchesStatusPattern("pi-lens-lsp", "mcp-*"), false);
	assert.equal(
		isExtensionStatusExcluded("mcp-kimi-cu", ["openai-fast", "mcp-*"]),
		true,
	);
});

test("unknown configured segments are reported", () => {
	assert.deepEqual(
		findUnknownStatusSegments(
			["model", "missing", "context"],
			new Set(["model", "context"]),
		),
		["missing"],
	);
});

test("MCP footer fallback parses compact and full forms", () => {
	assert.deepEqual(parseMcpFooterText("MCP 1/2"), {
		connectedCount: 1,
		enabledCount: 2,
		connectedNames: [],
	});
	assert.deepEqual(
		parseMcpFooterText("🔌 MCP: 2 servers enabled (1 connected)"),
		{
			connectedCount: 1,
			enabledCount: 2,
			connectedNames: [],
		},
	);
});

test("MCP event parsing prefers structured connected server data", () => {
	assert.deepEqual(
		parseMcpStatusEvent({
			servers: [
				{ name: "zeta", status: "connected" },
				{ name: "alpha", status: "connected" },
				{ name: "disabled", status: "disabled" },
			],
			connectedCount: 2,
			disabledCount: 1,
		}),
		{
			connectedCount: 2,
			enabledCount: 2,
			connectedNames: ["alpha", "zeta"],
		},
	);
	assert.equal(parseMcpStatusEvent({ servers: [] }), undefined);
});
