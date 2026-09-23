# Pi session-ui

`session-ui` 为个人 Pi 工作流提供工具活动、工作动画、图片预览、自定义状态栏、思考档位切换，以及自动任务标题和任务状态摘要。主要用于交互式终端界面（TUI）。

## 快速开始

先安装并登录 Pi，在本仓库根目录执行：

```bash
./install-harness.sh pi
```

插件安装到 `~/.pi/agent/extensions/session-ui/`，Pi 自动加载其中的 `index.ts`。使用安装器更新即可，不要额外复制或加载另一份入口。

重新启动 Pi，或在已有交互会话中执行：

```text
/reload
/work-animation status
/effort status
```

默认启用全部展示功能。可以用 `/statusline` 临时切回 Pi 默认状态栏，用 `/work-animation off` 关闭工作动画。

## 功能与命令

| 功能 | 使用方式 |
| --- | --- |
| 工具活动 | 在编辑器附近显示本轮最近的工具执行状态，本轮结束后清空；正式结果仍在对话记录中 |
| 工作动画 | 工作时显示动画并更新终端标题；`/work-animation on` 或 `off` 开关，`status` 查询 |
| 图片预览 | 粘贴图片后，将光标移入图片标签即可预览 |
| 状态栏 | 显示模型、思考档位、目录、分支、用量等；`/statusline` 临时切换 |
| 思考档位 | `/effort` 打开选择器；`/effort <level>` 设置；`/effort status` 查看当前与支持的档位 |
| 本轮耗时 | 本轮结束后在对话记录中显示，不发送给模型 |
| 自动标题与摘要 | 按当前动作更新终端标题、按会话目标更新名称，并在本轮结束时于对话记录中显示 Recap |

`/work-animation on|off` 会写回当前配置文件；`/statusline` 只临时切换，不写配置。`/effort show` 和 `/effort current` 等同于 `status`。非 TUI 使用 `/effort` 时需显式传入档位；模型不支持指定档位时会提示。

自动标题和 Recap 复用正常模型回答，不额外发起模型请求。JSON、print 和 RPC 模式不启用该功能。

该功能需要 Pi 0.87.0 或更新版本。固定规则作为系统提示段随会话保存，本轮提醒只在发送请求时附加，不写入聊天记录；切到非 TUI 模式后，Pi 会追加补丁移除生效中的规则段。这样避免由本功能合并已有系统消息，尽量保留缓存前缀。实际缓存效果仍取决于模型和其他扩展，不保证命中率提升。

Recap 描述**同一个连续任务截至当前的整体进展**，结合相关多轮对话中的成果、阻塞和待验证项，以最新事实修正旧结论，而不是只总结最后一次回答。任务以用户希望达成的目标为边界，澄清需求、讨论方案、实现、测试和修正可以属于同一任务，不按轮次或阶段拆分。切换目标后不混入上一任务的成果，也不因话题相似而合并无关目标；任务归属不受手工会话命名锁影响。

摘要区分需求已确认、方案已提出或确定、代码已实现和结果已验证。仅讨论时只描述已澄清、已决定和未解决的事项，不把建议或计划写成已经实施、测试通过。

展示位置、样式和时机保持不变：在本轮结束后追加到对话记录中，不使用编辑器 widget，不覆盖历史摘要。任务归属与内容由主模型根据可用上下文判断；Recap 不重新注入模型上下文，也不替代验证证据。模型未提供有效摘要时不生成 Recap；标题缺失时保留上一标题，不影响正常回答。

默认情况下，手工 `/name` 命名会阻止后续自动覆盖会话名称，但任务标题仍可更新。目前不提供 `/unname`；可通过配置关闭手工命名锁。

## 配置

安装后的配置位于 `~/.pi/agent/extensions/session-ui/config.json`。[仓库配置](../../plugin-configs/session-ui/config.json) 只覆盖 `statusline.segments`（去掉 `tokens`），其余字段的默认值以下表为准；需要个人偏好时在其中只写要改的项。`segments` 整组替换，不与默认值合并。也可在启动前指定绝对路径：

```bash
PI_SESSION_UI_CONFIG=/absolute/path/to/session-ui.json pi
```

配置应为可读的 JSON 对象。无效字段会回退默认值；覆盖路径不存在或配置段不是对象时也可能静默回退，修改后请核对实际效果。配置在扩展加载时读取，修改后需 `/reload` 或重启 Pi。

### 功能开关与位置

以下功能均可通过对应的 `enabled` 字段关闭，默认均为 `true`：`toolActivity`、`workAnimation`、`compactPaste`、`statusline`、`effort`、`turnDuration`、`uiMeta`。

