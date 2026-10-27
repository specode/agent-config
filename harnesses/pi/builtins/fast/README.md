# Fast

Pi 扩展，用一个 `/fast` 命令为当前订阅模型开启加速通道：OpenAI / Codex 的 ChatGPT 订阅请求附加 `priority` 服务档位，Grok 4.7 走 Grok Build 的 `grok-4.7-build-fast` 通道。

**默认关闭，开启可能加快额度消耗。** `Fast: on` 只代表本地已按加速策略发请求，实际有没有加速取决于服务端。扩展可独立使用，不依赖其他插件或自定义状态栏。

## 快速开始

先在 Pi 里用 `/login` 登录 ChatGPT 或 xAI 订阅账号（Fast 不支持 API Key）。

保留本目录全部源码，直接安装入口文件：

```bash
pi install /absolute/path/to/fast/index.ts
```

或者把整个 `fast` 目录拷到 `~/.pi/agent/extensions/fast/`（两种方式二选一，不要同时用，以免重复加载）。

然后在 Pi 中执行：

```text
/reload
/fast on
/fast status
```

## 使用说明

### 命令与状态

| 命令 | 说明 |
| --- | --- |
| `/fast` | 切换当前 provider 的开关 |
| `/fast on` | 开启 |
| `/fast off` | 关闭 |
| `/fast status` | 查看当前状态，不切换 |

平时只输出一行 `Fast: on`、`Fast: off` 或 `Fast: unavailable (原因)`。如果在模型生成途中切换，或是碰到保存失败、通道切换未生效，会在后面跟一句简短提示（生成途中切换会从下一轮生效）。

- 开关按 provider（`openai`、`openai-codex`、`xai`）分开记在状态文件里，互不影响，重启或新建会话都保留。
- 切到不支持的模型或认证方式时，请求不做任何改动；如果这时候手动执行 `/fast` 切换，会直接报不可用，并把该 provider 之前存下的“开启”改成关闭（切回支持的模型后重新 `/fast on` 即可）。配置文件写错不会覆盖已保存的开关。
- 生效时会向状态栏发布 `fast` 标记，界面显不显示由状态栏决定，准确状态以 `/fast status` 为准。

### 各通道说明

#### OpenAI 与 Codex

要求使用 ChatGPT OAuth 登录，且 provider 与 API 对应如下（不限制具体模型 ID）：

| Provider | API |
| --- | --- |
| `openai` | `openai-responses` |
| `openai-codex` | `openai-codex-responses` |

请求里没填 `service_tier` 时会自动加上 `service_tier: "priority"`；如果其他地方已经设过 `service_tier` 则保留原值，不改模型本身（所以 `/fast off` 也不会删掉外部自带的 `priority`）。

#### Grok 4.7

要求使用 xAI OAuth 登录，且当前模型为 `xai/grok-4.7`（`openai-responses` API）。

开启后请求改走 Grok Build 代理的 `grok-4.7-build-fast` 通道，但会话记录和模型选择器里仍然保持 `xai/grok-4.7` 不变，不会把代理专用模型名写进会话文件或发往公开 xAI API，也不会把 API Key 发给代理。

代理会校验 Grok CLI 的客户端标识和版本号；如果服务端调高了最低版本要求并返回 `426`，去配置文件里把 `grokClientVersion` 改新即可。开启期间 Pi 按目录单价的 2 倍估算费用（仅供参考，不是真实账单）。

所有通道都不会额外发探测请求、隐式重试或自动降级。

### 配置文件

- 配置文件：`~/.pi/agent/extensions/fast.json`
- 状态文件：`~/.pi/agent/state/fast.json`

如果设了 `PI_CODING_AGENT_DIR`，两个文件都在该目录下。扩展只写状态文件，不改配置文件。

```json
{
  "enabled": false,
  "showStatus": true,
  "grokClientVersion": "1.0.40"
}
```

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `enabled` | `false` | 还没用命令切过开关时的默认值 |
| `showStatus` | `true` | 是否向状态栏发布 `fast` 标记（不影响请求） |
| `grokClientVersion` | `"1.0.40"` | 向 Grok Build 代理声明的客户端版本 |

字段都可以省略。如果配置文件读不到、有未知字段或类型不对，启动时会提示并停用 Fast，改好后 `/reload` 即可；状态文件损坏或写不进去时也会提示，当前会话里仍可临时切换。
