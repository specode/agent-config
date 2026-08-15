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

> ⚠️ **Pi 安装后的必做配置：** 自动审核模式（`pi-auto-review`）需要调用模型。安装完成后，请编辑 `~/.pi/agent/extensions/pi-auto-review/config.json`，把 `model` 改成你自己常用且当前 Pi 环境可用的模型 ID（格式通常为 `provider/model`）。仓库中的值只是示例，不保证其他用户可用；模型未配置正确时，自动审核将无法正常工作。
>
> 该模式会额外请求配置的模型，并以模型响应作为自动审核的判断依据，因此会产生额外的 Token 消耗；实际用量取决于触发审核的频率和上下文长度。

可用名称可随时查看：

```bash
./install-harness.sh --list
```

每次只处理选中的一组配置。目标不存在时自动安装；内容不同时先显示差异并询问；确认覆盖后会先把整组原配置备份到 `~/.agent-config-backups/<时间>/<组名>/`。安装中途失败会自动回滚。

## 2. 前置依赖

- macOS 或具备 Bash 与常用 Unix 命令的环境。
- 需要先自行安装要使用的 harness；本仓库不安装或升级 Claude Code、Pi 等程序。
- Claude Code 的状态栏脚本依赖 `jq`，macOS 可运行 `brew install jq`。
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

仓库不收录 API Key、Token、私钥、登录态、sessions、cache、运行时包目录或项目级规则。
