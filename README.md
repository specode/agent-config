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

每次只处理选中的一组配置。`install-harness.sh` 只汇总需要新增或更新的插件与配置，不输出逐文件 diff；有本机内容冲突时再询问是否覆盖。确认覆盖后会先把整组原配置备份到 `~/.agent-config-backups/<时间>/<组名>/`，托管文件部署失败会自动回滚。安装 Pi 配置时还会清理旧的本地 `~/.pi/agent/extensions/image-gen.ts`，原文件移入同一备份根目录下的 `pi-retired/`，改由 `npm:@specode/pi-subscription-image` 提供生图能力。同时会把旧的 `~/.pi/web-search.json` 迁到备份，Web Search 改装到 `~/.pi/agent/web-search.json`，以匹配 pi-web-access 0.29 的默认配置路径。`install-rules.sh` 仍会在规则冲突时显示具体差异。

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
- `harnesses/pi/`：Pi 的 settings、快捷键、extensions、`agent/sol-pi.json`、`agent/pi-fff.json`、`agent/web-search.json` 与 pi-lens 配置；这些路径作为同一个 Pi 配置组处理。Web Search 安装到 `~/.pi/agent/web-search.json`。
- `install-rules.sh`：只安装 rules。
- `install-harness.sh`：只安装指定 harness 的配置。

### Pi SoL-Pi

`harnesses/pi/agent/settings.json` 通过 `git:github.com/NVlabs/SoL-Pi` 启用独立 Pi package，`./install-harness.sh pi` 将 `harnesses/pi/agent/sol-pi.json` 安装到 `~/.pi/agent/sol-pi.json`，与其他 Pi 配置一起参与冲突确认、备份和回滚。

当前配置同步自本机，仅开启 Action Fusion（`edit` / `write` 可附带后续验证命令）和 ObservationPack（大型工具结果归档，并通过 `obs_recall` 分页取回）；Evidence-Preserving Reducer 与 Online Context Compact 保持关闭，`cacheWriteReadRatio` 保留 `12.5`。不会启用额外的日志归约模型调用或 SoL-Pi 自动上下文压缩。

