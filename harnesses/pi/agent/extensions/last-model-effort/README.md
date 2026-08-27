# Pi last-model-effort

让每个模型自动记住最近实际使用的 thinking / reasoning effort，并让新建 Pi 会话恢复最近模型。

## 行为

- 每次主动调整 effort 后，按 `provider/model` 记录；切换回来时自动恢复该模型上次的档位。
- 普通 `pi` 新会话和 `/new`：恢复最近模型及其已记忆 effort。
- `pi -c`、`/resume`、fork、clone、reload：先保留目标会话自己的模型与 effort，并把实际档位更新为该模型的最新记忆。
- 显式 `--model`、`--provider`、`--thinking`：启动时命令行配置优先。
- `enabledModels` / `--models` 限定了 scoped models 时，不恢复范围外的模型；模型条目固定的 effort 在切换时优先。
- 模型不可用或认证失效时保留 Pi 当前选择，并显示警告。
- effort 会通过 Pi 原生 `setThinkingLevel()` 按当前模型能力自动收敛，收敛后的实际档位会成为新记忆。
- 该行为适用于 Pi 的 TUI、RPC、JSON 和 print 模式。
- `PI_SUBAGENT_CHILD=1` 的 Pi 子 Agent 不参与恢复或持久化，避免其固定 effort（如 reviewer 的 `high`）污染主会话记忆。

插件监听 `model_select` 和 `thinking_level_select`。thinking 变化先延迟到下一个事件循环提交：如果紧接着发生模型切换，就把它识别为 Pi 切换模型产生的中间状态并丢弃，再恢复目标模型记忆。状态更新使用跨进程锁、按时间戳合并和原子替换，避免多个主 Pi 进程写入不同模型时互相覆盖：

```text
~/.pi/agent/state/last-model-effort.json
```

状态格式为版本 2，包含 `lastSelection` 和 `effortByModel`；现有版本 1 单记录会在下次写入时自动迁移。可用 `PI_LAST_MODEL_EFFORT_STATE` 覆盖状态文件路径，主要用于测试或隔离运行。状态文件不属于配置仓库托管范围，也不会自动改写 Pi 的 `modelThinkingLevels`。

## 验证

```bash
node --test \
  harnesses/pi/agent/extensions/last-model-effort/core.test.ts \
  harnesses/pi/agent/extensions/last-model-effort/event-coordinator.test.ts \
  harnesses/pi/agent/extensions/last-model-effort/state-store.test.ts

pi --no-extensions --offline \
  -e ./harnesses/pi/agent/extensions/last-model-effort/index.ts \
  --list-models gpt-5.6-sol
```
