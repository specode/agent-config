# OpenAI Fast

一个可独立使用的 Pi 扩展，为 OpenAI Codex 订阅请求提供显式的 Fast 开关。开启后按需添加 `service_tier: "priority"`，不维护模型白名单，也不按模型新旧限制使用。

默认关闭，不自动消耗 Fast 额度。不依赖特定配置仓库、自定义状态栏或其他扩展。代码和运行提示使用英文，本文使用中文。

## 1. 安装与快速开始

需要已安装 Pi，并通过 `/login` 完成 OpenAI Codex 的 ChatGPT OAuth 登录。当前按源码分发，不假定存在已发布的 npm 包。

获取本目录的完整源码后，使用 Pi 的本地扩展安装方式：

```bash
pi install /absolute/path/to/openai-fast/index.ts
```

请替换为实际绝对路径，并保留同目录的 `runtime.ts`。Pi 会引用该路径，不会复制源码；更新源码后需要 `/reload` 或重启。

也可以将整个目录复制到 Pi 的用户扩展目录，形成 `~/.pi/agent/extensions/openai-fast/index.ts`，由 Pi 自动发现。两种方式选一种，避免重复加载。

在交互式 Pi 中执行：

```text
/reload
/fast on
/fast status
```

若启用了其他注册 `/fast` 或调整 service tier 的扩展，请先处理重复加载与设置冲突。本扩展不覆盖请求已有的 tier。

## 2. 命令与状态

| 命令 | 行为 |
| --- | --- |
| `/fast` | 切换当前会话运行时的开关 |
| `/fast on` | 开启；重复执行仍为开启 |
| `/fast off` | 停止本扩展注入，不删除其他来源的 tier |
| `/fast status` | 只读查看开关、配置来源、适配情况和最近一次请求处理 |

状态栏只显示简洁的 `fast`：开启且当前通道符合条件时显示，关闭或不适配时隐藏。请求处理过程不改变这个标记；是否添加 priority、是否保留已有 tier、不适配原因等细节通过 `/fast status` 查询。

**`fast` 是启用标记，不是后端加速确认。** 模型、账号和后端是否接受 priority，以服务端实际行为为准。Fast 可能增加额度消耗。

会话命令不写配置或 session 条目。切换模型保留开关，但清空请求观察；reload、新建、恢复、fork 会话或重启 Pi 后，重新读取全局配置并重置会话覆盖。

## 3. 配置

可选配置文件：`getAgentDir()/extensions/openai-fast.json`，默认位于 `~/.pi/agent/extensions/openai-fast.json`。支持 Pi 的 `PI_CODING_AGENT_DIR` 重定向，不读取项目配置。

```json
{
  "enabled": false,
  "showStatus": true,
  "excludeModels": []
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 没有会话覆盖时的开关默认值 |
| `showStatus` | `true` | 是否展示 `fast` 标记；关闭不影响请求注入 |
| `excludeModels` | `[]` | 不注入 priority 的模型 ID 列表，精确匹配，不支持通配符或 provider/model 写法 |

字段可省略；文件缺失使用默认值。未知字段、非法类型或读取/解析失败时，禁用注入并警告，避免错误的排除列表被忽略。修正后 `/reload`，不能用 `/fast on` 绕过无效配置。

## 4. 适用范围与请求行为

仅处理同时满足以下条件的请求：

- provider 为 `openai-codex`；
- API 为 `openai-codex-responses`；
- 使用 ChatGPT OAuth，而非 API-key 认证；
- 配置有效、开关开启，且模型不在排除列表中；
- payload 是对象，其模型 ID 与当前模型一致。

未设置 `service_tier` 时，返回 payload 的浅拷贝并添加 `priority`；已有该字段时原样保留，包括 null 或 undefined。关闭本扩展不保证整个请求没有 priority：其他来源可能已设置 tier。

本扩展不修改模型、thinking、工具、usage 或凭据，不额外调用网络、不重试、不自动降级。后端错误和 Pi 自身的重试策略不变；费用统计交由 Pi 和服务端处理。

当前 Pi 扩展事件不暴露响应正文中的最终 `service_tier`，后续请求钩子也可能再次修改 payload。因此 `/fast status` 将实际后端档位标记为未知，不根据响应速度、成功状态码或费用倍率推测。

## 5. 自定义界面集成

使用 Pi 标准 `ctx.ui.setStatus()` 接口：

- 状态键：`openai-fast`；
- 开启且适配时的值：`fast`；
- 关闭、不适配或隐藏状态时：清除该键。

Pi 默认 footer 负责展示。自定义 footer 若要显示该标记，应读取 `footerData.getExtensionStatuses()`；位置、颜色和布局由界面扩展自行决定。OpenAI Fast 不导入或依赖任何具体界面扩展，界面也不需要重复实现认证、模型资格或请求策略。

## 6. 开发与验证

在本目录运行：

```bash
node --test ./openai-fast.test.ts
```

需要支持 TypeScript 类型剥离的 Node，请使用当前 Pi 支持的版本。测试使用临时配置和模拟 Pi 事件，不需要账号、网络或其他扩展。当前实现已对照 Pi 0.85.1 的扩展 API 验证；升级 Pi 后应重新核对事件和认证接口。

- `index.ts`：Pi 入口，解析配置路径并注册扩展。
- `runtime.ts`：配置校验、请求策略、状态和命令。
- `openai-fast.test.ts`：模型无白名单、通道边界、已有 tier、显示条件、命令及会话生命周期的回归测试。

本地注入测试不是后端支持证明。真实服务端验证可能消耗额度，需要单独进行。
