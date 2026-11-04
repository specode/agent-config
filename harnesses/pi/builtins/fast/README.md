# Fast

[English](./README.md) | [简体中文](./README.zh-CN.md)

Pi extension that enables fast-mode routing for subscription models via `/fast`: attaches `service_tier: "priority"` for OpenAI / Codex and routes Grok 4.7 to `grok-4.7-build-fast` via the Grok Build proxy. Disabled by default and installable standalone.

## Quick Start

Log in to your ChatGPT or xAI OAuth account in Pi with `/login` first (API keys are not supported), then install using either method:

```bash
# Option 1: install the entry file (keep the full directory intact)
pi install /absolute/path/to/fast/index.ts

# Option 2: copy the directory into extensions (choose one to avoid duplicate loading)
cp -R /absolute/path/to/fast ~/.pi/agent/extensions/fast
```

Enable in Pi:

```text
/reload
/fast on
/fast status
```

## Usage

### Commands & State

| Command | Description |
| --- | --- |
| `/fast` | Toggle for the active provider |
| `/fast on` | Enable |
| `/fast off` | Disable |
| `/fast status` | Show current status |

- Outputs a single line: `Fast: on`, `Fast: off`, or `Fast: unavailable (<reason>)`. `Fast: on` only indicates that local fast-mode request handling is active.
- Switches for `openai`, `openai-codex`, and `xai` are saved independently per provider in the state file and persist across sessions.
- Requests are left untouched when switching to an unsupported model or auth mode; running `/fast` manually in that state reports unavailable and resets any saved `on` state for that provider to `off`.

### Provider Rules

| Provider | API | Model Scope | Local Request Handling |
| --- | --- | --- | --- |
| `openai` | `openai-responses` | Any model ID | Injects `"priority"` when `service_tier` is unset (preserves existing values) |
| `openai-codex` | `openai-codex-responses` | Any model ID | Injects `"priority"` when `service_tier` is unset (preserves existing values) |
| `xai` | `openai-responses` | `xai/grok-4.7` only | Routes through the Grok Build proxy as `grok-4.7-build-fast`; session history and model selector stay `xai/grok-4.7`, with local cost estimated at 2x catalog rate |

If the Grok proxy returns `426` due to a minimum client version bump, increase `grokClientVersion` in the config file.

### Configuration

- Config: `~/.pi/agent/extensions/fast.json` (read-only)
- State: `~/.pi/agent/state/fast.json` (managed by the extension)

Both resolve under `PI_CODING_AGENT_DIR` when set. Example config (all fields are optional):

```json
{
  "enabled": false,
  "showStatus": true,
  "grokClientVersion": "1.0.40"
}
```

| Field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `false` | Initial default before a provider switch has been toggled manually |
| `showStatus` | `true` | Whether to publish the `fast` badge to the statusline |
| `grokClientVersion` | `"1.0.40"` | Client version declared to the Grok Build proxy |

If the config file contains unknown fields or invalid types, Fast reports an error on startup and stays inactive until fixed and reloaded with `/reload`.
