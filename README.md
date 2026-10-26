# Agent Config

个人 AI 编程工具配置，统一协作习惯，并为 Pi、Claude Code 补齐搜索、界面和模型使用体验。

- **通用规则**：简体中文、澄清关键歧义、模块化设计、充分排查与验证。
- **Pi**：代码与网页搜索、结构化提问、浏览器与桌面操作、图片生成和会话界面。
- **Claude Code**：Go／Swift 语言服务、快捷键和状态栏。

仓库只管理配置与本地扩展，不安装工具本体，不包含账号、凭据或会话记录。Pi 配置按当前稳定版 **1.4.0** 使用。

## 快速开始

先安装并登录所需工具，再在仓库根目录执行：

```bash
./install-rules.sh
./install-harness.sh pi
./install-harness.sh claude-code
```

按需选择 harness；Pi 配置安装需要 `rsync`，Claude Code 状态栏需要 `jq`。终端建议使用 Nerd Font，以完整显示状态栏图标。

配置按文件或插件目录整体安装，不逐项合并。有冲突时会询问是否备份并覆盖。安装后重新启动工具。

个人默认值：
- Pi 使用全屏 TUI、跟随终端配色的 `system` 主题，隐藏 thinking 正文，外部编辑器为 `nvim`。
- Fast 默认关闭；开启可能增加订阅额度消耗。
- Claude Code 使用 `auto` 权限模式、`high` 思考档位和自动上下文压缩。

## 使用说明

### 通用规则与 Skills

修改 [全局规则](rules/AGENTS.md) 后运行 `./install-rules.sh`，同时更新 Agent、Claude Code、Codex、Pi 和 Grok 的用户级规则，不修改项目规则。

Claude Code 与 Pi 的共用 Skills 使用 `npx skills` 管理，源文件位于 `~/.agents/skills/`。当前共用 Remotion、UI/UX Pro Max、TypeSafe AI 和八个 GSAP 技能。

```bash
npx skills list -g -a claude-code pi
npx skills add <来源> -g -a claude-code pi -y
npx skills update -g
```

仓库安装器不安装或更新 Skills。修改后，Pi 执行 `/reload`；Claude Code 重启后通过 `/skills` 查看。插件自带技能由插件管理。

### Pi

#### 搜索与任务操作

直接用自然语言提出需求，Agent 会按需调用工具。

| 插件 | 用途 |
| --- | --- |
| `rpiv-ask-user-question` | 在关键决策处提供结构化选项 |
| `pi-subagent` | 启动可观察、可继续对话的独立子代理，用于审查、排查和委派实现 |
| `pi-fff` | 按文件名和内容搜索；默认接管 `find`、`grep`，不扫描整个 HOME |
| `pi-web-access` | 网页搜索与内容读取 |
| `pi-kimi-cu` | 操作 macOS 应用 |
| `pi-kimi-webbridge-bootstrap` | 操作已登录的真实浏览器；需安装并连接浏览器扩展 |
| `pi-subscription-image` | 使用 Codex／Grok 订阅生成图片；参考图编辑使用 Codex |

Antigravity 也提供 Google 搜索与图片生成；需要这条通道时直接指定。涉及账号、浏览器或系统权限的功能，需自行完成授权。

搜索配置：
- [文件搜索](harnesses/pi/plugin-configs/pi-fff/config.json) → `~/.pi/agent/pi-fff.json`
- [网页搜索](harnesses/pi/plugin-configs/web-search/config.json) → `~/.pi/agent/web-search.json`

#### 子代理

