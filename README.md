# Agent Config

个人 AI 编程工具配置，统一协作规则，并为 Pi、Claude Code 补齐代码导航、任务协作和界面能力。

- **通用规则**：约定 Agent 如何理解需求、修改代码和验证结果。
- **Pi**：补充子代理、搜索、浏览器操作和会话界面。
- **Claude Code**：补充语言服务、Codex 插件、快捷键和状态栏。

本仓库只安装配置与扩展，不安装工具本体，不提供账号或凭据。

## 快速开始

先安装并登录所需工具，再执行：

```bash
./install-rules.sh                 # 共用规则
./install-harness.sh pi            # 按需安装
./install-harness.sh claude-code   # 按需安装
```

依赖：Pi 配置安装需要 `rsync`、Node 和 `pi` 命令；Claude Code 状态栏需要 `jq`。

有冲突时，安装器会询问是否备份并覆盖。安装后重启工具；Pi 也可执行 `/reload`。

**安装前注意：**

- 配置不会与现有设置逐项合并。
- Pi 默认开启 OpenAI Fast，可能增加额度消耗。
- Claude Code 默认使用 `auto` 权限模式。

## 使用说明

### 通用规则

让不同工具遵循同一套协作习惯：简体中文、澄清关键歧义、模块化设计、合理委派、修改后验证。

修改 [`rules/AGENTS.md`](rules/AGENTS.md) 后，运行 `./install-rules.sh`。规则会同时安装到 Agent、Claude Code、Codex、Pi 和 Grok 的用户目录，不修改项目级规则。

### Pi

#### 解决什么问题

- **任务协作**：拆分独立任务，让 Agent 在关键决策处提问。
- **信息获取**：搜索代码与网页，操作真实浏览器或桌面。
- **会话体验**：看清执行状态、模型档位和用量，减少重复设置。

#### 使用哪些插件

**任务协作与信息获取**

这些能力可直接用自然语言提出需求，由 Agent 调用相应工具。

| 插件 | 用途 | 使用示例／入口 |
| --- | --- | --- |
| `pi-subagents` | 子代理分工 | “并行分析这两个模块，再汇总结论” |
| `rpiv-ask-user-question` | 结构化提问 | 需要选择方案时，在选项界面作答 |
| `pi-lens` | 代码分析与导航 | “查找这个函数的定义和调用方” |
| `pi-fff` | 文件与内容搜索 | “找到登录相关文件” |
| `pi-web-access` | 网页搜索与读取 | “查一下官方文档中的用法” |
| `pi-mcp-adapter` | 接入 MCP 服务 | 提供 MCP 地址，安装并完成所需授权 |
| `pi-kimi-cu` | macOS 桌面操作 | 指定应用和需要执行的操作 |
| `pi-kimi-webbridge-bootstrap` | 真实浏览器操作 | 指定网页和任务；需配置浏览器扩展 |
| `pi-subscription-image` | 图片生成与编辑 | 描述要生成或修改的图片 |

**会话体验与模型接入**

| 插件 | 用途 | 怎么用 |
| --- | --- | --- |
| [session-ui](harnesses/pi/builtins/session-ui/README.md) | 工具活动、图片预览、状态栏与自动标题 | 自动生效；`/effort` 选思考档位，`/statusline` 切换状态栏 |
| [OpenAI Fast](harnesses/pi/builtins/openai-fast/README.md) | 为 Codex 订阅请求尝试 priority 档位 | `/fast status` 查看，`/fast off` 临时关闭 |
| `pi-last-model-effort` | 记住模型与思考档位 | 自动生效 |
| `pi-subscription-usage` | 查看订阅额度 | 在 session-ui 状态栏查看 |
| SoL-Pi | 优化工具输出与上下文 | 随工具调用工作 |
| `pi-antigravity` | 接入 Antigravity 模型 | 完成 provider 登录后选择模型 |

涉及账号、浏览器或系统权限的插件，需自行完成授权和依赖配置。

