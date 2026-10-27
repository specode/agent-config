# Agent Config

自用的 Pi 与 Claude Code 配置，统一日常协作规则，并配齐常用的搜索、界面和模型扩展。

仓库只管理配置文件与本地扩展，不包含工具本体、登录凭据或会话记录。Pi 配置按当前稳定版 **1.4.0** 维护。

## 快速开始

先安装并登录所需工具，再在仓库根目录按需执行：

```bash
./install-rules.sh
./install-harness.sh pi
./install-harness.sh claude-code
```

安装 Pi 配置需要 `rsync`，Claude Code 状态栏需要 `jq`。终端建议使用 Nerd Font，否则状态栏图标无法正常显示。

安装器按文件或插件目录整组替换。本地已有不同内容时会先显示 diff，确认后再备份到 `~/.agent-config-backups/` 并覆盖。装完重启对应工具即可。

默认设置：
- **Pi**：全屏 TUI、`system` 主题（跟随终端明暗）、隐藏 thinking 正文、折叠更新日志、默认启用 `codemode`，外部编辑器为 `nvim`。
- **Fast**：默认关闭；开启可能增加订阅额度消耗。
- **Claude Code**：全屏 TUI、`auto` 主题、`auto` 权限模式、`high` 思考档位，开启自动压缩上下文与通知，关闭反馈草稿。

## 使用说明

### 通用规则与 Skills

[rules/AGENTS.md](rules/AGENTS.md) 定义了跨工具的全局规则（默认简体中文、先核实再提问、模块化设计、充分排查与验证）。修改后运行 `./install-rules.sh`，会同步覆盖 `~/.agents/AGENTS.md`、`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.pi/agent/AGENTS.md` 和 `~/.grok/AGENTS.md`，不影响项目内的规则文件。

Claude Code 与 Pi 共用的 Skills 放在 `~/.agents/skills/`，通过 `npx skills` 管理，不由本仓库安装脚本处理。目前装有 Remotion、UI/UX Pro Max、TypeSafe AI 和八个 GSAP 技能：

```bash
npx skills list -g -a claude-code pi
npx skills add <来源> -g -a claude-code pi -y
npx skills update -g
```

变更后在 Pi 执行 `/reload`，Claude Code 重启后用 `/skills` 查看。插件自带的技能由插件自身管理。

### Pi

#### 界面与快捷键

[session-ui](harnesses/pi/builtins/session-ui/README.md) 负责终端界面：底部是单行状态栏，输入框上方显示当前回合的工具调用进度和工作动画，每轮回复结束后显示耗时，并根据对话自动更新终端标题和未命名会话的名称（不额外调用模型，也不会覆盖已有名称）。macOS 下按 `Ctrl+V` 粘贴剪贴板图片会显示为 `[image #1]`，把光标移上去即可预览。

状态栏的订阅额度数据来自 `pi-subscription-usage`，上次使用的模型和思考档位由 `pi-last-model-effort` 自动记住。

| 操作 | 命令 / 快捷键 |
| --- | --- |
| 选择 / 查看思考档位 | `/effort`、`/effort status` |
| 临时切换自定义 / 原生状态栏 | `/statusline` |
| 开关 / 查看工作动画 | `/work-animation on`、`off`、`status` |
| 手动命名会话 | `/name` |
| 选择模型 | `Ctrl+L` 或 `/model` |
| 全屏上下翻整页 | `Alt+K` / `Alt+J` |
| 全屏跳到顶部 / 底部 | `Alt+,` / `Alt+.` |

动画开关保存在 `~/.pi/agent/state/session-ui.json`。修改以下配置文件后执行 `/reload` 生效：
- 界面配置：[harnesses/pi/plugin-configs/session-ui/config.json](harnesses/pi/plugin-configs/session-ui/config.json) → `~/.pi/agent/extensions/session-ui/config.json`
- 基础设置：[harnesses/pi/config/settings.json](harnesses/pi/config/settings.json) → `~/.pi/agent/settings.json`
- 快捷键：[harnesses/pi/config/keybindings.json](harnesses/pi/config/keybindings.json) → `~/.pi/agent/keybindings.json`

#### 模型与 Fast

用 `/login` 登录各家账号后，通过 `Ctrl+L` 或 `/model` 切换模型。[settings.json](harnesses/pi/config/settings.json) 中启用的模型顺序如下（列在配置里只控制选择器显示，实际能否调用取决于账号权限）：

1. **Claude Bridge**（`pi-claude-bridge`）：复用本机 Claude Code 登录态（需先执行 `claude auth login`），启用 `claude-bridge/claude-opus-5-5` 和 `claude-bridge/claude-sonnet-5-5`。
2. **OpenAI Codex**：启用 `openai-codex/gpt-6-astra` 和 `openai-codex/gpt-6.1-sol`。
3. **xAI**：启用 `xai/grok-4.7`。
4. **Antigravity 与 Google Gemini**：`pi-antigravity` 提供 `antigravity/gemini-4-argon`、`gemini-3.8-flash`、`claude-opus-5-5`、`claude-sonnet-5-5`（可用 `/antigravity.refresh` 刷新目录）；内置 `google` 通道启用 `google/gemini-4-argon`，读取环境变量 `GEMINI_API_KEY`，与 Antigravity 互不依赖。

[models.json](harnesses/pi/config/models.json)（→ `~/.pi/agent/models.json`）把两个 Codex GPT 模型的本地上下文预算设到了 500K tokens，不改输出上限，也不代表服务端一定支持该窗口。因为安装器会整体替换 `models.json`，如果你自己配过其他自定义模型，安装前需要先合并。

