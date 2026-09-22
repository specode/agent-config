# Fast

一个可独立使用的 Pi 扩展，用同一个 `/fast` 开关尝试提高当前模型的请求优先级。Codex 订阅请求添加 priority 档位；Grok 4.7 则把会话切换到 Grok Build 代理上的 fast 模型。

**默认关闭。Fast 可能增加额度消耗，启用不代表后端已确认加速。** 不依赖自定义状态栏或其他扩展。

## 快速开始

先安装 Pi。Codex 需要通过 `/login` 完成 ChatGPT OAuth；Grok 4.7 需要 xAI OAuth，不能使用 API key。

获取本目录的完整源码后，安装本地扩展：

```bash
pi install /absolute/path/to/fast/index.ts
```

将路径替换为实际绝对路径，并保留同目录的 `runtime.ts`。Pi 引用该路径，不复制源码；更新后需 `/reload` 或重启。

也可以把整个目录复制到 `~/.pi/agent/extensions/fast/`，由 Pi 自动发现。两种方式选一种，避免重复加载。

在交互式 Pi 中执行：

```text
/reload
/fast on
/fast status
```

如果已安装其他注册 `/fast` 或调整服务档位、模型的扩展，请先处理重复加载和设置冲突。旧的 `openai-fast` 目录不能与本扩展同时加载。

## 命令与状态

| 命令 | 说明 |
| --- | --- |
| `/fast` | 切换当前会话的开关 |
| `/fast on` | 开启；重复执行仍为开启 |
| `/fast off` | 停止本扩展的 Fast 行为，不删除其他来源的档位 |
| `/fast status` | 查看开关、配置来源、适配情况和最近一次处理 |

开启且当前通道符合条件时，状态栏显示 `fast`。Codex 在符合条件时即显示；Grok 只在会话已经切到代理 fast 模型后显示。关闭或不适配时隐藏。自定义状态栏可能不展示该标记，以 `/fast status` 为准。

会话命令不写配置。切换模型保留开关，但清空最近请求观察。reload、新建、恢复、fork 会话或重启 Pi 后，重新读取全局配置并重置临时开关。

当前回合仍在生成时，`/fast` 只记下开关，模型切换延后到下一回合开始。

## 配置

默认配置路径为 `~/.pi/agent/extensions/fast.json`。设置 `PI_CODING_AGENT_DIR` 时，使用该目录下的 `extensions/fast.json`，不读取项目配置。

```json
{
  "enabled": false,
  "showStatus": true,
  "excludeModels": []
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 没有会话临时开关时的默认值 |
| `showStatus` | `true` | 是否显示 `fast` 标记；关闭不影响 Fast 行为 |
| `excludeModels` | `[]` | 排除的模型 ID，精确匹配，不支持通配符或 `provider/model` 写法 |

字段可省略，文件缺失时使用默认值。未知字段、非法类型或读取／解析失败时会禁用 Fast 并警告，不能用 `/fast on` 绕过；修正后执行 `/reload`。排除 `grok-4.7` 或 `grok-4.7-build-fast` 都会停用这一对模型的切换。

## 适用范围与限制

### Codex

仅用于 `openai-codex` provider 的 `openai-codex-responses` API，并且需要 ChatGPT OAuth，不适用于 API-key 认证。配置必须有效、开关开启，且模型未被排除。

请求未指定服务档位时，扩展添加 `service_tier: "priority"`；已有档位时保持原样。因此 `/fast off` 只停止本扩展添加档位，不保证其他来源没有启用 priority。不修改所选模型。

### Grok 4.7

公开 xAI API 没有 Fast 变体。开关开启且当前模型是 `xai/grok-4.7` 时，扩展调用 `setModel` 将会话切到 `grok-4.7-build-fast`，请求发往 `https://cli-chat-proxy.grok.com/v1`，并带上代理所需的 `X-XAI-Token-Auth`、`x-grok-model-override` 和 `x-authenticateresponse`。关闭时切回 `grok-4.7`。

这次切换会写入会话的模型记录，恢复会话时会再次按当前开关校正。它复用 Pi 已有的 xAI OAuth，不读取凭据文件，也不伪装 Grok 客户端标识。API key 不会被送到代理。

Pi 会按该模型上的 2 倍目录价格估算费用；这不是服务端账单。代理是否接受这个 token，不能从切换成功或 `fast` 标记推断。

如果请求仍指向公开 API，扩展不会把 fast 模型名写进去，避免把一个公开 API 不接受的模型发出去。

两种通道都不额外调用网络，也不增加重试或自动降级。Pi 当前的扩展接口无法确认后端最终是否加速，所以 `/fast status` 将实际结果标为未知。不要把 `fast` 标记、响应速度或成功请求当作加速确认。
