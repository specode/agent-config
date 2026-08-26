# Pi last-model-effort

让新建 Pi 会话自动恢复最近实际使用的模型和 thinking / reasoning effort。

## 行为

- 普通 `pi` 新会话和 `/new`：恢复最近模型与 effort。
- `pi -c`、`/resume`、fork、clone、reload：保留目标会话自己的模型与 effort，不强行覆盖。
- 显式 `--model`、`--provider`、`--thinking`：命令行配置优先。
- `enabledModels` / `--models` 限定了 scoped models 时，不恢复范围外的模型；模型条目固定的 effort 优先。
- 模型不可用或认证失效时保留 Pi 当前选择，并显示警告。
- effort 会通过 Pi 原生 `setThinkingLevel()` 按当前模型能力自动收敛。
- 该行为适用于 Pi 的 TUI、RPC、JSON 和 print 新会话；显式 CLI 参数仍具有最高优先级。
- `PI_SUBAGENT_CHILD=1` 的 Pi 子 Agent 不参与恢复或持久化，避免其固定 effort（如 reviewer 的 `high`）污染主会话的最近选择。

插件监听 `model_select` 和 `thinking_level_select`，把最近状态原子写入；恢复阶段产生但被其他扩展延迟的 thinking 事件会被识别并忽略，避免覆盖仍应保留的历史模型：

```text
~/.pi/agent/state/last-model-effort.json
```

可用 `PI_LAST_MODEL_EFFORT_STATE` 覆盖状态文件路径，主要用于测试或隔离运行。状态文件不属于配置仓库托管范围。

## 验证

```bash
node --test harnesses/pi/agent/extensions/last-model-effort/core.test.ts

pi --no-extensions --offline \
  -e ./harnesses/pi/agent/extensions/last-model-effort/index.ts \
  --list-models gpt-5.6-sol
```
