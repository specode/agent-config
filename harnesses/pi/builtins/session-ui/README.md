# Pi session-ui

Pi 终端界面扩展，包含底部状态栏、工具调用面板、工作动画、图片紧凑粘贴与预览、`/effort` 思考档位选择、每轮耗时显示，以及自动标题与会话命名。

## 快速开始

在仓库根目录执行（需 Pi 1.4.0 和 `rsync`）：

```bash
./install-harness.sh pi
```

插件会装到 `~/.pi/agent/extensions/session-ui/`。重启 Pi 或执行 `/reload` 后生效，可以用 `/effort` 或 `/work-animation status` 试试。

## 使用说明

### 基本用法

| 功能 | 说明 |
| --- | --- |
| 工具活动 | 输入框上方实时列出本轮工具调用（`◆` 运行中、`◇` 完成、`✗` 失败；Codemode 内部调用缩进显示），本轮结束后清空 |
| 工作动画 | `/work-animation on`、`off` 开关，`status` 查看当前状态 |
| 图片预览 | 粘贴图片后显示为 `[image #1]`，把光标移进标签即可弹出预览 |
| 状态栏 | `/statusline` 临时切换自定义状态栏与原生底栏 |
| 思考档位 | `/effort` 打开选择器，`/effort <level>` 直接设置，`/effort status` 查看（非 TUI 模式需直接传档位名） |
| 本轮耗时 | 每轮回复结束后显示耗时，仅作界面展示，不发给模型 |
| 标题与命名 | 随工作变化更新终端标题，并在首次明确目标时为未命名会话起名；手动改名用 `/name` |

### 状态栏

状态栏显示哪些项、按什么顺序排，由配置里的 `statusline.segments` 决定：

| ID | 内容 |
| --- | --- |
| `model` | 当前模型（宽度不够时缩写为模型 ID） |
| `effort` | 思考档位（`off` 时隐藏）及绿色 `fast` 标记 |
| `directory` | 当前工作目录 |
| `branch` | Git 分支 |
| `context` | 上下文使用率与窗口大小 |
| `usage` | 订阅窗口额度与重置倒计时（需安装 `pi-subscription-usage`） |
| `cache` | 缓存命中率，格式为 `当前请求/最近5次/整个会话` |
| `cost` | 会话累计估算费用 |
| `extensions` | 未被排除的其他扩展状态 |
| `tokens` | 累计输入 / 输出 token（`↑输入 ↓输出`，仓库配置默认不显示） |
| `session` | 会话名称（默认不显示） |

几点说明：
- `usage` 的百分比模式和刷新频率跟随 `pi-subscription-usage`，显示的是账号订阅周期额度，不是单次会话账单。
- `cost` 按 Pi 记录的模型单价估算（含订阅请求和已记录的后台请求），显示 `$0.000` 不代表免费；`cache` 只统计 assistant 请求。
- `fast` 只代表本地开启了 Fast 策略，具体状态用 `/fast status` 查看，详见 [Fast 说明](../fast/README.md)。
- MCP 状态通过 `/mcp` 查看；如果 `segments` 里写了未知的 ID，启动时会提示并跳过。

### 图片粘贴与预览

粘贴剪贴板图片时，输入框里会插入 `[image #1]`、`[image #2]` 这样的短标签，删除、撤销和发送行为与原生编辑器一致。光标移入标签时在上方弹出图片预览，移开自动收起，不抢输入焦点。

- macOS 下用 `Ctrl+V` 读取剪贴板图片（没图片时回退为普通文本粘贴；注意终端的 `Cmd+V` 只粘贴文本）。
- 要求终端支持图片显示：Kitty 协议可预览 PNG；iTerm2 协议支持 PNG、JPEG、WebP 和 GIF。
- 预览按原图比例缩放，不放大低分辨率小图，最大不超过终端宽度的 90%、高度的 75%。空间不够或文件读不到时不显示；如果遇到编辑器内部接口变动，会提示一次并退回原生粘贴行为。

### 自动标题与会话命名

标题和会话名顺带由主模型在正常回复时生成，**不额外发请求**，只在交互式 TUI 下启用：

- **会话名**：会话还没名字、且首次明确任务目标时自动设一次。只要已经有名字（不管自动起名还是 `/name` 手动改名），后续都不会再被覆盖。
- **动作标题**：出现明确任务或工作重心变化时更新终端标题；普通确认、追问和工具续跑不改标题，失败或中断的回复也会被忽略。
- **后台续跑**：后台独立续跑任务不会改标题或会话名。

### 配置

`/work-animation on|off` 切换后会立即存到 `~/.pi/agent/state/session-ui.json`（设置了 `PI_CODING_AGENT_DIR` 时在该目录下的 `state/session-ui.json`），重启或更新插件后依然保留，且优先级高于配置文件里的 `workAnimation.enabled`。状态文件损坏或无法写入时会给出提示。

界面配置文件默认在插件目录下的 `config.json`（`~/.pi/agent/extensions/session-ui/config.json`），也可以在启动时用环境变量指定别的路径：

```bash
PI_SESSION_UI_CONFIG=/absolute/path/to/session-ui.json pi
```

改完配置后执行 `/reload` 生效。默认配置文件不存在或漏写字段时直接用默认值；如果显式指定的文件不存在、JSON 写错或字段类型不对，启动时会提示一次，报错字段回退为默认值，其余有效字段照常生效。

比如只保留模型、思考档位、目录和上下文：

```json
{
  "statusline": {
    "segments": ["model", "effort", "directory", "context"]
  }
}
```

所有模块（`toolActivity`、`workAnimation`、`compactPaste`、`statusline`、`effort`、`turnDuration`、`uiMeta`）默认开启，设 `enabled: false` 即可单独关掉。[仓库配置](../../plugin-configs/session-ui/config.json) 只改了 `statusline.segments`（去掉了 `tokens`），其余全是默认值：

| 配置项 | 默认值与可选值 |
| --- | --- |
| `toolActivity.placement` | `"aboveEditor"`；可选 `"belowEditor"` |
| `toolActivity.maxItems` | `6`；范围 `1`–`20` |
| `workAnimation.placement` | `"aboveEditor"`；可选 `"belowEditor"` |
| `workAnimation.intervalMs` | `180`（毫秒）；范围 `100`–`500` |
| `statusline.overflow` | `"drop-right"` 从右侧隐藏；`"priority"` 先换紧凑格式再按优先级隐藏 |
| `statusline.segments` | 状态段 ID 数组，整组替换并去重 |
| `statusline.extensionStatuses.exclude` | `extensions` 段要排除的状态 ID，支持 `*` 通配符 |
| `uiMeta.title.enabled` | `true` |
| `uiMeta.title.maxLength` | `36`；范围 `8`–`80` |
| `uiMeta.sessionName.enabled` | `true` |
| `uiMeta.sessionName.maxLength` | `48`；范围 `8`–`100` |
