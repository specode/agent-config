# Pi session-ui

`session-ui` 是 Pi 交互会话的组合式展示扩展。顶层入口为
`../session-ui.ts`，本目录保存实现、配置和单元测试。Pi 只加载顶层入口，不会把本目录中的模块再次当作独立扩展加载。

## 模块

| 配置段 | 默认 | 作用 | 运行边界 |
| --- | --- | --- | --- |
| `toolActivity` | 开启 | 在编辑器附近投影本轮工具执行状态 | 仅 TUI；`turn_end` 后清空 |
| `compactPaste` | 开启 | 缩短图片和长文本的编辑器占位符 | 仅 TUI；不兼容时回退 Pi 原生编辑器 |
| `statusline` | 开启 | 用可组合 segments 替换默认 footer | 仅有 UI 的会话；可用 `/statusline` 临时切换 |
| `effort` | 开启 | 用 `/effort` 查看或调整模型支持的 thinking 档位 | 选择面板仅 TUI；非 TUI 需显式传档位 |
| `turnDuration` | 开启 | 在 transcript 中追加 turn 耗时 entry | 仅 TUI；不会发送给模型 |

工具活动只订阅 `tool_execution_*` 生命周期事件，不调用 `registerTool`，因此不会覆盖 Pi 内置工具、远程 operation、SDK 工具或其他扩展注册的工具。持久结果始终由工具自身的原生 transcript renderer 展示。

## 配置

默认配置文件是 [`config.json`](./config.json)。也可以在启动 Pi 前指定绝对路径：

```bash
PI_SESSION_UI_CONFIG=/absolute/path/to/session-ui.json pi
```

覆盖文件必须存在、可读且以对象作为根节点。无效字段会回退默认值；当前加载器对“覆盖路径不存在”和“模块配置段不是对象”的情况可能静默回退，因此修改后应核对启动效果。

### 顶层配置项

| 路径 | 类型/范围 | 说明 |
| --- | --- | --- |
| `toolActivity.enabled` | boolean | 是否启用工具活动 widget |
| `toolActivity.placement` | `aboveEditor` \| `belowEditor` | widget 位于编辑器上方或下方 |
| `toolActivity.maxItems` | 1–20 | 最多展示的最近工具数；默认 6 |
| `compactPaste.enabled` | boolean | 是否启用紧凑粘贴占位符 |
| `statusline.enabled` | boolean | 是否注册自定义 footer |
| `statusline.overflow` | `drop-right` \| `priority` | 空间不足时从右侧裁剪，或先压缩再按优先级隐藏 |
| `statusline.segments` | string[] | segment 的顺序与显隐；重复 ID 会去重 |
| `statusline.extensionStatuses.exclude` | string[] | 过滤 extension status ID；支持 `*` 通配符 |
| `effort.enabled` | boolean | 是否注册 `/effort` |
| `turnDuration.enabled` | boolean | 是否在 TUI transcript 中记录耗时 |

配置文件只在扩展加载时读取；修改后使用 `/reload` 或重新启动 Pi。

## Statusline segments

内置 segment 如下：

| ID | 内容 |
| --- | --- |
| `model` | 当前模型；启用 openai-fast 时附加 `fast` |
| `effort` | 当前 thinking 档位；`off` 时隐藏 |
| `directory` | 当前工作目录 |
| `session` | session 名称；默认配置未启用 |
| `branch` | Git branch |
| `context` | context 使用率和窗口大小 |
| `tokens` | session 输入/输出 token |
| `cache` | 当前轮、最近五轮和 session cache hit rate |
| `cost` | session 成本；订阅模型显示 `$0.000` |
| `mcp` | MCP 已连接/已启用数量和可用的 server 名称 |
| `extensions` | 未被 exclude 过滤的其他 extension statuses |

`drop-right` 保持配置顺序，并从右侧移除放不下的 segment。`priority` 会先使用 segment 的紧凑形式，再隐藏低优先级且非必需的 segment。最终输出仍会按终端可见宽度截断。

其他本地扩展可通过 `session-ui/statusline/register/v1` 事件注册 segment；只有同时出现在 `statusline.segments` 中的 ID 才会展示。未知 ID 会在 session 启动时提示并跳过。

## 命令

### `/effort [level|status]`

- `/effort`：TUI 中打开选择器。
- `/effort status`、`/effort show`、`/effort current`：显示模型、当前档位和支持档位。
- `/effort <level>`：直接设置档位；模型不支持时给出 warning。

### `/statusline`

在当前会话中切换自定义 footer 与 Pi 默认 footer。该切换不修改 `config.json`，reload 或重新启动后仍以配置文件为准。

## 明确不提供的旧行为

当前模块化实现不再包含：

- 终端标题的 LLM 摘要；
- 自动 session 命名；
- `/unname`；
- 对内置 `read`、`grep`、`bash` 等工具的重新注册或 Activity transcript 合并。

这些是当前范围边界，不应从旧单文件实现推断仍然存在。`npm:@ogulcancelik/pi-codex-compaction` 也未在当前 `settings.json` 中启用；session-ui 不负责替代该 package 的 compaction 行为。

## 验证

仓库没有项目级 `package.json` 或 `tsconfig.json`。当前可直接运行的单元测试是：

```bash
node --test harnesses/pi/agent/extensions/session-ui/statusline-core.test.ts
```

可以用已安装的 Pi 做只加载检查：

```bash
pi --no-extensions --offline \
  -e ./harnesses/pi/agent/extensions/session-ui.ts \
  --list-models grok-4.6
```

测试覆盖 statusline 核心布局、glob 过滤、未知 segment 和 MCP status 解码；`/effort` 交互、工具并发投影、真实 TUI footer、compaction continuation 和跨 session 生命周期仍需要人工或集成验证。
