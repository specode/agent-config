# Agent Config

个人 harness 配置仓库，只管理两类内容：跨 harness 共用的 rules，以及按 harness 独立组织的用户配置。安装器复制真实文件，不管理 harness 本体、登录态、凭据、会话或缓存。

## 1. 快速开始

进入仓库目录后，先安装共用规则：

```bash
./install-rules.sh
```

再按需安装某一个 harness 的配置：

```bash
./install-harness.sh claude-code
./install-harness.sh pi
```

可用名称可随时查看：

```bash
./install-harness.sh --list
```

每次只处理选中的一组配置。目标不存在时自动安装；内容不同时先显示差异并询问；确认覆盖后会先把整组原配置备份到 `~/.agent-config-backups/<时间>/<组名>/`。安装中途失败会自动回滚。

## 2. 前置依赖

- macOS 或具备 Bash 与常用 Unix 命令的环境。
- 需要先自行安装要使用的 harness；本仓库不安装或升级 Claude Code、Pi 等程序。
- Claude Code 的状态栏脚本依赖 `jq`，macOS 可运行 `brew install jq`。
- Pi 安装包含目录级配置，需要 `rsync`；macOS 默认已提供，其他系统需自行安装。
- Pi 配置引用的 packages 仍需对应运行环境、账号权限和网络条件。

## 3. 配置概括说明

```text
.
├── rules/
│   └── AGENTS.md
├── harnesses/
│   ├── claude-code/
│   └── pi/
├── install-rules.sh
├── install-harness.sh
└── lib/install-managed.sh
```

- `rules/`：唯一的全局规则源。安装到 `~/.agents/AGENTS.md`、Claude Code、Codex、Pi 和 Grok 的全局规则路径；五个目标始终整组处理。
- `harnesses/claude-code/`：Claude Code 的 settings、快捷键和状态栏脚本。
- `harnesses/pi/`：Pi 的 settings、快捷键、extensions、web search 与 pi-lens 配置；这些路径作为同一个 Pi 配置组处理。
- `install-rules.sh`：只安装 rules。
- `install-harness.sh`：只安装指定 harness 的配置。

### Pi session-ui

`harnesses/pi/agent/extensions/session-ui.ts` 是唯一入口，负责按配置装配
`harnesses/pi/agent/extensions/session-ui/` 下的模块；入口和整个模块目录会作为同一个 Pi 配置组安装。完整配置说明见 [Pi session-ui 文档](harnesses/pi/agent/extensions/session-ui/README.md)。

当前模块包括：

- compact paste：图片显示为 `[Image N]`，长文本显示为 `[Paste N · size]`，提交时仍由 Pi 原生粘贴注册表展开。
- tool activity：临时 widget 投影工具进度，不替换工具执行或正式 transcript renderer。
- statusline：可配置 segment 顺序、溢出策略和扩展状态过滤；`/statusline` 可切回 Pi 默认 footer。
- effort：`/effort` 只提供当前模型实际支持的 thinking 档位。
- turn duration：把耗时作为自定义 transcript entry 写入，但只在交互式 TUI 会话启用。

当前 session-ui **不提供**终端标题生成、自动 session 命名或 `/unname`。工具活动会在 `turn_end` 后清空，持久结果以 Pi 原生 transcript 为准。

### 未启用的 Pi 配置

以下文件仍保留在仓库中，但不在 `install-harness.sh pi` 的安装清单内，对当前 Pi 配置不生效：

- `harnesses/pi/agent/automode.json`
- `harnesses/pi/agent/extensions/pi-permission-system/config.json`
- `harnesses/pi/agent/extensions/pi-auto-review/config.json`

`harnesses/pi/agent/settings.json` 也不再启用 `npm:@ogulcancelik/pi-codex-compaction`。这些内容属于历史或候选配置；若不再计划恢复，可后续删除，而不是把它们视为当前安装的一部分。

仓库不收录 API Key、Token、私钥、登录态、sessions、cache、运行时包目录或项目级规则。
