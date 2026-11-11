# Agent Config

[English](./README.md) | [简体中文](./README.zh-CN.md)

Personal configuration for Pi (1.4.0) and Claude Code. Manages only config files and local extensions; credentials and session data are excluded.

## Quick Start

Prerequisites: `rsync`, `jq`, and a Nerd Font.

```bash
# Install / update configs (shows a diff on conflict and backs up to ~/.agent-config-backups/ after confirmation)
./install-rules.sh
./install-harness.sh pi
./install-harness.sh claude-code

# Update Pi and external packages
pi update
pi update --extensions
```

To roll back, copy the backed-up files from `~/.agent-config-backups/` back to their original paths.

Default preferences:
- Pi: fullscreen TUI, `system` theme, hidden thinking, condensed changelog, `codemode` enabled, external editor `nvim`.
- Fast: disabled by default.
- Claude Code: fullscreen TUI, `auto` theme and permissions, `high` effort, auto-compact context, notifications enabled, feedback drafts disabled.

## Usage

### Shared Rules & Skills

[rules/AGENTS.md](rules/AGENTS.md) maintains cross-harness global rules (respond in Simplified Chinese, verify before asking, modular design, investigate to root cause). Running `./install-rules.sh` syncs it to:

```text
~/.agents/AGENTS.md
~/.claude/CLAUDE.md
~/.codex/AGENTS.md
~/.pi/agent/AGENTS.md
~/.grok/AGENTS.md
```

Shared skills are installed under `~/.agents/skills/` (Remotion, UI/UX Pro Max, TypeSafe AI, GSAP) and managed with `npx skills`:

```bash
npx skills list -g -a claude-code pi
npx skills add <repo> -g -a claude-code pi -y
npx skills update -g
```

### Pi

#### UI & Keybindings

[session-ui](harnesses/pi/builtins/session-ui/README.md) provides a single-line statusline, tool activity panel, work animation, turn duration, automatic terminal title and session naming, and compact clipboard image paste with preview. Subscription quota in the statusline comes from `pi-subscription-usage`, and the last active model and effort are persisted by `pi-last-model-effort`.

| Action | Command / Keybinding |
| --- | --- |
| Thinking effort | `/effort`, `/effort status` |
| Toggle statusline | `/statusline` |
| Work animation | `/work-animation on\|off\|status` |
| Name session | `/name` |
| Select model | `Ctrl+L` or `/model` |
| Page up / down | `Alt+K` / `Alt+J` |
| Jump to top / bottom | `Alt+,` / `Alt+.` |
| Paste & preview image | `Ctrl+V` (macOS; move cursor onto `[image #1]` to preview) |

Config paths (run `/reload` after changes):
- [harnesses/pi/plugin-configs/session-ui/config.json](harnesses/pi/plugin-configs/session-ui/config.json) → `~/.pi/agent/extensions/session-ui/config.json`
- [harnesses/pi/config/settings.json](harnesses/pi/config/settings.json) → `~/.pi/agent/settings.json`
- [harnesses/pi/config/keybindings.json](harnesses/pi/config/keybindings.json) → `~/.pi/agent/keybindings.json`
- `~/.pi/agent/state/session-ui.json` (work animation toggle state)

#### Models & Fast

| Provider | Enabled Models | Notes / Config |
| --- | --- | --- |
| `claude-bridge` | `claude-opus-5-5`, `claude-sonnet-5-5` | Reuses `claude auth login` (Max); [config.json](harnesses/pi/plugin-configs/claude-bridge/config.json) → `~/.pi/agent/claude-bridge.json` |
| `openai-codex` | `gpt-6-astra`, `gpt-6.1-sol` | [models.json](harnesses/pi/config/models.json) → `~/.pi/agent/models.json` (`gpt-6-astra` local context window set to 500K) |
| `xai` | `grok-4.7` | OAuth login |
| `antigravity` | `gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5` | Refresh catalog with `/antigravity.refresh` |
| `google` | `gemini-4-carbon` | `GEMINI_API_KEY` environment variable; Carbon is defined in [models.json](harnesses/pi/config/models.json) → `~/.pi/agent/models.json` |

Select Carbon with `/model google/gemini-4-carbon` (run `/reload` or restart Pi after installing). It uses paid Gemini API billing, not Antigravity subscription quota. Its local cost metadata uses introductory rates through November 30, 2026; update it when pricing changes. The output cap is 32,768 tokens, matching the current model metadata endpoint.

[Fast](harnesses/pi/builtins/fast/README.md) priority requests: `/fast [on|off|status]`.
- Config: [harnesses/pi/plugin-configs/fast/config.json](harnesses/pi/plugin-configs/fast/config.json) → `~/.pi/agent/extensions/fast.json`
- State: `~/.pi/agent/state/fast.json` (remembered per provider)

#### Search & Extension Tools

| Package | Purpose | Config / Requirements |
| --- | --- | --- |
| `pi-fff` | File and code search (overrides `find` / `grep`) | [config.json](harnesses/pi/plugin-configs/pi-fff/config.json) → `~/.pi/agent/pi-fff.json` |
| `pi-web-access` | Web search and fetching (`openai → xai → kimi`) | [config.json](harnesses/pi/plugin-configs/web-search/config.json) → `~/.pi/agent/web-search.json` |
| `rpiv-ask-user-question` | Structured multiple-choice user questions | — |
| `pi-kimi-webbridge-bootstrap` | Operate logged-in browser sessions | Requires companion browser extension |
| `pi-kimi-cu` | Operate macOS desktop apps | Requires Accessibility and Screen Recording permissions |
| `pi-subscription-image` | Codex / Grok subscription image generation (reference edits via Codex) | — |
| [pi-subagent](https://github.com/badlogic/pi-subagent) | `tmux` subagents (`/subagent` or CLI `subagent`) | Requires `tmux` and symlinking `subagent.ts` into `PATH` |

#### Codemode & MCP

`codemode` is enabled by default for batching tool calls or filtering large outputs in scripts.

MCP is configured in `~/.pi/agent/mcp.json` or project `.pi/mcp.json` (unmanaged):

```text
/mcp                  # View status, log in, reconnect, or toggle servers in TUI
pi mcp list           # List connections from CLI
pi mcp login <server> # Authenticate via OAuth from CLI
```

### Claude Code

Enables `gopls-lsp` and `swift-lsp` by default (requires the corresponding language servers installed locally). Uses a single-line footer statusline matching Pi, showing model, effort, directory, branch, context, 5h/7d quota, and cache hit rate. Switch TUI mode with `/tui fullscreen|default`.

| Keybinding | Action |
| --- | --- |
| `Ctrl+L` | Select model |
| `Alt+K` / `Alt+J` | Page up / down |
| `Alt+U` / `Alt+D` | Half-page up / down |
| `Alt+,` / `Alt+.` | Jump to top / bottom |

Config paths:
- [harnesses/claude-code/settings.json](harnesses/claude-code/settings.json) → `~/.claude/settings.json`
- [harnesses/claude-code/keybindings.json](harnesses/claude-code/keybindings.json) → `~/.claude/keybindings.json`
- [harnesses/claude-code/statusline-command.sh](harnesses/claude-code/statusline-command.sh) → `~/.claude/statusline-command.sh`
