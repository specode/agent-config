# Pi session-ui

`session-ui` 是 Pi 交互会话的组合式展示扩展。顶层入口为
`../session-ui.ts`，本目录保存实现、配置和单元测试。Pi 只加载顶层入口，不会把本目录中的模块再次当作独立扩展加载。

## 模块

| 配置段 | 默认 | 作用 | 运行边界 |
| --- | --- | --- | --- |
| `toolActivity` | 开启 | 在编辑器附近投影本轮工具执行状态 | 仅 TUI；`turn_end` 后清空 |
| `compactPaste` | 开启 | 缩短图片和长文本占位符；光标移入图片占位符时显示预览 | 仅 TUI；需终端图片能力；不兼容时回退 Pi 原生编辑器 |
| `statusline` | 开启 | 用可组合 segments 替换默认 footer | 仅有 UI 的会话；可用 `/statusline` 临时切换 |
| `effort` | 开启 | 用 `/effort` 查看或调整模型支持的 thinking 档位 | 选择面板仅 TUI；非 TUI 需显式传档位 |
| `turnDuration` | 开启 | 在 transcript 中追加 turn 耗时 entry | 仅 TUI；不会发送给模型 |
| `uiMeta` | 开启 | 从主模型正常响应提取隐藏元数据，驱动标题、Recap 和 session 名称 | 仅 TUI；不发起额外模型请求 |

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
| `uiMeta.enabled` | boolean | 是否启用统一的隐藏 UI 元数据协议 |
| `uiMeta.title.enabled` | boolean | 是否按最近一轮任务更新终端标题 |
| `uiMeta.title.maxLength` | 8–80 | 标题最大可见字符数；默认 36 |
| `uiMeta.recap.enabled` | boolean | 是否把本轮实际结果写为 transcript entry |
| `uiMeta.recap.maxLength` | 20–240 | Recap 最大可见字符数；默认 120 |
| `uiMeta.sessionName.enabled` | boolean | 是否按会话最新高层目标自动更新 session 名称 |
| `uiMeta.sessionName.maxLength` | 8–100 | session 名称最大可见字符数；默认 48 |
| `uiMeta.sessionName.manualNameLocks` | boolean | 用户手工 `/name` 后是否阻止后续自动覆盖；默认开启 |

配置文件只在扩展加载时读取；修改后使用 `/reload` 或重新启动 Pi。

## 图片预览

启用 `compactPaste` 后，粘贴图片仍以 `[Image N]` 占位，不改变 Pi 原生 paste registry 和提交展开行为。光标进入图片占位符时，会在标签上方显示不抢占输入焦点的预览 Overlay；移出占位符后自动隐藏。

预览仅在终端报告图片能力时启用。Kitty 协议当前只预览 PNG，避免 pi-tui 把 JPEG、WebP、GIF 原始字节错误声明为 PNG；iTerm2 协议支持 PNG、JPEG、WebP 和 GIF。图片在首次进入占位符时异步读取，最多缓存最近 4 张，避免阻塞输入或重复读取。展示大小按图片原始像素与终端 cell 尺寸计算，不主动放大，并限制为屏幕宽度的 90%、高度的 75%；终端过窄、标签不在可见区域或图片无法读取时保持隐藏。定位逻辑对 Pi regular/fullscreen 最近渲染帧使用运行时守卫，关键内部字段变化时会触发一次兼容性 warning，禁用受影响的增强功能，并继续保留 Pi 原生提交行为。

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

## UI Meta 协议

`uiMeta` 不额外调用模型。它在正常请求的 system prompt 中加入固定协议，并通过临时的 `<ui_meta_request>` 上下文标记要求主模型输出两类隐藏记录：

```xml
<ui_meta>{"v":1,"kind":"turn_start","title":"评估 UI 元数据","session":{"action":"keep"}}</ui_meta>
<ui_meta>{"v":1,"kind":"turn_end","recap":"完成协议评估并确定实现边界"}</ui_meta>
```

- `turn_start` 位于第一条 assistant 消息开头：`title` 表示最近一轮正在做什么；`session` 只有在首次明确目标或高层目标切换时才使用 `set`。
- `turn_end` 位于无工具调用的最终 assistant 消息末尾：`recap` 表示本轮实际完成、部分完成或阻塞的结果。
- metadata 在流式 TUI 中由 Markdown transformer 隐藏，在 `message_end` 持久化前从 assistant 消息中删除。
- Recap 作为 `session-ui:turn-recap` 自定义 entry 持久化，不进入模型上下文。
- 自动 session 名称通过 `session-ui:ui-meta-state` 记录来源；手工 `/name` 默认锁定 session 名称，但不会阻止每轮终端标题更新。
- 所有字段都会过滤终端控制字符、双向文本控制符并按配置截断；无效 JSON、过期阶段或失败响应会被忽略。

该能力仅在交互式 TUI 中启用。JSON、print 和 RPC 模式不会注入协议，避免隐藏元数据进入这些模式的流式输出。模型不遵守协议时保持上一标题且不生成 Recap，不影响正常回答。

当前模块化实现仍不提供 `/unname`，也不会重新注册内置 `read`、`grep`、`bash` 等工具或合并 Activity transcript。`npm:@ogulcancelik/pi-codex-compaction` 未在当前 `settings.json` 中启用；session-ui 不负责替代该 package 的 compaction 行为。

## 验证

仓库没有项目级 `package.json` 或 `tsconfig.json`。当前可直接运行的单元测试是：

```bash
node --test \
  harnesses/pi/agent/extensions/session-ui/compact-paste.test.ts \
  harnesses/pi/agent/extensions/session-ui/statusline-core.test.ts \
  harnesses/pi/agent/extensions/session-ui/ui-meta-core.test.ts
```

可以用已安装的 Pi 做只加载检查：

```bash
pi --no-extensions --offline \
  -e ./harnesses/pi/agent/extensions/session-ui.ts \
  --list-models grok-4.6
```

测试覆盖 compact paste 的图片路径、MIME/协议边界、大小格式和 marker 间距，statusline 核心布局、glob 过滤、未知 segment、MCP status 解码，以及 UI Meta 解析、清理、截断和流式隐藏；图片 Overlay 的真实终端绘制、`/effort` 交互、工具并发投影、真实 TUI footer、真实模型协议遵循度、自动/手工 session 名称切换、compaction continuation 和跨 session 生命周期仍需要人工或集成验证。
