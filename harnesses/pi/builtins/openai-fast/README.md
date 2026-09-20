# OpenAI Fast

一个可独立使用的 Pi 扩展，为 OpenAI Codex 订阅请求提供显式的 Fast 开关。开启后尝试使用 priority 服务档位，不按模型新旧设置白名单。

**默认关闭。Fast 可能增加额度消耗，启用不代表后端已确认加速。** 不依赖自定义状态栏或其他扩展。

## 快速开始

先安装 Pi，并通过 `/login` 完成 OpenAI Codex 的 ChatGPT OAuth 登录。

获取本目录的完整源码后，安装本地扩展：

```bash
pi install /absolute/path/to/openai-fast/index.ts
```

将路径替换为实际绝对路径，并保留同目录的 `runtime.ts`。Pi 引用该路径，不复制源码；更新后需 `/reload` 或重启。

也可以把整个目录复制到 `~/.pi/agent/extensions/openai-fast/`，由 Pi 自动发现。两种方式选一种，避免重复加载。

在交互式 Pi 中执行：

```text
/reload
/fast on
/fast status
```

如果已安装其他注册 `/fast` 或调整服务档位的扩展，请先处理重复加载和设置冲突。

## 命令与状态

| 命令 | 说明 |
| --- | --- |
| `/fast` | 切换当前会话的开关 |
| `/fast on` | 开启；重复执行仍为开启 |
| `/fast off` | 停止本扩展添加 priority，不删除其他来源的档位 |
| `/fast status` | 查看开关、配置来源、适配情况和最近一次请求处理 |

开启且当前通道符合条件时，状态栏显示 `fast`；关闭或不适配时隐藏。自定义状态栏可能不展示该标记，以 `/fast status` 为准。

会话命令不写配置。切换模型保留开关，但清空最近请求观察；reload、新建、恢复、fork 会话或重启 Pi 后，重新读取全局配置并重置临时开关。

## 配置

默认配置路径为 `~/.pi/agent/extensions/openai-fast.json`。设置 `PI_CODING_AGENT_DIR` 时，使用该目录下的 `extensions/openai-fast.json`，不读取项目配置。

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
| `showStatus` | `true` | 是否显示 `fast` 标记；关闭不影响 priority 请求 |
| `excludeModels` | `[]` | 排除的模型 ID，精确匹配，不支持通配符或 `provider/model` 写法 |

字段可省略，文件缺失时使用默认值。未知字段、非法类型或读取／解析失败时会禁用 priority 注入并警告，不能用 `/fast on` 绕过；修正后执行 `/reload`。

## 适用范围与限制

仅用于 `openai-codex` provider 的 `openai-codex-responses` API，并且需要 ChatGPT OAuth 登录，不适用于 API-key 认证。配置必须有效、开关开启，且模型未被排除。

请求未指定服务档位时，扩展添加 `service_tier: "priority"`；已有档位时保持原样。因此 `/fast off` 只关闭本扩展的行为，不保证其他来源没有启用 priority。

本扩展不修改模型或 thinking，不额外调用网络，也不增加重试或自动降级。模型、账号和后端是否接受 priority，以服务端实际行为为准；后端错误及 Pi 自身的重试策略不变。

Pi 当前的扩展接口无法确认响应中的最终服务档位，所以 `/fast status` 将后端实际档位标为未知。不要把 `fast` 标记、响应速度或成功请求当作后端加速确认；费用与额度以 Pi 和服务端记录为准。
