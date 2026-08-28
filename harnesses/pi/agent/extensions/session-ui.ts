/**
 * session-ui — composable Pi session presentation.
 *
 * Design constraints:
 * - Never replace tool execution. Tool lifecycle events feed ephemeral UI projections.
 * - Paste placeholders reuse Pi's native editor registry behind runtime guards.
 * - Footer modules are registered segments whose order is controlled by config.
 * - UI metadata, work state, and animation frames share one terminal-title owner.
 *
 * Configuration: ./session-ui/config.json
 * Override path: PI_SESSION_UI_CONFIG=/absolute/path/to/config.json
 *
 * Commands:
 *   /effort [level|status]
 *   /statusline
 *   /work-animation [on|off|status]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactPasteEditor } from "./session-ui/compact-paste.ts";
import { loadSessionUiConfig } from "./session-ui/config.ts";
import { registerEffort } from "./session-ui/effort.ts";
import { registerStatusline } from "./session-ui/statusline.ts";
import { registerSessionTitleController } from "./session-ui/title-controller.ts";
import { registerToolActivity } from "./session-ui/tool-activity.ts";
import { registerTurnDuration } from "./session-ui/turn-duration.ts";
import { registerUiMeta } from "./session-ui/ui-meta.ts";
import { registerWorkAnimation } from "./session-ui/work-animation.ts";

export default function sessionUi(pi: ExtensionAPI): void {
	const loaded = loadSessionUiConfig();
	const { config } = loaded;
	const titleController = registerSessionTitleController(pi);

	if (config.turnDuration.enabled) registerTurnDuration(pi);
	if (
		config.uiMeta.enabled &&
		(config.uiMeta.title.enabled ||
			config.uiMeta.recap.enabled ||
			config.uiMeta.sessionName.enabled)
	) {
		registerUiMeta(pi, config.uiMeta, titleController);
	}
	registerWorkAnimation(pi, config.workAnimation, loaded.path, titleController);
	if (config.compactPaste.enabled) registerCompactPasteEditor(pi);
	if (config.toolActivity.enabled) {
		registerToolActivity(pi, config.toolActivity);
	}
	if (config.statusline.enabled) registerStatusline(pi, config.statusline);
	if (config.effort.enabled) registerEffort(pi);

	if (loaded.warnings.length > 0) {
		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.notify(
				`session-ui config fallback (${loaded.path}): ${loaded.warnings.join("; ")}`,
				"warning",
			);
		});
	}
}
