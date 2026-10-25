# Fast

Pi 扩展，用一个 `/fast` 开关为当前模型启用高优先级请求：OpenAI／Codex 的 ChatGPT 订阅请求尝试 priority 档位，Grok 4.7 使用 Grok Build 的 fast 通道。

**默认关闭，开启可能增加额度消耗。** `Fast: on` 表示本地处理已生效，不保证后端实际加速。不依赖其他扩展或自定义状态栏。

## 快速开始

使用当前稳定版 Pi，通过 `/login` 登录 ChatGPT 或 xAI 订阅。Fast 不适用于 API key。

保留本目录全部源码，执行：

```bash
pi install /absolute/path/to/fast/index.ts
```

Pi 直接加载该路径。也可将整个目录复制到 `~/.pi/agent/extensions/fast/`，两种方式选一种，避免重复加载。

在 Pi 中执行：

```text
/reload
/fast on
/fast status
```

## 使用说明

### 命令与状态

| 命令 | 操作 |
| --- | --- |
| `/fast` | 切换当前 provider 的开关 |
| `/fast on` | 开启 |
| `/fast off` | 关闭本扩展的 Fast 行为 |
| `/fast status` | 查询，不切换 |

通常只输出 `Fast: on` 或 `Fast: off`；模型、API 或认证不满足时，输出 `Fast: unavailable (原因)`。切换延后、保存失败或应用失败时会附加简短说明。

- 开关按 provider 保存，`openai`、`openai-codex`、`xai` 互不影响。
- 重新加载、新建会话和重启后保留选择。
- 正在生成时，切换立即保存，从下一回合应用。
- 状态栏的 `fast` 标记由界面决定是否展示，以 `/fast status` 为准。

当前模型不适用时，请求不做 Fast 处理。在此情况下执行切换命令会报失败，并将该 provider 已保存的“开启”改为关闭；返回适用模型后需重新开启。配置错误不会改写已保存的开关。

### 配置与保存位置

- 默认配置：`~/.pi/agent/extensions/fast.json`
- 开关状态：`~/.pi/agent/state/fast.json`

设置 `PI_CODING_AGENT_DIR` 时，两者都位于该目录下。扩展只写状态文件，不回写配置。

```json
{
  "enabled": false,
  "showStatus": true,
  "grokClientVersion": "1.0.40"
}
```

| 字段 | 用途 |
| --- | --- |
| `enabled` | 尚未保存开关时的默认值 |
| `showStatus` | 是否发布 `fast` 标记，不影响请求 |
| `grokClientVersion` | Grok Build 请求声明的客户端版本 |

字段可省略。未知字段、类型错误或配置读取失败时会禁用 Fast 并警告，修正后执行 `/reload`。状态文件损坏或无法写入时会提示，当前会话仍可临时切换。

### OpenAI 与 Codex

需要 ChatGPT OAuth，provider 与 API 对应如下：

| Provider | API |
| --- | --- |
| `openai` | `openai-responses` |
| `openai-codex` | `openai-codex-responses` |

不按模型 ID 限制。请求未指定服务档位时添加 `service_tier: "priority"`，已有档位保持不变，不修改所选模型。因此 `/fast off` 不会删除其他来源设置的 priority。

### Grok 4.7

需要 `xai/grok-4.7` 和 xAI OAuth。开启后，请求改走 Grok Build 代理的 `grok-4.7-build-fast` 通道；会话中的模型身份仍为 `xai/grok-4.7`，模型选择和记忆不变。

代理按 Grok CLI 客户端标识与版本放行，扩展会声明相应标识。若返回 426，检查并更新 `grokClientVersion`。API key 不会被送到代理，Fast 模型名不会发往公开 xAI API。

Pi 按目录价格的两倍估算该通道费用，这不是实际账单。代理是否接受账号、最终是否加速，取决于服务端。

所有通道均不增加额外探测请求、重试或自动降级；扩展不核验后端最终采用的服务档位。
