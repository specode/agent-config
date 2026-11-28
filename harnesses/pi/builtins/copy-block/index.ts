import {
	copyToClipboard,
	getAgentDir,
	highlightCode,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { resolveFallbackEditorCommand } from "./editor.ts";
import { registerCopyBlock } from "./runtime.ts";

function resolveEditorCommand(ctx: ExtensionContext): string {
	try {
		return SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getExternalEditorCommand();
	} catch {
		return resolveFallbackEditorCommand();
	}
}

export default function copyBlock(pi: ExtensionAPI): void {
	registerCopyBlock(pi, {
		copyToClipboard,
		resolveEditorCommand,
		pickerHelpers: {
			visibleWidth,
			truncateToWidth,
			matchesKey,
			highlightCode,
		},
	});
}
