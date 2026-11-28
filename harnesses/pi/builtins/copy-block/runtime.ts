import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	launchExternalEditor,
	resolveFallbackEditorCommand,
	type EditorLaunchResult,
} from "./editor.ts";
import {
	collectAssistantMessages,
	parseMessageIndexArg,
	sanitizeFileExtension,
	type AssistantMessageSnapshot,
} from "./extract.ts";
import {
	CopyBlockPickerComponent,
	type CopyBlockPickerAction,
	type PickerUiHelpers,
} from "./picker.ts";

export interface CopyBlockDeps {
	copyToClipboard: (text: string) => Promise<void>;
	resolveEditorCommand: (ctx: ExtensionContext) => string;
	launchEditor?: (
		command: string,
		content: string,
		extension: string,
	) => Promise<EditorLaunchResult>;
	pickerHelpers: PickerUiHelpers;
}

export const COPY_BLOCK_COMMAND = "copy-block";
export const COPY_BLOCK_SHORTCUT = "alt+c";

interface PickerOverlayOutcome {
	choice: CopyBlockPickerAction | undefined;
	tui: Pick<TUI, "stop" | "start" | "requestRender"> | undefined;
}

async function openPickerOverlay(
	ctx: ExtensionContext,
	messages: readonly AssistantMessageSnapshot[],
	initialOffset: number,
	helpers: PickerUiHelpers,
): Promise<PickerOverlayOutcome> {
	let capturedTui: Pick<TUI, "stop" | "start" | "requestRender"> | undefined;
	const choice = await ctx.ui.custom<CopyBlockPickerAction | undefined>(
		(tui, theme, keybindings, done) => {
			capturedTui = tui;
			return new CopyBlockPickerComponent({
				messages,
				initialMessageOffset: initialOffset,
				tui,
				theme,
				keybindings,
				helpers,
				onDone: done,
			});
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "82%",
				minWidth: 44,
				maxHeight: "82%",
				margin: 1,
			},
			blocked: {
				kind: "question",
				message: "Select a block to copy",
			},
		},
	);
	return { choice, tui: capturedTui };
}

async function openInExternalEditor(
	tui: Pick<TUI, "stop" | "start" | "requestRender">,
	command: string,
	content: string,
	extension: string,
	launcher: (
		command: string,
		content: string,
		extension: string,
	) => Promise<EditorLaunchResult>,
): Promise<EditorLaunchResult> {
	tui.stop();
	try {
		return await launcher(command, content, extension);
	} catch (error) {
		return {
			ok: false,
			message: `External editor failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

export function registerCopyBlock(
	pi: ExtensionAPI,
	deps: CopyBlockDeps,
): void {
	const launcher = deps.launchEditor ?? launchExternalEditor;

	const run = async (rawArgs: string, ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`/${COPY_BLOCK_COMMAND} requires interactive TUI mode.`,
					"error",
				);
			}
			return;
		}

		const messages = collectAssistantMessages(ctx.sessionManager.getBranch());
		if (messages.length === 0) {
			ctx.ui.notify("No assistant replies to copy yet.", "warning");
			return;
		}

		const parsed = parseMessageIndexArg(rawArgs, messages.length);
		if (!parsed.ok) {
			ctx.ui.notify(parsed.error, "warning");
			return;
		}

		const { choice, tui } = await openPickerOverlay(
			ctx,
			messages,
			parsed.index - 1,
			deps.pickerHelpers,
		);
		if (!choice) return;

		if (choice.action === "copy") {
			try {
				await deps.copyToClipboard(choice.item.content);
				const lineNoun = choice.item.lineCount === 1 ? "line" : "lines";
				ctx.ui.notify(
					`Copied ${choice.item.label} (${choice.item.lineCount} ${lineNoun})`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : "Failed to copy to clipboard.",
					"error",
				);
			}
			return;
		}

		if (!tui) {
			ctx.ui.notify("Unable to suspend TUI to launch external editor.", "error");
			return;
		}

		const editorCmd =
			deps.resolveEditorCommand(ctx) || resolveFallbackEditorCommand();
		const extension =
			choice.item.kind === "code"
				? sanitizeFileExtension(choice.item.lang)
				: "md";
		const result = await openInExternalEditor(
			tui,
			editorCmd,
			choice.item.content,
			extension,
			launcher,
		);
		if (!result.ok && result.message) {
			ctx.ui.notify(result.message, "warning");
		}
	};

	pi.registerCommand(COPY_BLOCK_COMMAND, {
		description:
			"Pick a raw code block, quote, or full assistant reply to copy or open in your editor",
		handler: async (args, ctx) => run(args, ctx),
	});

	pi.registerShortcut(COPY_BLOCK_SHORTCUT, {
		description: "Open the raw block copy picker",
		handler: async (ctx) => run("", ctx),
	});
}