[pi-subagent](https://github.com/badlogic/pi-subagent) 通过 `git:github.com/badlogic/pi-subagent` 引入，不固定版本、标签或提交；首次安装使用上游默认分支，后续通过 `pi update --extensions` 更新。

需要 `tmux`，并按上游说明将 `subagent` CLI 加入 `PATH`。Git 包安装后的 CLI 入口为 `~/.pi/agent/git/github.com/badlogic/pi-subagent/subagent.ts`；仓库安装器只部署包声明，不安装 tmux 或配置 CLI 链接。不要同时启用手工克隆的 `~/.pi/agent/extensions/subagent` 和 Git 包，以免重复加载。

直接用自然语言要求委派任务；子代理默认继承父会话的模型与思考档位。`/subagent` 可选择并进入子代理会话，CLI 支持 `subagent list`、`subagent send`、`subagent wait` 和 `subagent stop`。子代理会独立调用模型，可能消耗额外额度。

#### 会话界面

[session-ui](harnesses/pi/builtins/session-ui/README.md) 显示工具活动、工作动画、图片预览、用量和本轮耗时，并按需生成动作标题与会话名称。

| 操作 | 命令 |
| --- | --- |
| 选择思考档位 | `/effort` |
| 查看思考档位 | `/effort status` |
| 切换自定义／原生状态栏 | `/statusline` |
| 开关工作动画 | `/work-animation on`、`/work-animation off` |
| 查看动画设置 | `/work-animation status` |
| 手动命名会话 | `/name` |

动画开关会记住上次选择，保存在 `~/.pi/agent/state/session-ui.json`；`/statusline` 只临时切换。界面配置位于 `~/.pi/agent/extensions/session-ui/config.json`。

`pi-last-model-effort` 自动记住模型与思考档位；`pi-subscription-usage` 为状态栏提供订阅额度。自动标题不额外调用模型，自动命名不会覆盖已有名称。

#### 模型与 Fast

通过 `/login` 登录 provider，`/model` 选择模型。GPT 使用 `openai-codex`；Antigravity 模型由 `pi-antigravity` 提供，可用 `/antigravity.refresh` 刷新目录。

仓库模型轮换顺序为 GPT-6 Astra → GPT-6.1 Sol → Grok 4.7 → Antigravity 模型。具体范围见 [settings.json](harnesses/pi/config/settings.json)，列入清单不代表账号已获授权。

[Fast](harnesses/pi/builtins/fast/README.md) 通过 `/fast` 切换，`/fast status` 查询，`/fast off` 关闭。开关按 provider 保存在 `~/.pi/agent/state/fast.json`；`fast` 标记表示本地已启用，不保证后端实际加速。

[models.json](harnesses/pi/config/models.json) 将两个 Codex GPT 模型的本地上下文预算设为 500K tokens，不改变输出上限，也不保证后端支持同等窗口。安装器整体替换该文件；如有自定义模型，请先整合。

#### Codemode 与 MCP

仓库默认开启 Pi 内置 Codemode，可批量调用工具、过滤或汇总结果，普通工具仍可直接使用。例如：“并行检查 Git 状态和最近提交，汇总结果。”

MCP 服务器由 Pi 内置支持连接，配置放在 `~/.pi/agent/mcp.json` 或项目的 `.pi/mcp.json`，不由仓库安装器托管。

- `/mcp`：查看连接、登录、重连和启停服务器。
- `pi mcp list`：从终端检查连接。
- `pi mcp login <server>`：完成 OAuth 登录。
- 修改配置后执行 `/reload`。

Codemode 不限制被调用工具的实际权限；不要并行修改同一文件。仓库不提供自动审批功能。

#### 基础配置与快捷键

- [基础设置](harnesses/pi/config/settings.json) → `~/.pi/agent/settings.json`
- [快捷键](harnesses/pi/config/keybindings.json) → `~/.pi/agent/keybindings.json`
- [模型覆盖](harnesses/pi/config/models.json) → `~/.pi/agent/models.json`

`Ctrl+L` 打开模型选择器；全屏模式下 `Alt+K`／`Alt+J` 翻整页，`Alt+,`／`Alt+.` 滚动到顶部／底部。手动修改配置后执行 `/reload`。

### Claude Code

#### 语言服务与状态栏

启用 `gopls-lsp` 和 `swift-lsp`，用于 Go、Swift 项目的代码导航与诊断，需准备对应语言服务。

自定义状态栏展示模型、思考档位、目录、分支、上下文、订阅额度和缓存命中率；数据随 Claude Code 提供的字段显示。需安装 `jq`。

默认使用全屏 TUI、自动明暗主题，关闭反馈草稿。通过 `/tui` 查看模式，`/tui default` 或 `/tui fullscreen` 切换。

#### 快捷键与配置

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+L` | 打开模型选择器 |
| `Alt+K`／`Alt+J` | 向上／向下翻整页 |
| `Alt+U`／`Alt+D` | 向上／向下翻半页 |
| `Alt+,`／`Alt+.` | 滚动到顶部／底部 |

- [基础设置](harnesses/claude-code/settings.json) → `~/.claude/settings.json`
- [快捷键](harnesses/claude-code/keybindings.json) → `~/.claude/keybindings.json`
- 状态栏脚本：`~/.claude/statusline-command.sh`

## 更新与恢复

- **更新仓库配置**：拉取仓库后，重新运行对应安装命令。直接修改安装目录中的托管配置可能被覆盖。
- **更新 Pi 与插件**：`pi update` 更新 Pi，`pi update --extensions` 更新外部插件；更新后重启。
- **恢复配置**：从安装输出所示的 `~/.agent-config-backups/` 备份目录复制原文件，再重启工具。
- **查看安装选项**：`./install-harness.sh --list`。
