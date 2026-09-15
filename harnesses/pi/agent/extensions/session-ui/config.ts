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
	workAnimation: {
		enabled: boolean;
		intervalMs: number;
		placement: WidgetPlacement;
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
	uiMeta: {
		enabled: boolean;
		title: {
			enabled: boolean;
			maxLength: number;
		};
		recap: {
			enabled: boolean;
			maxLength: number;
		};
		sessionName: {
			enabled: boolean;
			maxLength: number;
			manualNameLocks: boolean;
		};
	};
}

export const DEFAULT_SESSION_UI_CONFIG: SessionUiConfig = {
	toolActivity: {
		enabled: true,
		placement: "aboveEditor",
		maxItems: 6,
	},
	workAnimation: {
		enabled: true,
		intervalMs: 180,
		placement: "aboveEditor",
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
			"usage",
			"tokens",
			"cache",
			"cost",
			"mcp",
			"extensions",
		],
		extensionStatuses: {
			exclude: [
				"pi-lens-lsp",
				"openai-fast",
				"mcp",
				"mcp-*",
				"subscription-usage",
			],
		},
	},
	effort: {
		enabled: true,
	},
	turnDuration: {
		enabled: true,
	},
	uiMeta: {
		enabled: true,
		title: {
			enabled: true,
			maxLength: 36,
		},
		recap: {
			enabled: true,
			maxLength: 120,
		},
		sessionName: {
			enabled: true,
			maxLength: 48,
			manualNameLocks: true,
		},
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
	const workAnimation = objectValue(raw.workAnimation);
	const compactPaste = objectValue(raw.compactPaste);
	const statusline = objectValue(raw.statusline);
	const extensionStatuses = objectValue(statusline.extensionStatuses);
	const effort = objectValue(raw.effort);
	const turnDuration = objectValue(raw.turnDuration);
	const uiMeta = objectValue(raw.uiMeta);
	const uiMetaTitle = objectValue(uiMeta.title);
	const uiMetaRecap = objectValue(uiMeta.recap);
	const uiMetaSessionName = objectValue(uiMeta.sessionName);

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

	let animationPlacement = DEFAULT_SESSION_UI_CONFIG.workAnimation.placement;
	if (workAnimation.placement !== undefined) {
		if (
			workAnimation.placement === "aboveEditor" ||
			workAnimation.placement === "belowEditor"
		) {
			animationPlacement = workAnimation.placement;
		} else {
			warnings.push("workAnimation.placement must be aboveEditor or belowEditor");
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
		workAnimation: {
			enabled: booleanValue(
				workAnimation.enabled,
				DEFAULT_SESSION_UI_CONFIG.workAnimation.enabled,
				"workAnimation.enabled",
				warnings,
			),
			intervalMs: boundedInteger(
				workAnimation.intervalMs,
				DEFAULT_SESSION_UI_CONFIG.workAnimation.intervalMs,
				"workAnimation.intervalMs",
				100,
				500,
				warnings,
			),
			placement: animationPlacement,
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
		uiMeta: {
			enabled: booleanValue(
				uiMeta.enabled,
				DEFAULT_SESSION_UI_CONFIG.uiMeta.enabled,
				"uiMeta.enabled",
				warnings,
			),
			title: {
				enabled: booleanValue(
					uiMetaTitle.enabled,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.title.enabled,
					"uiMeta.title.enabled",
					warnings,
				),
				maxLength: boundedInteger(
					uiMetaTitle.maxLength,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.title.maxLength,
					"uiMeta.title.maxLength",
					8,
					80,
					warnings,
				),
			},
			recap: {
				enabled: booleanValue(
					uiMetaRecap.enabled,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.recap.enabled,
					"uiMeta.recap.enabled",
					warnings,
				),
				maxLength: boundedInteger(
					uiMetaRecap.maxLength,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.recap.maxLength,
					"uiMeta.recap.maxLength",
					20,
					240,
					warnings,
				),
			},
			sessionName: {
				enabled: booleanValue(
					uiMetaSessionName.enabled,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.sessionName.enabled,
					"uiMeta.sessionName.enabled",
					warnings,
				),
				maxLength: boundedInteger(
					uiMetaSessionName.maxLength,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.sessionName.maxLength,
					"uiMeta.sessionName.maxLength",
					8,
					100,
					warnings,
				),
				manualNameLocks: booleanValue(
					uiMetaSessionName.manualNameLocks,
					DEFAULT_SESSION_UI_CONFIG.uiMeta.sessionName.manualNameLocks,
					"uiMeta.sessionName.manualNameLocks",
					warnings,
				),
			},
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