| 配置路径 | 可选值／默认值 | 说明 |
| --- | --- | --- |
| `toolActivity.placement` | `aboveEditor`（默认）／`belowEditor` | 工具活动位置 |
| `toolActivity.maxItems` | 1–20；默认 6 | 最近工具展示数量 |
| `workAnimation.placement` | `aboveEditor`（默认）／`belowEditor` | 工作动画位置 |
| `workAnimation.intervalMs` | 100–500；默认 180 | 动画刷新间隔，单位毫秒 |
| `statusline.overflow` | `drop-right`（默认）／`priority` | 空间不足时从右侧隐藏，或先压缩再按优先级隐藏 |
| `statusline.segments` | 字符串数组 | 状态段的顺序与显隐；重复 ID 会去重 |
| `statusline.extensionStatuses.exclude` | 字符串数组 | 排除的扩展状态 ID，支持 `*` 通配符 |

### 自动标题、摘要与会话名称

| 配置路径 | 可选值／默认值 | 说明 |
| --- | --- | --- |
| `uiMeta.title.enabled` | boolean；默认 `true` | 自动更新任务标题 |
| `uiMeta.title.maxLength` | 8–80；默认 36 | 标题最大可见字符数 |
| `uiMeta.recap.enabled` | boolean；默认 `true` | 显示当前任务跨轮更新的状态摘要 |
| `uiMeta.recap.maxLength` | 20–240；默认 120 | 摘要最大可见字符数 |
| `uiMeta.sessionName.enabled` | boolean；默认 `true` | 自动更新会话名称 |
| `uiMeta.sessionName.maxLength` | 8–100；默认 48 | 会话名称最大可见字符数 |
| `uiMeta.sessionName.manualNameLocks` | boolean；默认 `true` | 手工命名后阻止自动覆盖 |

## 图片粘贴与预览

图片显示为 `[image #1]`、`[image #2]`。光标进入图片标签时，在标签上方显示不抢占输入焦点的预览；移出后自动隐藏。

- 图片标签前后不自动添加空格；标签可能有用于对齐的显示填充，但不影响提交内容。
- 文本粘贴沿用 Pi 原生标签、间距、换行和提交内容。
- macOS 下 Pi 默认用 `Ctrl+V` 读取剪贴板图片，无图片时回退文本；终端的 `Cmd+V` 不等同于该快捷键。
- 需要终端支持图片显示。Kitty 协议当前只预览 PNG；iTerm2 协议支持 PNG、JPEG、WebP 和 GIF。
- 预览不主动放大，最多占屏幕宽度的 90%、高度的 75%。终端过窄、标签不在可见区域或图片无法读取时不显示。
- 与 Pi 编辑器不兼容时会提示并关闭受影响的增强功能，保留原生编辑与提交行为。

## 状态栏

通过 `statusline.segments` 选择并排列以下状态段：

| ID | 显示内容 |
| --- | --- |
| `model` | 当前模型 |
| `effort` | 当前 thinking 档位及绿色 `fast` 标记；thinking 为 `off` 时隐藏档位 |
| `directory` | 当前工作目录 |
| `session` | 会话名称，默认未启用 |
| `branch` | Git 分支 |
| `context` | 上下文使用率和窗口大小 |
| `usage` | 订阅窗口额度百分比及重置倒计时，按 5h／1w／1m 排列；需要订阅用量插件 |
| `tokens` | 当前会话累计输入／输出 token，仓库配置已关闭 |
| `cache` | 当前、最近五次 assistant 请求及会话的缓存命中率 |
| `cost` | 当前会话已记录的费用估算；没有费用记录时显示 `$0.000` |
| `mcp` | MCP 已连接／已启用数量及可用服务名称 |
| `extensions` | 未被排除的其他扩展状态 |

例如，只显示模型、思考档位、目录和上下文：

```json
{
  "statusline": {
    "enabled": true,
    "segments": ["model", "effort", "directory", "context"]
  }
}
```

相邻的模型与思考档位、目录与分支用空格连接，其余状态段使用 Powerline 分隔符。空间不足时按 `overflow` 配置隐藏内容；未知 ID 会提示并跳过。

`fast` 由 Fast 控制，详情用 `/fast status` 查询。它只是启用标记，不代表后端已确认加速，详见 [Fast 使用说明](../fast/README.md)。

`usage` 跟随订阅插件当前的百分比显示模式，颜色按剩余额度告警；它不是本会话账单。`↻` 后是插件提供的重置倒计时，按原样显示，刷新频率与可能的滞后以订阅用量插件说明为准。`tokens` 和 `cost` 汇总会话中已记录的用量（包括后台预热等），缓存命中率仅统计 assistant 请求、不计后台预热。`cost` 直接取 Pi 记录的费用，而 Pi 按模型内置价目表估算，订阅计费下同样累计，因此它是资源消耗估算而非实际账单；显示 `$0.000` 也不代表服务免费或订阅额度未消耗。
