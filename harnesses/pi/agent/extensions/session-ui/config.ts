import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StatuslineOverflow } from "./statusline-core.ts";

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface SessionUiConfig {
	toolActivity: {
		enabled: boolean;
		placement: WidgetPlacement;
		maxItems: number;
	};
	compactPaste: {
		enabled: boolean;
	};
	statusline: {
		enabled: boolean;
		overflow: StatuslineOverflow;
		segments: string[];
		extensionStatuses: {
			exclude: string[];
		};
	};
	effort: {
		enabled: boolean;
	};
	turnDuration: {
		enabled: boolean;
	};
}

export const DEFAULT_SESSION_UI_CONFIG: SessionUiConfig = {
	toolActivity: {
		enabled: true,
		placement: "aboveEditor",
		maxItems: 6,
	},
	compactPaste: {
		enabled: true,
	},
	statusline: {
		enabled: true,
		overflow: "drop-right",
		segments: [
			"model",
			"effort",
			"directory",
			"branch",
			"context",
			"tokens",
			"cache",
			"cost",
			"mcp",
			"extensions",
		],
		extensionStatuses: {
			exclude: ["pi-lens-lsp", "openai-fast", "mcp", "mcp-*"],
		},
	},
	effort: {
		enabled: true,
	},
	turnDuration: {
		enabled: true,
	},
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanValue(
	value: unknown,
	fallback: boolean,
	path: string,
	warnings: string[],
): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`${path} must be a boolean`);
	return fallback;
}

function boundedInteger(
	value: unknown,
	fallback: number,
	path: string,
	min: number,
	max: number,
	warnings: string[],
): number {
	if (value === undefined) return fallback;
	if (
		Number.isInteger(value) &&
		(value as number) >= min &&
		(value as number) <= max
	) {
		return value as number;
	}
	warnings.push(`${path} must be an integer between ${min} and ${max}`);
	return fallback;
}

function objectValue(value: unknown): JsonObject {
	return isObject(value) ? value : {};
}

function stringArrayValue(
	value: unknown,
	fallback: readonly string[],
	path: string,
	warnings: string[],
): string[] {
	if (value === undefined) return [...fallback];
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string" && entry.trim())
	) {
		return [...new Set(value.map((entry) => entry.trim()))];
	}
	warnings.push(`${path} must be an array of non-empty strings`);
	return [...fallback];
}

function parseConfig(raw: unknown, warnings: string[]): SessionUiConfig {
	if (!isObject(raw)) {
		warnings.push("config root must be an object");
		return structuredClone(DEFAULT_SESSION_UI_CONFIG);
	}

	const toolActivity = objectValue(raw.toolActivity);
	const compactPaste = objectValue(raw.compactPaste);
	const statusline = objectValue(raw.statusline);
	const extensionStatuses = objectValue(statusline.extensionStatuses);
	const effort = objectValue(raw.effort);
	const turnDuration = objectValue(raw.turnDuration);

	let placement = DEFAULT_SESSION_UI_CONFIG.toolActivity.placement;
	if (toolActivity.placement !== undefined) {
		if (
			toolActivity.placement === "aboveEditor" ||
			toolActivity.placement === "belowEditor"
		) {
			placement = toolActivity.placement;
		} else {
			warnings.push("toolActivity.placement must be aboveEditor or belowEditor");
		}
	}

	let overflow = DEFAULT_SESSION_UI_CONFIG.statusline.overflow;
	if (statusline.overflow !== undefined) {
		if (
			statusline.overflow === "drop-right" ||
			statusline.overflow === "priority"
		) {
			overflow = statusline.overflow;
		} else {
			warnings.push("statusline.overflow must be drop-right or priority");
		}
	}
	const segments = stringArrayValue(
		statusline.segments,
		DEFAULT_SESSION_UI_CONFIG.statusline.segments,
		"statusline.segments",
		warnings,
	);
	const excludedExtensionStatuses = stringArrayValue(
		extensionStatuses.exclude,
		DEFAULT_SESSION_UI_CONFIG.statusline.extensionStatuses.exclude,
		"statusline.extensionStatuses.exclude",
		warnings,
	);

	return {
		toolActivity: {
			enabled: booleanValue(
				toolActivity.enabled,
				DEFAULT_SESSION_UI_CONFIG.toolActivity.enabled,
				"toolActivity.enabled",
				warnings,
			),
			placement,
			maxItems: boundedInteger(
				toolActivity.maxItems,
				DEFAULT_SESSION_UI_CONFIG.toolActivity.maxItems,
				"toolActivity.maxItems",
				1,
				20,
				warnings,
			),
		},
		compactPaste: {
			enabled: booleanValue(
				compactPaste.enabled,
				DEFAULT_SESSION_UI_CONFIG.compactPaste.enabled,
				"compactPaste.enabled",
				warnings,
			),
		},
		statusline: {
			enabled: booleanValue(
				statusline.enabled,
				DEFAULT_SESSION_UI_CONFIG.statusline.enabled,
				"statusline.enabled",
				warnings,
			),
			overflow,
			segments,
			extensionStatuses: {
				exclude: excludedExtensionStatuses,
			},
		},
		effort: {
			enabled: booleanValue(
				effort.enabled,
				DEFAULT_SESSION_UI_CONFIG.effort.enabled,
				"effort.enabled",
				warnings,
			),
		},
		turnDuration: {
			enabled: booleanValue(
				turnDuration.enabled,
				DEFAULT_SESSION_UI_CONFIG.turnDuration.enabled,
				"turnDuration.enabled",
				warnings,
			),
		},
	};
}

export interface LoadedSessionUiConfig {
	config: SessionUiConfig;
	warnings: string[];
	path: string;
}

export function loadSessionUiConfig(): LoadedSessionUiConfig {
	const defaultPath = fileURLToPath(new URL("./config.json", import.meta.url));
	const path = process.env.PI_SESSION_UI_CONFIG?.trim() || defaultPath;
	const warnings: string[] = [];

	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return { config: parseConfig(raw, warnings), warnings, path };
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		if (code !== "ENOENT") {
			warnings.push(
				`failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return {
			config: structuredClone(DEFAULT_SESSION_UI_CONFIG),
			warnings,
			path,
		};
	}
}
