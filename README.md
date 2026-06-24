# yo-agent

一个自研的**通用 agent 引擎**（TypeScript / Node 单栈）。

一句话定位：一个 agent 内核（agent loop + 工具调用 + 上下文管理 + MCP），
**既能当编程 agent**（读写代码、跑命令、diff 审批，对标 Claude Code / Codex / opencode / pi），
**又能挂接聊天平台**（QQ / Telegram / Discord 等，对标 AstrBot / nanobot / openclaw）。

> 与 [`yo-aichat`](../yo-aichat) 的关系：yo-aichat 是 BYOK 对话 + 远程操控第三方 CLI agent 的客户端；
> yo-agent 是可被其 Go bridge 用 cursor-可恢复 JSON-RPC 驱动、也可独立运行的**自研 agent 本体**。

---

## 当前状态

🏗️ **Phase 0 完成（协议与骨架）** —— 见 [`docs/PHASE-0.md`](docs/PHASE-0.md)。

- 协议单一事实源 `@yo-agent/protocol` 冻结：`AgentEvent`（20 变体）+ JSON-RPC 方法表 + cursor/resume，zod 定义、可导出 JSON Schema。
- 四核心接口冻结：`Provider` / `Tool` / `Surface` / `Condenser`。
- 与 yo-aichat `AgentEvent` 同构性 review 通过（可执行测试）。
- 验证门全绿：`pnpm run check` = typecheck + gen:schema + 15 测试。

竞品调研 15 份 + 横向综述见 [`docs/research/`](docs/research/)；全面设计见 [`docs/DESIGN.md`](docs/DESIGN.md)（14 章 + §15 实现补遗 + 8 ADR）。

## 仓库结构（pnpm workspace）

```
yo-agent/
├─ packages/
│  ├─ protocol/   # ★ 单一事实源：AgentEvent + JSON-RPC + cursor/resume（zod → TS + JSON Schema）
│  │  └─ schema/  #   生成的 JSON Schema（给 Go bridge 对接）
│  ├─ provider/   # Provider 抽象（冻结接口）
│  ├─ tools/      # 工具系统：声明/执行分离（冻结接口）
│  ├─ store/      # append-only EventLog（冻结接口）
│  └─ kernel/     # 内核 + 接入层契约（冻结接口）
├─ docs/{DESIGN,PHASE-0}.md + research/
└─ (Phase 1 起：kernel 实现 / provider adapter / apps/yo-agent CLI)
```

## 快速开始

```bash
pnpm install        # 需 Node ≥ 20、pnpm 10
pnpm run check      # typecheck + 生成 JSON Schema + 跑测试
```

## 工具链

- **Node ≥ 20 / TypeScript ≥ 5 / pnpm 10**。
- Phase 0 为源码态 workspace（`exports` 指向 `src`，`tsc --noEmit` 类型检查 + vitest），无构建产物；
  构建链与可运行 CLI 入口在 Phase 1 搭建。
