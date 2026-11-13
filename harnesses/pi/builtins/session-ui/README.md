# Pi session-ui

[English](./README.md) | [简体中文](./README.zh-CN.md)

Pi terminal UI extension providing a single-line footer statusline, tool activity panel, work animation, compact clipboard image paste with preview, `/effort` switcher, turn duration, and automatic terminal title and session naming.

## Quick Start

From the repository root (requires Pi 1.4+ and `rsync`):

```bash
./install-harness.sh pi
```

Installs to `~/.pi/agent/extensions/session-ui/`. Restart Pi or run `/reload` to apply.

## Usage

### Features & Commands

| Module | Command / Trigger | Description |
| --- | --- | --- |
| Tool activity | Automatic | Lists current-turn tool calls above the editor (`◆` running, `◇` done, `✗` failed; nested Codemode calls are indented) and clears when the turn ends |
| Work animation | `/work-animation on\|off\|status` | Persists toggle state in `~/.pi/agent/state/session-ui.json`, taking precedence over `config.json` |
| Image paste & preview | `Ctrl+V` (macOS) | Inserts compact `[image #1]` placeholders; move the cursor onto a placeholder to preview (requires Kitty or iTerm2 image protocol; `Cmd+V` pastes text only) |
| Statusline | `/statusline` | Temporarily switches between the custom single-line statusline and the native footer |
| Thinking effort | `/effort [level\|status]` | Opens the level selector without arguments, or sets the level directly |
| Turn duration | Automatic | Shows elapsed time at the end of each assistant turn |
| Title & naming | Automatic / `/name` | Piggybacks on normal main-model responses (no extra model calls): names unnamed sessions once a clear goal emerges (never overwrites existing names) and updates the terminal title as activity changes; skipped during detached background runs |

### Statusline Segments

Displayed items and order are controlled by `statusline.segments`:

| ID | Content |
| --- | --- |
| `model` | Active model (abbreviated to model ID on narrow terminals) |
| `effort` | Thinking effort (hidden when `off`) and `fast` badge |
| `directory` | Current working directory |
| `branch` | Git branch |
| `context` | Context window usage percentage and capacity |
| `usage` | Subscription window quota and reset countdown (requires `pi-subscription-usage`) |
| `tokens` | Cumulative input / output tokens (`↑in ↓out`; omitted in repo `config.json`) |
| `cache` | Assistant request cache hit rate (`last/recent5/session`) |
| `cost` | Cumulative estimated session cost (catalog-rate estimate) |
| `extensions` | Other non-excluded extension statuses |
| `session` | Session name (disabled by default) |

`fast` only indicates that local fast-mode handling is active; see [Fast](../fast/README.md). Check MCP status with `/mcp`.

### Configuration

- Default path: `~/.pi/agent/extensions/session-ui/config.json` (repo source: [config.json](../../plugin-configs/session-ui/config.json))
- Environment override: `PI_SESSION_UI_CONFIG=/absolute/path/to/session-ui.json pi`

Run `/reload` after editing. All modules (`toolActivity`, `workAnimation`, `compactPaste`, `statusline`, `effort`, `turnDuration`, `uiMeta`) are enabled by default and can be disabled with `enabled: false`:

| Option | Default | Allowed Values / Range |
| --- | --- | --- |
| `toolActivity.placement` | `"aboveEditor"` | `"aboveEditor"` \| `"belowEditor"` |
| `toolActivity.maxItems` | `6` | `1`–`20` |
| `workAnimation.placement` | `"aboveEditor"` | `"aboveEditor"` \| `"belowEditor"` |
| `workAnimation.intervalMs` | `180` | `100`–`500` (ms) |
| `statusline.overflow` | `"drop-right"` | `"drop-right"` (hide from right) \| `"priority"` (compact first, then hide by priority) |
| `statusline.segments` | All segments above except `session` | Array of segment IDs (replaces the default list and deduplicates) |
| `statusline.extensionStatuses.exclude` | `["fast", "mcp", "mcp-*", "subscription-usage"]` | Status IDs excluded from `extensions` (replaces defaults; supports `*` wildcards) |
| `uiMeta.title.enabled` | `true` | `boolean` |
| `uiMeta.title.maxLength` | `36` | `8`–`80` |
| `uiMeta.sessionName.enabled` | `true` | `boolean` |
| `uiMeta.sessionName.maxLength` | `48` | `8`–`100` |
