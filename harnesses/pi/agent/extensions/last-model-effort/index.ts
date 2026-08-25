import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	getAgentDir,
	parseArgs,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	hasModelThinkingSuffix,
	parseLastModelEffortState,
	RestoreThinkingEventGate,
	shouldRestoreLastSelection,
	type LastModelEffortState,
	type ThinkingLevel,
} from "./core.ts";

const STATE_FILE_NAME = "last-model-effort.json";

function isSystemThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		typeof value === "string" &&
		parseArgs(["--thinking", value]).thinking === value
	);
}

function getStatePath(): string {
	const override = process.env.PI_LAST_MODEL_EFFORT_STATE?.trim();
	return override
		? resolve(override)
		: join(getAgentDir(), "state", STATE_FILE_NAME);
}

async function loadState(
	path: string,
): Promise<LastModelEffortState | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		const state = parseLastModelEffortState(parsed, isSystemThinkingLevel);
		if (!state) {
			console.error(`[last-model-effort] Ignoring invalid state file: ${path}`);
		}
		return state;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[last-model-effort] Failed to read ${path}:`, error);
		}
		return undefined;
	}
}

async function saveState(
	path: string,
	state: LastModelEffortState,
): Promise<void> {
	const directory = dirname(path);
	const temporary = join(
		directory,
		`.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
	);

	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

function captureCurrent(
	ctx: ExtensionContext,
	thinkingLevel: ThinkingLevel,
): LastModelEffortState | undefined {
	if (!ctx.model) return undefined;
	return {
		version: 1,
		provider: ctx.model.provider,
		modelId: ctx.model.id,
		thinkingLevel,
		updatedAt: new Date().toISOString(),
	};
}

function sameModel(
	ctx: ExtensionContext,
	state: LastModelEffortState,
): boolean {
	return (
		ctx.model?.provider === state.provider && ctx.model.id === state.modelId
	);
}

function scopedThinkingLevel(ctx: ExtensionContext): ThinkingLevel | undefined {
	if (!ctx.model) return undefined;
	return ctx.scopedModels.find(
		(entry) =>
			entry.model.provider === ctx.model?.provider &&
			entry.model.id === ctx.model.id,
	)?.thinkingLevel;
}

function modelAllowedByScope(
	ctx: ExtensionContext,
	state: LastModelEffortState,
): boolean {
	return (
		ctx.scopedModels.length === 0 ||
		ctx.scopedModels.some(
			(entry) =>
				entry.model.provider === state.provider && entry.model.id === state.modelId,
		)
	);
}

function warn(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	else console.error(`[last-model-effort] ${message}`);
}

export default function lastModelEffort(pi: ExtensionAPI): void {
	const statePath = getStatePath();
	const restoreThinkingEvents = new RestoreThinkingEventGate();
	let writeQueue = Promise.resolve();

	function persist(state: LastModelEffortState): Promise<void> {
		writeQueue = writeQueue
			.then(() => saveState(statePath, state))
			.catch((error) => {
				console.error(`[last-model-effort] Failed to write ${statePath}:`, error);
			});
		return writeQueue;
	}

	function persistCurrent(ctx: ExtensionContext): Promise<void> {
		const state = captureCurrent(ctx, pi.getThinkingLevel());
		return state ? persist(state) : Promise.resolve();
	}

	function trackRestoreThinkingChange<T>(
		operation: () => T | Promise<T>,
	): Promise<T> {
		return restoreThinkingEvents.track(() => pi.getThinkingLevel(), operation);
	}

	pi.on("session_start", async (event, ctx) => {
		const saved = await loadState(statePath);
		const args = parseArgs(process.argv.slice(2));
		const hasSessionRestore =
			args.continue === true ||
			args.resume === true ||
			args.session !== undefined ||
			args.fork !== undefined;
		const hasConversation =
			ctx.sessionManager.buildSessionContext().messages.length > 0;

		if (
			!saved ||
			!shouldRestoreLastSelection(event.reason, hasSessionRestore, hasConversation)
		) {
			await persistCurrent(ctx);
			return;
		}

		const explicitModel = args.model !== undefined || args.provider !== undefined;
		const explicitThinking =
			args.thinking !== undefined ||
			hasModelThinkingSuffix(args.model, isSystemThinkingLevel);
		const initialThinking = pi.getThinkingLevel();
		let modelRestored = explicitModel;

		restoreThinkingEvents.begin();
		try {
			if (!explicitModel) {
				if (sameModel(ctx, saved)) {
					modelRestored = true;
				} else if (modelAllowedByScope(ctx, saved)) {
					const model = ctx.modelRegistry.find(saved.provider, saved.modelId);
					if (model) {
						modelRestored = await trackRestoreThinkingChange(() =>
							pi.setModel(model),
						);
						if (!modelRestored) {
							warn(
								ctx,
								`Could not restore recent model ${saved.provider}/${saved.modelId}: authentication is unavailable`,
							);
						}
					} else {
						warn(
							ctx,
							`Could not restore recent model ${saved.provider}/${saved.modelId}: the model is unavailable`,
						);
					}
				} else {
					warn(
						ctx,
						`Could not restore recent model ${saved.provider}/${saved.modelId}: it is outside the current scoped models`,
					);
				}
			}

			const targetThinking = explicitThinking
				? initialThinking
				: (scopedThinkingLevel(ctx) ?? saved.thinkingLevel);
			await trackRestoreThinkingChange(() => pi.setThinkingLevel(targetThinking));
		} finally {
			restoreThinkingEvents.end();
		}

		if (modelRestored) await persistCurrent(ctx);
	});

	pi.on("model_select", async (event, _ctx) => {
		if (restoreThinkingEvents.isRestoring) return;
		const state: LastModelEffortState = {
			version: 1,
			provider: event.model.provider,
			modelId: event.model.id,
			thinkingLevel: pi.getThinkingLevel(),
			updatedAt: new Date().toISOString(),
		};
		await persist(state);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (restoreThinkingEvents.shouldSuppressThinkingEvent()) return;
		await persistCurrent(ctx);
	});

	pi.on("session_shutdown", async () => {
		await writeQueue;
	});
}
