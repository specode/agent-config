# Agent Config

[English](./README.md) | [简体中文](./README.zh-CN.md)

个人使用的 Pi（1.4+）与 Claude Code 配置。只管理配置文件和本地扩展，不含凭据与会话数据。

## 快速开始

环境要求：Pi / Claude Code、`rsync`（Pi 安装）、`jq`（Claude Code 状态栏）、Nerd Font。

```bash
# 安装 / 更新托管配置（本地有冲突时先提示确认，原文件自动备份）
./install-rules.sh
./install-harness.sh pi
./install-harness.sh claude-code

# 安装或更新 Pi 本体与 settings.json 声明的外部扩展包
pi update --all
```

如需恢复旧配置，从 `~/.agent-config-backups/<timestamp>-<pid>/<group>/` 拷回 `~/` 对应路径即可。

默认偏好：
- Pi：全屏 TUI、`system` 主题、隐藏 thinking、折叠更新日志、启用 `codemode`、外部编辑器 `nvim`；`Fast` 默认关闭。
- Claude Code：全屏 TUI、`auto` 主题、`auto` 权限模式（跳过危险模式确认提示）、`high` 思考档位、自动压缩上下文、开启通知、关闭反馈草稿。

## 使用说明

### 通用规则与 Skills

[rules/AGENTS.md](rules/AGENTS.md) 维护跨工具全局规则（默认简体中文、先核实后提问、模块化设计、排查到底）。运行 `./install-rules.sh` 同步到：

```text
~/.agents/AGENTS.md
~/.claude/CLAUDE.md
~/.codex/AGENTS.md
~/.pi/agent/AGENTS.md
~/.grok/AGENTS.md
```

共用 Skills 不纳入本仓库托管，通过 `npx skills` 安装到 `~/.agents/skills/`：

```bash
npx skills list -g -a claude-code pi
npx skills add <repo> -g -a claude-code pi -y
npx skills update -g
```

