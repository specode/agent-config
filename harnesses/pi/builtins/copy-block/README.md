# Copy Block

[English](./README.md) | [简体中文](./README.zh-CN.md)

Pi extension that provides an interactive picker (`/copy-block` and `Alt+C`) to copy raw fenced code blocks, blockquotes, or full assistant replies directly from session Markdown source—without terminal padding, list continuation indentation, blockquote borders, or soft-wrap newlines.

## Quick Start

Install the directory into Pi's extensions folder:

```bash
cp -R /absolute/path/to/copy-block ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
```

## Usage

### Commands & Shortcut

| Trigger | Action |
| --- | --- |
| `/copy-block` or `Alt+C` | Open the picker on the latest assistant reply |
| `/copy-block N` | Open the picker on the Nth-latest assistant reply (`1` = latest) |

### Picker Controls

| Key | Action |
| --- | --- |
| `↑` / `↓` or `k` / `j` | Move selection |
| `1`–`9` | Jump to item 1–9 |
| `Enter` | Copy selected block to clipboard |
| `f` | Copy the full current assistant reply |
| `e` | Open selected block in external editor (`externalEditor` / `$VISUAL` / `$EDITOR`) |
| `E` | Open the full current assistant reply in external editor |
| `←` / `→` or `h` / `l` or `[` / `]` | Switch to an older / newer assistant reply in the current branch |
| `PgUp` / `PgDn` or `Ctrl+U` / `Ctrl+D` | Scroll the live preview pane |
| `Esc` / `q` | Close picker |

Notes:
- Extracts fenced code blocks (including blocks nested inside ordered/unordered lists or blockquotes, stripping container indentation while preserving code indentation), blockquotes, and the full raw Markdown reply.
- `e` / `E` opens a temporary scratch file (deleted after the editor exits; edits are not written back to the session) and requires a blocking editor command such as `nvim` or `code --wait`.
