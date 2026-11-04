# Fast

[English](./README.md) | [简体中文](./README.zh-CN.md)

Pi 扩展，用 `/fast` 为订阅模型开启加速通道：OpenAI / Codex 附加 `service_tier: "priority"`，Grok 4.7 路由至 Grok Build 的 `grok-4.7-build-fast`。默认关闭，可独立安装。

## 快速开始

先在 Pi 中用 `/login` 登录 ChatGPT 或 xAI OAuth 账号（不支持 API Key），再任选一种方式安装：

```bash
# 方式一：安装入口文件（保留目录全部源码）
pi install /absolute/path/to/fast/index.ts

# 方式二：复制目录到扩展目录（二选一，避免重复加载）
cp -R /absolute/path/to/fast ~/.pi/agent/extensions/fast
```

在 Pi 中启用：

```text
/reload
/fast on
/fast status
```

## 使用说明

### 命令与状态

| 命令 | 说明 |
| --- | --- |
| `/fast` | 切换当前 provider 开关 |
| `/fast on` | 开启 |
| `/fast off` | 关闭 |
| `/fast status` | 查看当前状态 |

- 输出单行 `Fast: on`、`Fast: off` 或 `Fast: unavailable (原因)`；`Fast: on` 仅代表本地已按加速策略发请求。
- `openai`、`openai-codex`、`xai` 的开关按 provider 独立保存在状态文件中，跨会话保留。
- 切到不支持的模型或认证方式时不修改请求；此时手动执行 `/fast` 会报不可用，并将该 provider 已保存的开启状态重置为关闭。

### 通道规则

| Provider | API | 模型范围 | 本地请求处理 |
| --- | --- | --- | --- |
| `openai` | `openai-responses` | 不限模型 ID | 未设置 `service_tier` 时注入 `"priority"`（保留已有值） |
| `openai-codex` | `openai-codex-responses` | 不限模型 ID | 未设置 `service_tier` 时注入 `"priority"`（保留已有值） |
| `xai` | `openai-responses` | 仅 `xai/grok-4.7` | 走 Grok Build 代理 `grok-4.7-build-fast`；会话记录与模型选择器保持 `xai/grok-4.7`，本地按目录单价 2 倍估算费用 |

若 Grok 代理因客户端版本过低返回 `426`，在配置中调高 `grokClientVersion` 即可。

### 配置文件

- 配置：`~/.pi/agent/extensions/fast.json`（只读）
- 状态：`~/.pi/agent/state/fast.json`（扩展自动维护）

设置 `PI_CODING_AGENT_DIR` 时均位于该目录下。配置示例（字段均可省略）：

```json
{
  "enabled": false,
  "showStatus": true,
  "grokClientVersion": "1.0.40"
}
```

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `enabled` | `false` | 尚未手动切换过开关时的初始默认值 |
| `showStatus` | `true` | 是否向状态栏发布 `fast` 标记 |
| `grokClientVersion` | `"1.0.40"` | 向 Grok Build 代理声明的客户端版本 |

配置文件存在未知字段或类型错误时，启动会报错并停用 Fast，修复后 `/reload` 恢复。
