import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { SessionUiConfig } from "./config.ts";
import {
	beginUiMetaRun,
	canCommitUiMetaRecap,
	extractUiMetaRecords,
	stripUiMetaBlocks,
	UI_META_SENTINEL,
	type UiMetaLimits,
	type UiMetaRecord,
} from "./ui-meta-core.ts";

const UI_META_STATE_TYPE = "session-ui:ui-meta-state";
const TURN_RECAP_TYPE = "session-ui:turn-recap";
const I_RECAP = "↳";

type UiMetaConfig = SessionUiConfig["uiMeta"];

interface UiMetaStateData {
	v: 1;
	title?: string;
	autoSessionName?: string;
}

interface TurnRecapData {
	v: 1;
	text: string;
	timestamp: number;
}

function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return "role" in message && message.role === "assistant";
}

function isUserMessage(message: AgentMessage): message is UserMessage {
	return "role" in message && message.role === "user";
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
		.join("\n");
}

function stripMessageMetadata(
	message: AssistantMessage,
): AssistantMessage | undefined {
	let changed = false;
	const content: AssistantMessage["content"] = [];
	for (const entry of message.content) {
		if (entry.type !== "text") {
			content.push(entry);
			continue;
		}

		const text = stripUiMetaBlocks(entry.text, true);
		if (text === entry.text) {
			content.push(entry);
			continue;
		}

		changed = true;
		if (text) content.push({ type: "text", text });
	}
	return changed ? { ...message, content } : undefined;
}

function appendRequestToLatestUserMessage(
	messages: AgentMessage[],
	request: string,
): AgentMessage[] | undefined {
	let index = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message && isUserMessage(message)) {
			index = i;
			break;
		}
	}
	if (index < 0) return undefined;

	const current = messages[index];
	if (!current || !isUserMessage(current)) return undefined;
	const marker = { type: "text" as const, text: `\n\n${request}` };
	const content =
		typeof current.content === "string"
			? [{ type: "text" as const, text: current.content }, marker]
			: [...current.content, marker];
	const next = [...messages];
	next[index] = { ...current, content };
	return next;
}

function latestStoredState(ctx: ExtensionContext): UiMetaStateData | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (
			entry?.type !== "custom" ||
			entry.customType !== UI_META_STATE_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}
		const data = entry.data as Partial<UiMetaStateData>;
		if (data.v !== 1) continue;
		return {
			v: 1,
			...(typeof data.title === "string" && data.title
				? { title: data.title }
				: {}),
			...(typeof data.autoSessionName === "string" && data.autoSessionName
				? { autoSessionName: data.autoSessionName }
				: {}),
		};
	}
	return undefined;
}

function buildProtocolPrompt(config: UiMetaConfig): string {
	const startEnabled = config.title.enabled || config.sessionName.enabled;
	return `# Session UI metadata protocol
The application may append a <ui_meta_request> JSON marker to the latest user message. Treat it as private application metadata, not as user-authored content.

When the marker is present:
${
	startEnabled
		? `- If needStart is true, begin the first assistant message with exactly one raw single-line ${UI_META_SENTINEL}{JSON} record before prose or tool calls.
- The start JSON schema is {"v":1,"kind":"turn_start","title":"...","session":{"action":"keep"}} or {"v":1,"kind":"turn_start","title":"...","session":{"action":"set","name":"..."}}.
- title describes the immediate action for the latest user turn (what is being done now), not the whole conversation. Maximum ${config.title.maxLength} visible characters.${config.title.enabled ? "" : " Omit title because title metadata is disabled."}
- session.name describes the current high-level goal of the whole session. Use session.action=set only for the first clear goal or when the user replaces it with a different high-level goal. Use keep for continuations, refinements, tests, reviews, or subtasks.${config.sessionName.enabled ? ` Maximum ${config.sessionName.maxLength} visible characters.` : " Omit session because session-name metadata is disabled."}`
		: "- Do not emit turn_start metadata because start metadata is disabled."
}
${
	config.recap.enabled
		? `- In the final assistant message that completes the request and contains no tool calls, end with exactly one raw single-line ${UI_META_SENTINEL}{"v":1,"kind":"turn_end","recap":"..."} record.
- recap states what was actually completed, partially completed, or blocked in this agent run. It is an outcome, not a plan. Maximum ${config.recap.maxLength} visible characters.`
		: "- Do not emit turn_end metadata because recap metadata is disabled."
}
- Put each metadata record on its own physical line. The sentinel is the complete envelope; do not add XML tags, a closing marker, Markdown fences, quotes around the record, or an explanation.
- Use the same language as the latest real user request and omit trailing punctuation.
- Do not copy secrets, credentials, full paths, terminal control sequences, or raw user text into metadata.
- If sessionNameLocked is true, session.action must be keep.
- needStart and needRecap are fixed for the whole agent run. Emit turn_start only in the first assistant message after the latest real user request; do not repeat it after tool results. Emit turn_end only in the final tool-free response.
- If needStart is false, do not emit turn_start. If needRecap is false, do not emit turn_end.
- Metadata must not change the substance, ordering, or completeness of the normal response.`;
}