[Fast](harnesses/pi/builtins/fast/README.md) 用于开启高优先级请求：`/fast` 切换，`/fast on` 开启，`/fast off` 关闭，`/fast status` 查看。开关按 provider 保存在 `~/.pi/agent/state/fast.json`，默认配置文件为 [harnesses/pi/plugin-configs/fast/config.json](harnesses/pi/plugin-configs/fast/config.json)（→ `~/.pi/agent/extensions/fast.json`）。状态栏上的 `fast` 只代表本地已按加速策略发请求，实际是否加速由后端决定。

#### 搜索与扩展工具

平时直接用自然语言提要求即可，Agent 会自己挑选工具：

| 插件 | 用途 |
| --- | --- |
| `pi-fff` | 搜索文件名与代码内容；默认接管 `find` 和 `grep`，不扫描整个 HOME |
| `pi-web-access` | 网页搜索与正文抓取，按 `openai → xai → kimi` 顺序路由并自动回退 |
| `rpiv-ask-user-question` | 需要确认偏好或做选择时弹出结构化选项 |
| `pi-kimi-webbridge-bootstrap` | 操作已登录的日常浏览器（需安装并连接配套浏览器扩展） |
| `pi-kimi-cu` | 操作 macOS 桌面应用（需授予辅助功能与录屏权限） |
| `pi-subscription-image` | 用 Codex 或 Grok 订阅生图；带参考图编辑时走 Codex |

Antigravity 也带 Google 搜索和生图功能，想走这条通道时在提问里直接说明即可。

搜索配置文件：
- 文件搜索：[harnesses/pi/plugin-configs/pi-fff/config.json](harnesses/pi/plugin-configs/pi-fff/config.json) → `~/.pi/agent/pi-fff.json`
- 网页搜索：[harnesses/pi/plugin-configs/web-search/config.json](harnesses/pi/plugin-configs/web-search/config.json) → `~/.pi/agent/web-search.json`

#### 子代理

[pi-subagent](https://github.com/badlogic/pi-subagent) 通过 `git:github.com/badlogic/pi-subagent` 引入，随上游默认分支更新（用 `pi update --extensions` 升级）。

使用前需安装 `tmux`，并按上游文档把 `~/.pi/agent/git/github.com/badlogic/pi-subagent/subagent.ts` 链到 `PATH` 中的 `subagent`。如果以前手动克隆过 `~/.pi/agent/extensions/subagent`，请删掉，避免跟 Git 包重复加载。

对话中直接让 Agent 派子代理去审查、排查或写代码即可。子代理默认继承当前会话的模型与思考档位，会单独消耗额度。在 Pi 里可以用 `/subagent` 进入子代理会话，终端下可用 `subagent list`、`subagent send`、`subagent wait` 和 `subagent stop`。

#### Codemode 与 MCP

仓库默认开启内置的 `codemode`，Agent 可以写一小段脚本并行调多个工具或先过滤输出再返回（比如“并行看下 Git 状态和最近提交”），普通工具也照常可用。注意不要让它并行改同一个文件。

MCP 服务器使用 Pi 内置支持，配置写在 `~/.pi/agent/mcp.json` 或项目的 `.pi/mcp.json`（安装器不托管此文件）：
- `/mcp`：查看状态、登录、重连或启停服务。
- `pi mcp list`：在终端查看连接。
- `pi mcp login <server>`：在终端完成 OAuth 登录。
- 改完配置后执行 `/reload`。

### Claude Code

#### 语言服务与状态栏

默认开启 `gopls-lsp` 和 `swift-lsp`，写 Go 或 Swift 项目前先在本机装好对应的语言服务。

底部状态栏和 Pi 的风格一致，单行显示模型、思考档位、目录、Git 分支、上下文占用、5 小时与 7 天订阅剩余额度（带重置倒计时）和缓存命中率，依赖 `jq`。

界面默认用全屏 TUI 和自动明暗主题，可用 `/tui` 查看，`/tui fullscreen` 或 `/tui default` 切换。

#### 快捷键与配置

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+L` | 打开模型选择器 |
| `Alt+K` / `Alt+J` | 向上 / 向下翻整页 |
| `Alt+U` / `Alt+D` | 向上 / 向下翻半页 |
| `Alt+,` / `Alt+.` | 滚动到顶部 / 底部 |

配置文件：
- 基础设置：[harnesses/claude-code/settings.json](harnesses/claude-code/settings.json) → `~/.claude/settings.json`
- 快捷键：[harnesses/claude-code/keybindings.json](harnesses/claude-code/keybindings.json) → `~/.claude/keybindings.json`
- 状态栏脚本：[harnesses/claude-code/statusline-command.sh](harnesses/claude-code/statusline-command.sh) → `~/.claude/statusline-command.sh`

## 更新与恢复

- **更新配置**：`git pull` 后重新运行 `./install-rules.sh` 或 `./install-harness.sh <pi|claude-code>`（`./install-harness.sh --list` 可看支持的列表）。直接改 `~/.pi` 或 `~/.claude` 下的托管文件下次安装会被提示覆盖，建议改在仓库里再装。
- **更新 Pi 与插件**：`pi update` 更新 Pi 本体，`pi update --extensions` 更新外部插件，装完重启。
- **恢复旧配置**：从安装输出提示的 `~/.agent-config-backups/` 备份目录把原文件拷回原路径，重启工具即可。
