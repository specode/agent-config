# Fast

一个可独立使用的 Pi 扩展，用同一个 `/fast` 开关尝试提高当前模型的请求优先级。Codex 订阅请求添加 priority 档位；Grok 4.7 改走 Grok Build 代理的 fast 通道。

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
| `/fast` | 切换当前模型所属 provider 的开关 |
| `/fast on` | 开启；重复执行仍为开启 |
| `/fast off` | 停止本扩展的 Fast 行为，不删除其他来源的档位 |
| `/fast status` | 只看当前状态，不切换 |

命令只回一行：`Fast: on` 或 `Fast: off`。当前模型不适用时不切换，直接回 `Fast: unavailable (原因)`，原因是模型、API 或认证不满足。只有在切换没有真正落地时才会追加说明：`applies from the next turn`（当前回合还在生成）、`this session only (switch not saved)`（状态文件写不进去）、`not applied (...)`（传输切换失败）。

开关**按 provider 记忆并立即保存**，reload、新建会话、重启 Pi 之后仍然有效。`openai-codex` 和 `xai` 各自独立：关掉 Codex 不影响 Grok。没有 Fast 策略的 provider 拒绝切换，也不写入状态。

开启且当前通道符合条件时，状态栏显示 `fast`；Grok 只在代理传输已经装上后显示。关闭或不适配时隐藏。自定义状态栏可能不展示该标记，以 `/fast status` 为准。

provider 开着但当前模型不适用时（例如 `xai/grok-4.6`，或掉了 OAuth），请求不做任何处理。此时执行 `/fast` 会报 `Fast: unavailable (原因)`，并把该 provider 保存过的"开启"改写为关闭，避免状态显示开着却从不生效；回到适用模型后需要重新 `/fast on`。配置无效属于配置问题，不会改写已保存的开关。

当前回合仍在生成时，`/fast` 立即保存开关，传输切换延后到下一回合开始。

## 配置

默认配置路径为 `~/.pi/agent/extensions/fast.json`，开关状态写在 `~/.pi/agent/state/fast.json`。设置 `PI_CODING_AGENT_DIR` 时，两者都在该目录下。

```json
{
  "enabled": false,
  "showStatus": true,
  "grokClientVersion": "1.0.40"
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | provider 还没有保存过开关时的默认值 |
| `showStatus` | `true` | 是否显示 `fast` 标记；关闭不影响 Fast 行为 |
| `grokClientVersion` | `1.0.40` | 发往 Grok Build 代理时声明的 Grok CLI 版本；代理提高版本下限时更新它 |

字段可省略，文件缺失时使用默认值。未知字段、非法类型或读取／解析失败时会禁用 Fast 并警告，不能用 `/fast on` 绕过；修正后执行 `/reload`。

状态文件由扩展自己维护：写入前先重新读取并合并，多个 Pi 同时切换只会覆盖各自改动的 provider。状态文件损坏或不可写时，Fast 退回配置默认值并警告，当前会话仍可用 `/fast` 临时切换。

## 适用范围与限制

### Codex

按 provider 生效，不设模型白名单：只要是 `openai-codex` provider 的 `openai-codex-responses` API，并且使用 ChatGPT OAuth，就适用；API-key 认证不适用。

请求未指定服务档位时，扩展添加 `service_tier: "priority"`；已有档位时保持原样。因此 `/fast off` 只停止本扩展添加档位，不保证其他来源没有启用 priority。不修改所选模型。

### Grok 4.7

公开 xAI API 没有 Fast 变体，`grok-4.7-build-fast` 只存在于 Grok Build 代理上。

开关开启且当前模型是 `xai/grok-4.7` 时，扩展**保持模型身份不变**，只把这一个会话的传输换成代理：`baseUrl` 指向 `https://cli-chat-proxy.grok.com/v1`，带上代理所需的 `X-XAI-Token-Auth`、`x-grok-model-override`、`x-authenticateresponse`、`x-grok-client-identifier` 和 `x-grok-client-version`，并在 payload 里把模型名改成 `grok-4.7-build-fast`。关闭、离开该模型或重启后恢复公开 API 的传输。

会话记录、模型范围（`enabledModels`）和"上次使用的模型"始终看到目录里真实存在的 `xai/grok-4.7`，所以恢复会话和 Ctrl+P 循环不会出问题。旧会话里残留的 `grok-4.7-build-fast` 选择会在下一次处理时被换回 `xai/grok-4.7`。

代理按 Grok CLI 的客户端标识和版本放行，**扩展因此会声明自己是该版本的 Grok CLI**。版本下限提高时代理会返回 426，此时更新 `grokClientVersion`。它复用 Pi 已有的 xAI OAuth，不读取凭据文件，API key 不会被送到代理。

Pi 会按该模型上的 2 倍目录价格估算费用；这不是服务端账单。代理是否接受这个 token，不能从传输切换成功或 `fast` 标记推断。

如果请求仍指向公开 API，扩展不会把 fast 模型名写进去，避免把一个公开 API 不接受的模型发出去。

两种通道都不额外调用网络，也不增加重试或自动降级。Pi 当前的扩展接口读不到响应体里的 `service_tier`，无法确认后端最终是否加速，`Fast: on` 只表示开关已开启且本地处理已生效。不要把它、`fast` 标记、响应速度或成功请求当作加速确认。