受信任项目的 `.pi/sol-pi.json` 会整体覆盖用户级配置，两者不合并。ObservationPack 的归档位于 Pi 会话目录，不进入本仓库；以后若启用 Evidence-Preserving Reducer，应先确认允许将诊断日志发送给所选模型，凭据仍由 Pi 管理。详细说明见 [SoL-Pi 配置文档](https://github.com/NVlabs/SoL-Pi/blob/main/docs/configuration.md)。

### Pi FFF 搜索配置

仓库通过 `npm:@ff-labs/pi-fff` 启用 FFF 扩展，并将 `harnesses/pi/agent/pi-fff.json` 部署到 `~/.pi/agent/pi-fff.json`，与其他 Pi 配置一起参与冲突确认、备份和回滚。配置使用 `mode: "override"`，以 FFF 替换内置 `find`、`grep` 并接管 `@` 文件补全；设置 `enableHomeDirScanning: false`，避免从主目录启动时自动索引整个主目录。该文件仅包含可复用的用户偏好，不收录 FFF 的索引、访问频率或查询历史数据库。

### Pi last-model-effort

`harnesses/pi/agent/settings.json` 通过 `npm:@specode/pi-last-model-effort` 启用独立 Pi package。它会按模型记住最近实际使用的 thinking / reasoning effort，切换回来时自动恢复，并在新建会话时恢复最近模型；`pi -c`、`/resume`、fork 和显式 CLI 参数仍保留原有优先级。运行状态写入 `~/.pi/agent/state/last-model-effort.json`，不进入配置仓库，也不改写 Pi 的 `modelThinkingLevels`。详细行为见 [npm 包说明](https://www.npmjs.com/package/@specode/pi-last-model-effort)。

### Pi 多模型 Profile

`harnesses/pi/agent/profiles/pi-subagents/multimodel-ggk.json` 按 `pi-subagents` 当前支持的最小覆盖方式配置：每个角色只指定一个完整 `provider/id`，将 `thinking` 独立声明，保留内置角色的提示词、工具和上下文继承策略。具体模型与档位是本地选择，不是插件强制标准。

| 角色 | 模型 | thinking |
| --- | --- | --- |
| scout（侦察） | Kimi K3 | high |
| delegate（通用委派） | GPT-6 Astra | xhigh |
| researcher（研究） | Grok 4.6 | high |
| worker（实现） | GPT-6 Astra | medium |
| reviewer（评审） | Grok 4.6 | high |
| oracle（方案顾问） | GPT-6 Astra | max |

reviewer 默认使用 `fresh` 上下文，reviewer 和 oracle 声明 `acceptanceRole: "read-only"`；不覆盖其内置工具和提示词。`defaultContext` 是默认偏好，不是不可覆盖的隔离策略，独立评审委派时仍应显式使用 `context: "fresh"`。保留 worker 和 oracle 的内置 `fork` 默认值，不为所有任务强制一种上下文模式。

`pi-subagents` 0.68.0 已移除 `fallbackModels`，配置中不再声明自动备用模型；调用失败时应先排查原因，必要时再显式选择模型重试，不自动切换外部 CLI。

`./install-harness.sh pi` 只把 Profile 复制到 `~/.pi/agent/profiles/pi-subagents/`，不会自动改写角色映射。安装或更新后运行 `/subagents-load-profile multimodel-ggk` 启用，再用 `/subagents-models` 核对实际路由。加载会替换整套 `agentOverrides`，但保留未被 Profile 覆盖的其他子代理设置及既有机器绑定；如提示是否切换当前会话模型，可选择不切换。需要验证提供商访问时，可手动运行 `/subagents-check-profile multimodel-ggk`（会发起真实模型探测）。

### Pi 子代理策略

多模型 Profile 禁用 `claude-code`、`codex-exec`、`cursor-agent` 及其 writer 变体，避免只使用 Pi 模型时误调本机外部 CLI；禁用项会在手动执行 `/subagents-load-profile multimodel-ggk` 时与模型角色映射一起写入用户 settings。`harnesses/pi/agent/extensions/subagent/config.json` 仅统一任务超时为两小时。

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

### Pi OpenAI Fast

`harnesses/pi/agent/extensions/openai-fast/index.ts` 是自维护的本地扩展，由安装器复制整个目录；不再依赖 `npm:@diegopetrucci/pi-openai-fast`。它为 Codex OAuth 请求提供 `/fast [on|off|status]`，开启时按需添加 `service_tier: "priority"`，不限制 GPT 模型版本、不覆盖已有 tier，也不自动重试或修改费用。沿用 `extensions/openai-fast.json`，仓库保留默认开启；会话命令覆盖不持久化，reload、新建或恢复会话时回到配置默认值。状态栏仅在开启且当前通道适配时显示 `fast`，关闭或不适配时隐藏；请求处理细节通过 `/fast status` 查询，开关标记不代表后端确认加速。独立安装、配置与测试见 [OpenAI Fast 文档](harnesses/pi/agent/extensions/openai-fast/README.md)。本扩展按可公开使用的独立插件维护，个人状态栏的定制归 session-ui。

安装器在新配置部署成功后，检测并通过 `pi remove npm:@diegopetrucci/pi-openai-fast` 卸载旧包；只操作安装目标下的 Pi agent 目录，卸载前将旧包及 npm 清单备份到 `pi-retired/openai-fast-package/`，并禁用 npm 生命周期脚本。拒绝安装时不卸载，旧包已不存在时不重复调用。仅残留旧包而配置已一致时也会清理。卸载需要可执行的 `pi`，并复核旧包目录及 npm 依赖声明均已移除；Pi 可能因设置项已随配置迁移而返回非零，此时只有复核通过才视为完成。仍有残留则报错并保留新配置和备份，不冒充 npm 操作已回滚，修复后可重跑安装器。

### Pi subscription-usage

`harnesses/pi/agent/settings.json` 通过 `npm:@specode/pi-subscription-usage` 启用独立 Pi package。它通过 `/usage` 以统一的 5H/一周/月窗口样式查看当前 Codex、OpenCode Go、Grok 或 Kimi Coding 订阅额度；重新输入命令即强制刷新。只有 Codex 查询到可用重置次数时才展示重置菜单并要求二次确认；插件不实现 Fast 模式，也不读取 Grok CLI 本地凭据。详细行为和安全边界见 [npm 包说明](https://www.npmjs.com/package/@specode/pi-subscription-usage)。

### Pi subscription-image

`harnesses/pi/agent/settings.json` 通过 `npm:@specode/pi-subscription-image` 启用独立 Pi package。它提供统一的 `generate_image` 工具和 `/img` 命令，使用现有 Codex 与 Grok 订阅账户额度生成或编辑图片；`openai-codex/*` 会话自动走 Codex，`xai/*` 会话自动走 Grok，其他会话需显式指定 provider。默认保存到 `~/.pi/agent/generated-images/`，可选磁盘保存失败时仍返回内联图片。插件不自行保存凭据。运行 `./install-harness.sh pi` 时，如本机仍存在旧的 `~/.pi/agent/extensions/image-gen.ts`，安装器会将它移出并备份到 `~/.agent-config-backups/<时间>/pi-retired/`。详细行为和安全边界见 [npm 包说明](https://www.npmjs.com/package/@specode/pi-subscription-image)。

### 未启用的 Pi 配置

以下文件仍保留在仓库中，但不在 `install-harness.sh pi` 的安装清单内，对当前 Pi 配置不生效：

- `harnesses/pi/agent/automode.json`
- `harnesses/pi/agent/extensions/pi-permission-system/config.json`
- `harnesses/pi/agent/extensions/pi-auto-review/config.json`

`harnesses/pi/agent/settings.json` 也不再启用 `npm:@ogulcancelik/pi-codex-compaction`。这些内容属于历史或候选配置；若不再计划恢复，可后续删除，而不是把它们视为当前安装的一部分。

仓库不收录 API Key、Token、私钥、登录态、sessions、cache、运行时包目录或项目级规则。

## 4. 安装器验证

```bash
node --test tests/*.test.mjs
```

测试使用临时安装目录和模拟 `pi` 命令，覆盖 SoL-Pi 与 FFF 配置部署与冲突备份、多模型 Profile 约束及仅复制不激活、旧包清理、重复安装、取消安装、目标目录隔离及卸载失败重试，不卸载本机真实包。
