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

每次只处理选中的一组配置。`install-harness.sh` 只汇总需要新增或更新的插件与配置，不输出逐文件 diff；有本机内容冲突时再询问是否覆盖。确认覆盖后会先把整组原配置备份到 `~/.agent-config-backups/<时间>/<组名>/`，安装中途失败会自动回滚。安装 Pi 配置时还会清理已停用的 `~/.pi/agent/extensions/image-gen.ts`，原文件移入同一备份根目录下的 `pi-retired/`。`install-rules.sh` 仍会在规则冲突时显示具体差异。

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

### Pi last-model-effort

`harnesses/pi/agent/settings.json` 通过 `npm:@specode/pi-last-model-effort` 启用独立 Pi package。它会按模型记住最近实际使用的 thinking / reasoning effort，切换回来时自动恢复，并在新建会话时恢复最近模型；`pi -c`、`/resume`、fork 和显式 CLI 参数仍保留原有优先级。运行状态写入 `~/.pi/agent/state/last-model-effort.json`，不进入配置仓库，也不改写 Pi 的 `modelThinkingLevels`。详细行为见 [npm 包说明](https://www.npmjs.com/package/@specode/pi-last-model-effort)。

### Pi session-ui

`harnesses/pi/agent/extensions/session-ui.ts` 是唯一入口，负责按配置装配
`harnesses/pi/agent/extensions/session-ui/` 下的模块；入口和整个模块目录会作为同一个 Pi 配置组安装。完整配置说明见 [Pi session-ui 文档](harnesses/pi/agent/extensions/session-ui/README.md)。

当前模块包括：

- compact paste：图片显示为 `[Image N]`，长文本显示为 `[Paste N · size]`；光标移入图片占位符时异步读取并缓存终端图片预览，Kitty 协议仅预览 PNG，提交时仍由 Pi 原生粘贴注册表展开。
- tool activity：临时 widget 投影工具进度，不替换工具执行或正式 transcript renderer。
- work animation：隐藏 Pi 原生工作行，在编辑器附近显示工作小人，并与 UI Meta 共用标题控制器；`/work-animation on|off|status` 可切换和查看状态。
- statusline：可配置 segment 顺序、溢出策略和扩展状态过滤；`/statusline` 可切回 Pi 默认 footer。
- effort：`/effort` 只提供当前模型实际支持的 thinking 档位。
- turn duration：把耗时作为自定义 transcript entry 写入，但只在交互式 TUI 会话启用。
- UI Meta：复用主模型正常响应中的隐藏 `turn_start` / `turn_end` 元数据更新终端标题、写入 Recap，并在高层目标切换时更新 session 名称；不发起额外模型请求。

UI Meta 仅在交互式 TUI 中启用，手工 `/name` 默认锁定 session 名称但不锁定每轮终端标题；当前仍不提供 `/unname`。工具活动会在 `turn_end` 后清空，持久结果以 Pi 原生 transcript 为准。

### 已停用的 Pi image-gen

仓库不再提供或安装独立的 `image-gen.ts` 扩展。运行 `./install-harness.sh pi` 时，如本机仍存在 `~/.pi/agent/extensions/image-gen.ts`，安装器会将它移出 Pi 扩展目录并备份到 `~/.agent-config-backups/<时间>/pi-retired/`。

### Pi subscription-usage

`harnesses/pi/agent/settings.json` 通过 `npm:@specode/pi-subscription-usage` 启用独立 Pi package。它通过 `/usage` 以统一的 5H/一周/月窗口样式查看当前 Codex、OpenCode Go、Grok 或 Kimi Coding 订阅额度；重新输入命令即强制刷新。只有 Codex 查询到可用重置次数时才展示重置菜单并要求二次确认；插件不实现 Fast 模式，也不读取 Grok CLI 本地凭据。详细行为和安全边界见 [npm 包说明](https://www.npmjs.com/package/@specode/pi-subscription-usage)。

### 未启用的 Pi 配置

以下文件仍保留在仓库中，但不在 `install-harness.sh pi` 的安装清单内，对当前 Pi 配置不生效：

- `harnesses/pi/agent/automode.json`
- `harnesses/pi/agent/extensions/pi-permission-system/config.json`
- `harnesses/pi/agent/extensions/pi-auto-review/config.json`

`harnesses/pi/agent/settings.json` 也不再启用 `npm:@ogulcancelik/pi-codex-compaction`。这些内容属于历史或候选配置；若不再计划恢复，可后续删除，而不是把它们视为当前安装的一部分。

仓库不收录 API Key、Token、私钥、登录态、sessions、cache、运行时包目录或项目级规则。
