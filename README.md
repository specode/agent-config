# Agent Config

个人 AI 编程工具配置，统一协作规则，并为 Pi、Claude Code 补齐代码导航、任务协作和界面能力。

- **通用规则**：约定 Agent 如何理解需求、修改代码和验证结果。
- **Pi**：补充结构化提问、搜索、浏览器操作和会话界面。
- **Claude Code**：补充语言服务、快捷键和状态栏。

本仓库只安装配置与扩展，不安装工具本体，不提供账号或凭据。

## 快速开始

先安装并登录所需工具，再执行：

```bash
./install-rules.sh                 # 共用规则
./install-harness.sh pi            # 按需安装
./install-harness.sh claude-code   # 按需安装
```

依赖：Pi 配置安装需要 `rsync`、Node 和 `pi` 命令；Claude Code 状态栏需要 `jq`。

有冲突时，安装器会询问是否备份并覆盖，已退役插件的托管文件也会一起清理并备份。更新 Pi 配置前请先退出正在运行的 Pi，避免旧插件继续写入缓存；安装后重新启动。

**安装前注意：**

- 配置不会与现有设置逐项合并。
- Pi 的 Fast 默认关闭，支持 OpenAI／Codex 订阅与 Grok 4.7；开启可能增加额度消耗。
- Claude Code 默认使用 `auto` 权限模式。

## 使用说明

### 通用规则

让不同工具遵循同一套协作习惯：简体中文、澄清关键歧义、模块化设计、修改后验证。

修改 [`rules/AGENTS.md`](rules/AGENTS.md) 后，运行 `./install-rules.sh`。规则会同时安装到 Agent、Claude Code、Codex、Pi 和 Grok 的用户目录，不修改项目级规则。

**通用 Skills**

Claude Code 与 Pi 的通用技能使用 `npx skills` 统一管理：源文件保存在 `~/.agents/skills/`，两个 harness 的个人 skills 目录链接到同一份内容。当前共用 Remotion、UI/UX Pro Max、TypeSafe AI 和八个 GSAP 技能；插件自带技能和 Claude 的账号同步技能仍由各自来源管理。仓库安装器不安装或更新这些技能。

```bash
npx skills list -g -a claude-code pi              # 查看共用技能及关联
npx skills add <来源> -g -a claude-code pi -y      # 同时安装到两个 harness
npx skills update -g                             # 按记录的来源更新全局技能
```

Pi 修改后执行 `/reload`；Claude Code 重启后核对 `/skills`。统一技能清单不意味着插件专属工具也能跨 harness 使用。

### Pi

#### 解决什么问题

- **任务协作**：让 Agent 在关键决策处通过结构化选项提问。
- **信息获取**：搜索代码与网页，操作真实浏览器或桌面。
- **会话体验**：看清执行状态、模型档位和用量，减少重复设置。

#### 使用哪些插件

**任务协作与信息获取**

这些能力可直接用自然语言提出需求，由 Agent 调用相应工具。

| 插件 | 用途 | 使用示例／入口 |
| --- | --- | --- |
| `rpiv-ask-user-question` | 结构化提问 | 需要选择方案时，在选项界面作答 |
| `pi-lens` | 代码分析与导航 | “查找这个函数的定义和调用方” |
| `pi-fff` | 文件与内容搜索 | “找到登录相关文件” |
| `pi-web-access` | 网页搜索与读取 | “查一下官方文档中的用法” |
| `pi-kimi-cu` | macOS 桌面操作 | 指定应用和需要执行的操作 |
| `pi-kimi-webbridge-bootstrap` | 真实浏览器操作 | 指定网页和任务；需配置浏览器扩展 |
| `pi-subscription-image` | 图片生成与编辑 | 描述要生成或修改的图片 |

**会话体验与模型接入**

| 插件 | 用途 | 怎么用 |
| --- | --- | --- |
| [session-ui](harnesses/pi/builtins/session-ui/README.md) | 工具活动、图片预览、状态栏与自动标题 | 自动生效；`/effort` 选思考档位，`/statusline` 切换状态栏 |
| [Fast](harnesses/pi/builtins/fast/README.md) | OpenAI／Codex 订阅尝试 priority；Grok 4.7 走 Build 代理 fast 通道 | `/fast` 切换开关，只回一行 `Fast: on` / `Fast: off` |
| `pi-last-model-effort` | 记住模型与思考档位 | 自动生效 |
| `pi-subscription-usage` | 查看订阅额度 | 在 session-ui 状态栏查看 |
| `pi-antigravity` | 接入 Antigravity 模型 | 完成 provider 登录后选择模型 |

涉及账号、浏览器或系统权限的插件，需自行完成授权和依赖配置。

仓库默认不提供自动审批能力。

#### 常用配置

界面默认使用跟随终端配色的 `system` 主题和全屏 TUI，终端切换明暗时自动适配，隐藏 thinking 正文；外部编辑器为 `nvim`。

**基础设置**

