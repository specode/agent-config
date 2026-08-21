/**
 * session-ui — composable Pi session presentation.
 *
 * Design constraints:
 * - Never replace tool execution. Tool lifecycle events feed an ephemeral UI projection.
 * - Paste placeholders reuse Pi's native editor registry behind runtime guards;
 *   incompatible editor internals fall back to native paste behavior.
 * - Footer modules are registered segments whose order is controlled by config.
 * - Hidden ui_meta records drive per-turn titles, recaps, and high-level session names.
 *
 * Configuration: ./session-ui/config.json
 * Override path: PI_SESSION_UI_CONFIG=/absolute/path/to/config.json
 *
 * Commands:
 *   /effort [level|status]
 *   /statusline
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactPasteEditor } from "./session-ui/compact-paste.ts";
import { loadSessionUiConfig } from "./session-ui/config.ts";
import { registerEffort } from "./session-ui/effort.ts";
import { registerStatusline } from "./session-ui/statusline.ts";
import { registerToolActivity } from "./session-ui/tool-activity.ts";
import { registerTurnDuration } from "./session-ui/turn-duration.ts";
import { registerUiMeta } from "./session-ui/ui-meta.ts";

export default function sessionUi(pi: ExtensionAPI): void {
 const loaded = loadSessionUiConfig();
 const { config } = loaded;

 if (config.turnDuration.enabled) registerTurnDuration(pi);
 if (
  config.uiMeta.enabled &&
  (config.uiMeta.title.enabled ||
   config.uiMeta.recap.enabled ||
   config.uiMeta.sessionName.enabled)
 ) {
  registerUiMeta(pi, config.uiMeta);
 }
 if (config.compactPaste.enabled) registerCompactPasteEditor(pi);
 if (config.toolActivity.enabled) registerToolActivity(pi, config.toolActivity);
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