export function registerUiMeta(pi: ExtensionAPI, config: UiMetaConfig): void {
	const limits: UiMetaLimits = {
		title: config.title.maxLength,
		recap: config.recap.maxLength,
		sessionName: config.sessionName.maxLength,
	};
	const protocolPrompt = buildProtocolPrompt(config);
	const startMetadataEnabled =
		config.title.enabled || config.sessionName.enabled;

	let enabledForSession = false;
	let requestActive = false;
	let requestMarker = "";
	let continueAfterCompaction = false;
	let startReceived = !startMetadataEnabled;
	let recapReceived = !config.recap.enabled;
	let working = false;
	let currentTitle = "";
	let autoSessionName: string | undefined;
	let pendingAutoSessionName: string | undefined;
	let manualSessionNameLocked = false;
	let pendingRecaps: TurnRecapData[] = [];
	let stateDirty = false;
	let lastCtx: ExtensionContext | undefined;

	const buildRequestMarker = (needStart: boolean, needRecap: boolean) =>
		`<ui_meta_request>${JSON.stringify({
			v: 1,
			needStart,
			needRecap,
			currentTitle: currentTitle || null,
			currentSessionName: pi.getSessionName()?.trim() || null,
			sessionNameLocked: manualSessionNameLocked,
		})}</ui_meta_request>`;

	const paintTitle = (ctx?: ExtensionContext) => {
		const active = ctx ?? lastCtx;
		if (!enabledForSession || !active?.hasUI || !config.title.enabled) return;
		lastCtx = active;
		const directory = basename(active.cwd || process.cwd()) || "pi";
		const fallbackName = pi.getSessionName()?.trim();
		const task = currentTitle || fallbackName || directory;
		const prefix = working ? "● π" : "π";
		active.ui.setTitle(
			task === directory
				? `${prefix} · ${directory}`
				: `${prefix} · ${task} · ${directory}`,
		);
	};

	const restoreState = (ctx: ExtensionContext) => {
		const stored = latestStoredState(ctx);
		currentTitle = stored?.title ?? "";
		pendingAutoSessionName = undefined;
		const currentName = pi.getSessionName()?.trim();
		const storedAutoName = stored?.autoSessionName?.trim();
		if (currentName && storedAutoName === currentName) {
			autoSessionName = currentName;
			manualSessionNameLocked = false;
		} else {
			autoSessionName = undefined;
			manualSessionNameLocked = Boolean(
				config.sessionName.manualNameLocks && currentName,
			);
		}
		stateDirty = false;
	};

	const flushPendingEntries = () => {
		for (const recap of pendingRecaps) {
			pi.appendEntry<TurnRecapData>(TURN_RECAP_TYPE, recap);
		}
		pendingRecaps = [];
		if (!stateDirty) return;
		pi.appendEntry<UiMetaStateData>(UI_META_STATE_TYPE, {
			v: 1,
			...(currentTitle ? { title: currentTitle } : {}),
			...(autoSessionName ? { autoSessionName } : {}),
		});
		stateDirty = false;
	};

	const applySessionDirective = (
		record: Extract<UiMetaRecord, { kind: "turn_start" }>,
	) => {
		if (!config.sessionName.enabled || !record.session) return;
		if (record.session.action === "keep" || manualSessionNameLocked) return;
		const name = record.session.name;
		if (name === pi.getSessionName()?.trim()) {
			if (autoSessionName !== name) {
				autoSessionName = name;
				stateDirty = true;
			}
			return;
		}
		autoSessionName = name;
		pendingAutoSessionName = name;
		stateDirty = true;
		pi.setSessionName(name);
	};

	const applyRecords = (
		records: UiMetaRecord[],
		ctx: ExtensionContext,
		allowRecap: boolean,
	) => {
		if (!enabledForSession || !requestActive) return;
		for (const record of records) {
			if (record.kind === "turn_start" && !startReceived) {
				const titleSatisfied = !config.title.enabled || Boolean(record.title);
				const sessionSatisfied =
					!config.sessionName.enabled ||
					manualSessionNameLocked ||
					Boolean(record.session);
				startReceived = titleSatisfied && sessionSatisfied;
				if (config.title.enabled && record.title && record.title !== currentTitle) {
					currentTitle = record.title;
					stateDirty = true;
					paintTitle(ctx);
				}
				applySessionDirective(record);
				continue;
			}
			if (
				record.kind === "turn_end" &&
				allowRecap &&
				config.recap.enabled &&
				!recapReceived
			) {
				recapReceived = true;
				pendingRecaps.push({ v: 1, text: record.recap, timestamp: Date.now() });
			}
		}
	};

	pi.registerEntryRenderer<TurnRecapData>(
		TURN_RECAP_TYPE,
		(entry, _options, theme) =>
			new Text(
				theme.fg("dim", `${I_RECAP} Recap · ${entry.data?.text ?? ""}`),
				0,
				0,
			),
	);

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant") return markdown;
		return stripUiMetaBlocks(markdown, context.isStreaming);
	});

	pi.on("session_start", (_event, ctx) => {
		enabledForSession = ctx.mode === "tui";
		requestActive = false;
		requestMarker = "";
		continueAfterCompaction = false;
		startReceived = !startMetadataEnabled;
		recapReceived = !config.recap.enabled;
		working = false;
		pendingRecaps = [];
		lastCtx = ctx;
		if (!enabledForSession) return;
		restoreState(ctx);
		paintTitle(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!enabledForSession) return;
		flushPendingEntries();
		const isCompactionContinuation = continueAfterCompaction && requestActive;
		continueAfterCompaction = false;
		requestActive = true;
		({ startReceived, recapReceived } = beginUiMetaRun(
			startMetadataEnabled,
			config.recap.enabled,
			{ startReceived, recapReceived },
			isCompactionContinuation,
		));
		requestMarker = buildRequestMarker(!startReceived, !recapReceived);
		working = true;
		lastCtx = ctx;
		paintTitle(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\n${protocolPrompt}` };
	});

	pi.on("context", (event) => {
		if (!enabledForSession || !requestActive || !requestMarker) return;
		const messages = appendRequestToLatestUserMessage(
			event.messages,
			requestMarker,
		);
		return messages ? { messages } : undefined;
	});

	pi.on("message_update", (event, ctx) => {
		if (!enabledForSession || !isAssistantMessage(event.message)) return;
		applyRecords(
			extractUiMetaRecords(assistantText(event.message), limits),
			ctx,
			false,
		);
	});

	pi.on("message_end", (event, ctx) => {
		if (!enabledForSession || !isAssistantMessage(event.message)) return;
		applyRecords(
			extractUiMetaRecords(assistantText(event.message), limits),
			ctx,
			canCommitUiMetaRecap(
				event.message.stopReason,
				event.message.content.some((entry) => entry.type === "toolCall"),
			),
		);
		const replacement = stripMessageMetadata(event.message);
		return replacement ? { message: replacement } : undefined;
	});

	pi.on("agent_end", () => {
		if (!enabledForSession) return;
		flushPendingEntries();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!enabledForSession || !ctx.isIdle()) return;
		flushPendingEntries();
		requestActive = false;
		requestMarker = "";
		continueAfterCompaction = false;
		working = false;
		paintTitle(ctx);
	});

	pi.on("session_info_changed", (event, ctx) => {
		if (!enabledForSession || !config.sessionName.enabled) return;
		const name = event.name?.trim();
		if (!name) {
			pendingAutoSessionName = undefined;
			autoSessionName = undefined;
			manualSessionNameLocked = false;
			stateDirty = true;
		} else if (name === pendingAutoSessionName) {
			pendingAutoSessionName = undefined;
			autoSessionName = name;
			manualSessionNameLocked = false;
		} else if (config.sessionName.manualNameLocks) {
			pendingAutoSessionName = undefined;
			autoSessionName = undefined;
			manualSessionNameLocked = true;
			stateDirty = true;
		}
		paintTitle(ctx);
	});

	pi.on("session_compact", (event) => {
		if (!enabledForSession || !requestActive) return;
		continueAfterCompaction = event.willRetry;
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!enabledForSession) return;
		flushPendingEntries();
		continueAfterCompaction = false;
		restoreState(ctx);
		paintTitle(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (enabledForSession) flushPendingEntries();
		working = false;
		paintTitle(ctx);
		enabledForSession = false;
		requestActive = false;
		requestMarker = "";
		continueAfterCompaction = false;
		pendingAutoSessionName = undefined;
		lastCtx = undefined;
	});
}