- [模型与插件清单](harnesses/pi/config/settings.json) → `~/.pi/agent/settings.json`
- [快捷键](harnesses/pi/config/keybindings.json) → `~/.pi/agent/keybindings.json`

模型列入清单不代表账号已获授权，仍需登录对应 provider。GPT 模型使用 `openai-codex` provider；通过 `/login openai-codex` 登录 ChatGPT 订阅。

**Codemode（Pi 内置）**

仓库默认通过 `defaultTools: ["+codemode"]` 开启 Codemode，保留其他默认工具；无需 MCP 服务。重启 Pi 后，直接用自然语言要求 Agent 用 Codemode 批量调用工具、过滤或合并结果，例如“用 Codemode 并行查询 Git 状态和最近提交，只读操作，汇总结果”。

配置位于 `~/.pi/agent/settings.json`；移除 `defaultTools` 中的 `+codemode` 可取消这项显式启用，但 MCP 服务仍可能自动启用它。保持默认 `on` 模式，普通工具仍可直接调用。脚本沙箱不限制被调用工具的实际权限，优先用于只读任务，避免并行修改同一文件。

**MCP 服务（Pi 内置）**

使用 Pi 0.99.1 的内置 MCP 支持，无需 `pi-mcp-adapter`。服务器配置放在 `~/.pi/agent/mcp.json`（个人）或 `.pi/mcp.json`（项目），不由本仓库安装器托管。

- `/mcp`：管理服务器、查看连接状态与登录。
- `pi mcp list`：从终端检查连接；`pi mcp login <server>`：完成 OAuth 授权。
- 修改配置后执行 `/reload` 或重新启动 Pi。
- 内置 MCP 暂无公开连接状态接口，session-ui 暂不显示 MCP 区块；连接状态请查看 `/mcp`。
- 安装器会备份并卸载旧 `pi-mcp-adapter` 包，保留个人 MCP 配置及凭据；旧 `mcp-adapter.json` 不会自动转为原生配置，升级前须将服务器迁入 `mcp.json`。

**界面与 Fast**

- session-ui：修改 `~/.pi/agent/extensions/session-ui/config.json`，详见[功能与配置说明](harnesses/pi/builtins/session-ui/README.md)。
- 关闭 Fast：在 Pi 里对该 provider 执行 `/fast off`，选择保存在 `~/.pi/agent/state/fast.json`。`~/.pi/agent/extensions/fast.json` 的 `enabled` 只是还没设过开关时的默认值。
- `fast` 标记只表示开关已启用并已装上，不代表后端已确认加速。

**搜索**

按需调整以下配置，无需为了日常使用逐项修改。

| 配置 | 安装后位置 |
| --- | --- |
| [网页搜索](harnesses/pi/plugin-configs/web-search/config.json) | `~/.pi/agent/web-search.json` |
| [代码分析](harnesses/pi/plugin-configs/pi-lens/config.json) | `~/.pi-lens/config.json` |
| [文件搜索](harnesses/pi/plugin-configs/pi-fff/config.json) | `~/.pi/agent/pi-fff.json` |

### Claude Code

#### 解决什么问题

让 Go、Swift 项目的代码导航更方便，并改善长对话中的滚动和状态查看。

#### 使用哪些插件

| 插件／组件 | 用途 | 怎么用 |
| --- | --- | --- |
| Go LSP（`gopls-lsp`） | Go 代码导航与诊断 | 准备语言服务依赖后，让 Agent 查定义、引用或错误 |
| Swift LSP（`swift-lsp`） | Swift 代码导航与诊断 | 准备语言服务依赖后，在 Swift 项目中使用 |
| 自定义状态栏 | 查看当前会话状态 | 自动显示；需要 `jq` |

#### 常用操作与配置

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+L` | 打开模型选择器（与 Pi 一致，默认的 `Alt+P` 已解绑） |
| `Alt+K` / `Alt+J` | 向上／向下滚动整页（与 Pi 一致） |
| `Alt+U` / `Alt+D` | 向上／向下滚动半页 |
| `Alt+,` / `Alt+.` | 滚动到顶部／底部 |

默认使用全屏 TUI、自动明暗主题、`high` 思考档位和自动上下文压缩。用 `/tui` 查看当前渲染模式，`/tui default` 可切回经典模式，`/tui fullscreen` 恢复全屏。

- [基础设置](harnesses/claude-code/settings.json) → `~/.claude/settings.json`
- [快捷键](harnesses/claude-code/keybindings.json) → `~/.claude/keybindings.json`
- 状态栏未显示：检查 `jq` 和 `~/.claude/statusline-command.sh`。

## 更新与恢复

- **更新**：拉取仓库后，重新运行对应安装命令。直接修改安装目录的内容可能被覆盖。
- **恢复**：从 `~/.agent-config-backups/` 的对应备份复制原文件，再重启工具。具体备份目录见安装输出。
- **查看支持的工具**：`./install-harness.sh --list`。
