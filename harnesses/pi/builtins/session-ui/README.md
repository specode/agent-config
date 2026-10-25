# Pi session-ui

为 Pi 交互式终端提供工具活动、工作动画、图片预览、状态栏、思考档位切换，以及自动标题和会话命名。

## 快速开始

使用 Pi 1.4.0，在仓库根目录安装：

```bash
./install-harness.sh pi
```

插件位于 `~/.pi/agent/extensions/session-ui/`。重新启动 Pi，或执行 `/reload`，然后用 `/work-animation status` 和 `/effort status` 查看设置。

## 使用说明

### 常用操作

| 功能 | 使用方式 |
| --- | --- |
| 工具活动 | 自动显示本轮最近的调用状态；Codemode 内部调用缩进显示 |
| 工作动画 | `/work-animation on`、`off` 开关，`status` 查询 |
| 图片预览 | 粘贴图片后，将光标移入图片标签 |
| 状态栏 | `/statusline` 临时切换自定义／原生状态栏 |
| 思考档位 | `/effort` 打开选择器，`/effort <level>` 设置，`/effort status` 查询 |
| 本轮耗时 | 本轮结束后自动显示，不发送给模型 |
| 标题与命名 | 按实质活动变化更新标题，为未命名会话补充名称 |

工具活动中的 `◆`／`◇`／`✗` 分别表示运行中、完成、失败；本轮结束后清空，正式结果保留在对话中。非 TUI 使用 `/effort` 时需显式传入档位。

### 动画开关与配置

`/work-animation on|off` 立即生效，并保存到 `~/.pi/agent/state/session-ui.json`。重新加载、新建会话、重启或更新插件后仍使用已保存的选择，不修改配置文件。

- 已保存的开关优先于 `workAnimation.enabled`；没有保存过时使用配置默认值。
- 状态文件损坏或无法读取时，会警告并使用配置默认值。
- 无法保存时，本次切换仍有效，但会提示只对当前会话生效。
- 设置 `PI_CODING_AGENT_DIR` 时，状态文件位于该目录下的 `state/session-ui.json`。

界面配置位于插件目录中的 `config.json`。也可在启动前指定：

```bash
PI_SESSION_UI_CONFIG=/absolute/path/to/session-ui.json pi
```

配置加载后生效，修改需 `/reload`。默认配置文件缺失或字段省略时使用默认值；显式指定的文件不存在、文件不可读、JSON 无效或配置段类型错误时，会在有界面的会话启动时提示回退。有效字段仍保留，无效部分使用默认值；每次加载仅提示一次。

例如，只显示模型、思考档位、目录和上下文：

```json
{
  "statusline": {
    "segments": ["model", "effort", "directory", "context"]
  }
}
```

### 功能设置

以下功能默认启用，可用各自的 `enabled: false` 关闭：`toolActivity`、`workAnimation`、`compactPaste`、`statusline`、`effort`、`turnDuration`、`uiMeta`。动画开关有保存状态时，以状态为准。

| 配置路径 | 默认值／可选值 |
| --- | --- |
| `toolActivity.placement` | `aboveEditor`；可选 `belowEditor` |
| `toolActivity.maxItems` | 6；范围 1–20 |
| `workAnimation.placement` | `aboveEditor`；可选 `belowEditor` |
| `workAnimation.intervalMs` | 180 毫秒；范围 100–500 |
| `statusline.overflow` | `drop-right` 从右侧隐藏；`priority` 先压缩再按优先级隐藏 |
| `statusline.segments` | 状态段 ID 数组，整组替换，重复项去重 |
| `statusline.extensionStatuses.exclude` | 排除的扩展状态 ID，支持 `*` 通配符 |
| `uiMeta.title.enabled` | `true` |
| `uiMeta.title.maxLength` | 36；范围 8–80 |
| `uiMeta.sessionName.enabled` | `true` |
| `uiMeta.sessionName.maxLength` | 48；范围 8–100 |

[仓库配置](../../plugin-configs/session-ui/config.json) 只覆盖状态段顺序，其余使用默认值。

### 自动标题与会话命名

标题和会话名复用正常模型回答，**不额外请求模型**，仅在交互式 TUI 启用。

- **会话名**：首次明确目标时补充一次；已有名称保留，需要改名时使用 `/name`。
- **动作标题**：首次出现明确活动或工作发生实质变化时可更新；普通确认和工具续跑无需更新，省略时保留原标题。
- **失败或中断**：不应用该次输出的标题。
- **后台独立续跑**：不更新标题或名称。

更新时机由模型判断，不保证每轮都有新标题。

### 图片粘贴与预览

图片显示为 `[image #1]`、`[image #2]`。光标进入标签时显示预览，移出后隐藏，不抢占输入焦点。文本粘贴与提交保持 Pi 原生行为。

- macOS 使用 `Ctrl+V` 读取剪贴板图片，无图片时回退文本；终端 `Cmd+V` 不等同于该快捷键。
- 需要终端支持图片显示。Kitty 协议预览 PNG；iTerm2 协议支持 PNG、JPEG、WebP 和 GIF。
- 预览不主动放大，最大占屏幕宽度 90%、高度 75%；空间不足或图片无法读取时不显示。
- 编辑器接口不适配时会警告并关闭受影响的增强，保留原生编辑和提交。

### 状态栏

通过 `statusline.segments` 选择并排列：

| ID | 内容 |
| --- | --- |
| `model` | 当前模型 |
| `effort` | 思考档位及绿色 `fast` 标记；`off` 档位隐藏 |
| `directory` | 工作目录 |
| `branch` | Git 分支 |
| `context` | 上下文使用率和窗口大小 |
| `usage` | 订阅窗口额度和重置倒计时；需 `pi-subscription-usage` |
| `cache` | 当前、最近五次请求及会话的缓存命中率 |
| `cost` | 会话中已记录的费用估算 |
| `extensions` | 未被排除的其他扩展状态 |
| `tokens` | 累计输入／输出 token，仓库默认不显示 |
| `session` | 会话名称，默认不显示 |

未知状态段 ID 会提示并跳过。MCP 连接状态通过 `/mcp` 查看。

`usage` 跟随订阅插件的百分比模式和刷新频率，不是本会话账单。`cost` 使用 Pi 记录的估价，包含订阅请求；`$0.000` 不代表服务免费。`tokens` 和 `cost` 包括已记录的后台用量，缓存命中率只统计 assistant 请求。

`fast` 只表示本地已启用，详情通过 `/fast status` 查看，见 [Fast 使用说明](../fast/README.md)。