桌面 GUI 自动化使用 [cua-driver](https://cua.ai/docs/cua-driver)（Pi 与 Claude Code 共用，本仓库不托管）：按官方文档将 `cua-driver` CLI 装入 `PATH` 并安装配套 Skill（默认走 CLI，也支持 MCP）；macOS 需授予“辅助功能”与“屏幕录制”权限，装完运行 `cua-driver doctor` 自检。

### Pi

#### 界面与快捷键

[session-ui](harnesses/pi/builtins/session-ui/README.zh-CN.md) 提供单行状态栏、工具进度、工作动画、回合耗时、自动标题/会话命名，以及剪贴板图片紧凑粘贴与预览。状态栏订阅额度来自 `pi-subscription-usage`，上次使用的模型和档位由 `pi-last-model-effort` 记录。

| 操作 | 命令 / 快捷键 |
| --- | --- |
| 思考档位 | `/effort`、`/effort status` |
| 切换状态栏 | `/statusline` |
| 工作动画 | `/work-animation on\|off\|status` |
| 会话命名 | `/name` |
| 切换模型 | `Ctrl+L` 或 `/model` |
| 翻整页 | `Alt+K` / `Alt+J` |
| 跳到顶 / 底 | `Alt+,` / `Alt+.` |
| 粘贴并预览图片 | `Ctrl+V`（macOS，光标移入 `[image #1]` 预览） |

配置路径（改完 `/reload` 生效）：
- [harnesses/pi/plugin-configs/session-ui/config.json](harnesses/pi/plugin-configs/session-ui/config.json) → `~/.pi/agent/extensions/session-ui/config.json`
- [harnesses/pi/config/settings.json](harnesses/pi/config/settings.json) → `~/.pi/agent/settings.json`
- [harnesses/pi/config/keybindings.json](harnesses/pi/config/keybindings.json) → `~/.pi/agent/keybindings.json`
- `~/.pi/agent/state/session-ui.json`（工作动画开关状态）

#### 模型与 Fast

| 通道 | 启用模型 | 备注 / 配置 |
| --- | --- | --- |
| `claude-bridge` | `claude-fable-5-2`、`claude-opus-5-5`、`claude-sonnet-5-5` | 复用 `claude auth login`（Max）；[config.json](harnesses/pi/plugin-configs/claude-bridge/config.json) → `~/.pi/agent/claude-bridge.json` |
| `openai-codex` | `gpt-6-astra`、`gpt-6.1-sol` | [models.json](harnesses/pi/config/models.json) → `~/.pi/agent/models.json`（`gpt-6-astra` 本地上下文设为 500K） |
| `xai` | `grok-4.7` | OAuth 登录 |
| `antigravity` | `gemini-4-argon`、`gemini-3.8-flash`、`claude-opus-5-5`、`claude-sonnet-5-5` | `/antigravity.refresh` 刷新列表 |
| `google` | `gemini-4-carbon` | 环境变量 `GEMINI_API_KEY`；定义在 [models.json](harnesses/pi/config/models.json) → `~/.pi/agent/models.json` |

Carbon 通过 `/model google/gemini-4-carbon` 选择（安装配置后需 `/reload` 或重启），按 Gemini API 用量计费，不占用 Antigravity 订阅额度；`models.json` 中配置了 32,768 输出上限及截至 2026-11-30 的优惠单价。

[Fast](harnesses/pi/builtins/fast/README.zh-CN.md) 加速通道：`/fast [on|off|status]`。
- 配置：[harnesses/pi/plugin-configs/fast/config.json](harnesses/pi/plugin-configs/fast/config.json) → `~/.pi/agent/extensions/fast.json`
- 状态：`~/.pi/agent/state/fast.json`（按 provider 独立记忆）

#### 搜索与扩展工具

| 插件 | 用途 | 配置 / 依赖 |
| --- | --- | --- |
| `pi-fff` | 文件与代码搜索（接管 `find` / `grep`） | [config.json](harnesses/pi/plugin-configs/pi-fff/config.json) → `~/.pi/agent/pi-fff.json` |
| `pi-web-access` | 网页搜索与抓取（`openai → xai → kimi`） | [config.json](harnesses/pi/plugin-configs/web-search/config.json) → `~/.pi/agent/web-search.json` |
| `rpiv-ask-user-question` | 结构化选项提问 | — |
| `pi-subscription-image` | Codex / Grok 订阅生图（参考图走 Codex） | — |
| [pi-subagent](https://github.com/badlogic/pi-subagent) | `tmux` 子代理（`/subagent` 或 CLI `subagent`） | 需 `tmux`，并将 `subagent.ts` 链入 `PATH` |

#### Codemode 与 MCP

默认开启 `codemode`，支持用脚本并发调用工具或过滤结果。

MCP 配置位于 `~/.pi/agent/mcp.json` 或项目 `.pi/mcp.json`（不托管）：

```text
/mcp                  # TUI 查看状态、登录、重连、启停
pi mcp list           # CLI 查看连接
pi mcp login <server> # CLI OAuth 登录
```

### Claude Code

默认启用 `gopls-lsp` 与 `swift-lsp`（需本机安装对应 LSP）。底部单行状态栏与 Pi 一致，显示模型、档位、目录、分支、上下文、5h/7d 额度与缓存命中率。TUI 模式用 `/tui fullscreen|default` 切换。

| 操作 | 快捷键 |
| --- | --- |
| 切换模型 | `Ctrl+L` |
| 翻整页 | `Alt+K` / `Alt+J` |
| 翻半页 | `Alt+U` / `Alt+D` |
| 跳到顶 / 底 | `Alt+,` / `Alt+.` |

配置路径：
- [harnesses/claude-code/settings.json](harnesses/claude-code/settings.json) → `~/.claude/settings.json`
- [harnesses/claude-code/keybindings.json](harnesses/claude-code/keybindings.json) → `~/.claude/keybindings.json`
- [harnesses/claude-code/statusline-command.sh](harnesses/claude-code/statusline-command.sh) → `~/.claude/statusline-command.sh`
