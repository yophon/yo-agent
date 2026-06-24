# yo-agent

一个自研的**通用 agent 引擎**（TypeScript / Node 单栈）。

一句话定位：一个 agent 内核（agent loop + 工具调用 + 上下文管理 + MCP），
**既能当编程 agent**（读写代码、跑命令、diff 审批，对标 Claude Code / Codex / opencode / pi），
**又能挂接聊天平台**（QQ / Telegram / Discord 等，对标 AstrBot / nanobot / openclaw）。

> 与 [`yo-aichat`](../yo-aichat) 的关系：yo-aichat 是 BYOK 对话 + 远程操控第三方 CLI agent 的客户端；
> yo-agent 是可被其 Go bridge 用 cursor-可恢复 JSON-RPC 驱动、也可独立运行的**自研 agent 本体**。

---

## 当前状态

🏗️ **Phase 1 · Slice A 完成（内核 turn 循环可离线跑通）** —— 见 [`docs/PHASE-1.md`](docs/PHASE-1.md)（Phase 0 协议骨架见 [`docs/PHASE-0.md`](docs/PHASE-0.md)）。

- 协议单一事实源 `@yo-agent/protocol` 冻结：`AgentEvent`（20 变体）+ JSON-RPC 方法表 + cursor/resume，zod 定义、导出 JSON Schema；与 yo-aichat `AgentEvent` 同构（可执行测试）。
- **`AgentKernel` turn 循环**（infer→tool→observe）+ 事件溯源 + 熔断 + `max_tokens` 续传 + 审批；`MemoryEventStore`、`InMemoryToolRegistry` + `read/write/ls`、`FakeProvider`、真实 `AnthropicProvider`（SSE 单测）。
- **headless CLI** 可端到端跑通；验证门全绿：`pnpm run check` = typecheck + gen:schema + **33 测试**。

竞品调研 15 份 + 横向综述见 [`docs/research/`](docs/research/)；全面设计见 [`docs/DESIGN.md`](docs/DESIGN.md)（14 章 + §15 实现补遗 + 8 ADR）。

## 仓库结构（pnpm workspace）

```
yo-agent/
├─ packages/
│  ├─ protocol/   # ★ 单一事实源：AgentEvent + JSON-RPC + cursor/resume（zod → TS + JSON Schema）
│  │  └─ schema/  #   生成的 JSON Schema（给 Go bridge 对接）
│  ├─ provider/   # Provider 抽象 + FakeProvider + AnthropicProvider
│  ├─ tools/      # ToolRegistry + 内置 read/write/ls（声明/执行分离）
│  ├─ store/      # MemoryEventStore（append-only EventLog）
│  └─ kernel/     # AgentKernel turn 循环 + LoopBreaker + Condenser
├─ apps/yo-agent/ # headless CLI
├─ docs/{DESIGN,PHASE-0,PHASE-1}.md + research/
└─ (Slice B：OpenAI/Gemini/DeepSeek adapter · SQLite 持久化 · TUI · yo.md)
```

## 快速开始

```bash
pnpm install        # 需 Node ≥ 20、pnpm 10
pnpm run check      # typecheck + 生成 JSON Schema + 跑测试（33 个）

# headless CLI（FakeProvider 演示，无需 key）
pnpm --filter @yo-agent/cli start -- -p "你的提问"
# 接真实 Anthropic：ANTHROPIC_API_KEY=sk-... pnpm --filter @yo-agent/cli start -- -p "..."
```

## 工具链

- **Node ≥ 20 / TypeScript ≥ 5 / pnpm 10**。
- Phase 0 为源码态 workspace（`exports` 指向 `src`，`tsc --noEmit` 类型检查 + vitest），无构建产物；
  构建链与可运行 CLI 入口在 Phase 1 搭建。
