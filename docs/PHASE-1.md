# Phase 1 —— 内核 + 编程 CLI MVP

> 对应 [`DESIGN.md`](DESIGN.md) §13 Phase 1。本阶段按"零网络风险"分两片交付。
> **Slice A（本次，已完成）**：完全可离线验证的内核纵切。**Slice B（后续）**：补齐多 provider、TUI、yo.md。

## Slice A 已交付（离线可验证核心）

| 包 | 实现 | 说明 |
|---|---|---|
| `@yo-agent/store` | **`MemoryEventStore`** | append-only + cursor 单调 + `read(fromCursor)` resume + parentId DAG |
| `@yo-agent/kernel` | **`AgentKernel`** | turn 循环（infer→tool→observe）+ 事件溯源（每 emit 分配 cursor、落 EventStore、fan-out）+ `max_tokens` 自动续传 + 中断 |
| | **`HistoryLoopBreaker`** | 历史窗 generic_repeat 熔断（引擎层强制，ok/warn/break） |
| | **`NoopCondenser`** | 占位（真正压缩见 Slice B / §5.1） |
| `@yo-agent/provider` | **`FakeProvider`** | 脚本化确定性 provider，驱动内核测试 |
| | **`AnthropicProvider`** | 真实 BYOK adapter：SSE 解码 + body 构造；`effort→output_config.effort`（§15.4，不发 budget_tokens / temperature）；live 路径需 key（计费），本阶段仅 SSE/body 单测 |
| `@yo-agent/tools` | **`InMemoryToolRegistry`** + `read/write/ls` | 声明/执行分离 + availability + 稳定排序 + L0 路径保护（confine cwd） |
| `apps/yo-agent` | **headless CLI** | 无 `ANTHROPIC_API_KEY` 用 FakeProvider 演示；有 key 接真实模型 |

**验证门全绿**：`pnpm run check` —— typecheck 0 错误 + 12 份 JSON Schema + **33 个测试（8 文件）**。
内核测试覆盖：纯文本 turn、工具调用事件溯源、死循环熔断、`max_tokens` 续传、审批通过/拒绝、resume。

## 运行

```bash
pnpm install
pnpm run check                                   # typecheck + gen:schema + 33 测试

# CLI（FakeProvider 演示，无需 key）
pnpm --filter @yo-agent/cli start -- -p "你的提问"

# 接真实 Anthropic（流式编程对话）
ANTHROPIC_API_KEY=sk-... pnpm --filter @yo-agent/cli start -- -p "用 ts 写个快排"
```

## Slice B 待办（补齐 Phase 1 §13 退出标准）

- **Provider**：OpenAI Responses / OpenAI Chat·兼容 / Gemini / DeepSeek 四个 adapter + 双轨 tool-calling（native + prompt-shim）+ 模型目录。
- **存储**：`SqliteEventStore`（`better-sqlite3` 或 `node:sqlite`）落盘持久化 + checkpoint（shadow-git）。
- **CliSurface**：Ink TUI（差量渲染）+ headless `--mode jsonl`；交互审批 UX。
- **上下文**：真正的 `Condenser`（保首+保尾+中段摘要 + 标识符保留，§5.1）+ yo.md/AGENTS.md 约定文件加载（§5.2）。
- **退出标准**：CLI 多 provider 流式编程对话 + 工具调用 + 审批 + resume + 熔断端到端跑通（真机）。