仓库默认不提供自动审批能力。

#### 常用配置

界面默认使用明暗自适应主题和全屏 TUI，隐藏 thinking 正文；外部编辑器为 `nvim`。

**基础设置**

- [模型与插件清单](harnesses/pi/config/settings.json) → `~/.pi/agent/settings.json`
- [快捷键](harnesses/pi/config/keybindings.json) → `~/.pi/agent/keybindings.json`

模型列入清单不代表账号已获授权，仍需登录对应 provider。

**界面与 Fast**

- session-ui：修改 `~/.pi/agent/extensions/session-ui/config.json`，详见[功能与配置说明](harnesses/pi/builtins/session-ui/README.md)。
- 永久关闭 Fast：将 `~/.pi/agent/extensions/openai-fast.json` 的 `enabled` 改为 `false`，再执行 `/reload`。
- `fast` 标记只表示开关已启用，不代表后端已确认加速。

**子代理与搜索**

按需调整以下配置，无需为了日常使用逐项修改。

| 配置 | 安装后位置 |
| --- | --- |
| [子代理策略](harnesses/pi/plugin-configs/pi-subagents/config.json) | `~/.pi/agent/extensions/subagent/config.json` |
| [网页搜索](harnesses/pi/plugin-configs/web-search/config.json) | `~/.pi/agent/web-search.json` |
| [代码分析](harnesses/pi/plugin-configs/pi-lens/config.json) | `~/.pi-lens/config.json` |
| [文件搜索](harnesses/pi/plugin-configs/pi-fff/config.json) | `~/.pi/agent/pi-fff.json` |
| [上下文优化](harnesses/pi/plugin-configs/sol-pi/config.json) | `~/.pi/agent/sol-pi.json` |

额外提供[多模型子代理 Profile](harnesses/pi/plugin-configs/pi-subagents/profiles/multimodel-ggk.json)，默认不激活。
安装位置为 `~/.pi/agent/profiles/pi-subagents/multimodel-ggk.json`。先登录相关 provider，再通过 pi-subagents 选择该 Profile。

### Claude Code

#### 解决什么问题

让 Go、Swift 项目的代码导航更方便，并改善长对话中的滚动和状态查看。

#### 使用哪些插件

| 插件／组件 | 用途 | 怎么用 |
| --- | --- | --- |
| Go LSP（`gopls-lsp`） | Go 代码导航与诊断 | 准备语言服务依赖后，让 Agent 查定义、引用或错误 |
| Swift LSP（`swift-lsp`） | Swift 代码导航与诊断 | 准备语言服务依赖后，在 Swift 项目中使用 |
| Codex（`codex@openai-codex`） | 接入 Codex 能力 | 完成插件授权后，按插件提供的入口使用 |
| 自定义状态栏 | 查看当前会话状态 | 自动显示；需要 `jq` |

#### 常用操作与配置

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+L` | 打开模型选择器（与 Pi 一致，默认的 `Alt+P` 已解绑） |
| `Alt+K` / `Alt+J` | 向上／向下滚动一行 |
| `Alt+U` / `Alt+D` | 向上／向下滚动半页 |
| `Alt+,` / `Alt+.` | 滚动到顶部／底部 |

默认使用自动明暗主题、`high` 思考档位和自动上下文压缩。

- [基础设置](harnesses/claude-code/settings.json) → `~/.claude/settings.json`
- [快捷键](harnesses/claude-code/keybindings.json) → `~/.claude/keybindings.json`
- 状态栏未显示：检查 `jq` 和 `~/.claude/statusline-command.sh`。

## 更新与恢复

- **更新**：拉取仓库后，重新运行对应安装命令。直接修改安装目录的内容可能被覆盖。
- **恢复**：从 `~/.agent-config-backups/` 的对应备份复制原文件，再重启工具。具体备份目录见安装输出。
- **查看支持的工具**：`./install-harness.sh --list`。
