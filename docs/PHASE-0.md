# Phase 0 —— 协议与骨架（已完成）

> 对应 [`DESIGN.md`](DESIGN.md) §13 Phase 0。本阶段**不写内核逻辑**，只冻结契约与接口，
> 让后续每个包都对着稳定的协议开发。验证门 = `tsc` 类型检查 + vitest 协议测试 + JSON Schema 可生成。

## 交付物

| 包 | 角色 | 内容 |
|---|---|---|
| **`@yo-agent/protocol`** | 单一事实源 | `AgentEvent` sealed union（20 变体）+ `EventEnvelope` + `StopReason`/`ToolKind`/`Effort` 等枚举 + JSON-RPC 方法表 + cursor/resume 参数 + `PROTOCOL_VERSION`/`EVENTLOG_SCHEMA_VERSION`。用 **zod** 定义 → 同时得到 TS 类型、运行时校验、JSON Schema 导出（给 Go bridge）。 |
| **`@yo-agent/provider`** | 冻结接口 | `Provider` / `ChatRequest` / `ProviderEvent` / `ProviderCapabilities` / `ModelInfo`。`effort` 轴注明译为 `output_config.effort`（§15.4）。 |
| **`@yo-agent/tools`** | 冻结接口 | `ToolDescriptor`(声明) + `ToolExecutorRef`(执行) 分离、`AvailabilityExpr`、`ToolRegistry`、`ToolContext`。 |
| **`@yo-agent/store`** | 冻结接口 | `EventStore`（append-only）+ `Checkpoint` + `SessionRow` + `EVENTLOG_SCHEMA_VERSION`。 |
| **`@yo-agent/kernel`** | 冻结接口 | `Kernel` / `Condenser` / `LoopBreaker` / `ApprovalGate` / `SubagentManager` / `Surface` / `PlatformAdapter` / `UnifiedMessage`。 |

生成的 JSON Schema 在 [`packages/protocol/schema/`](../packages/protocol/schema/)（12 份，draft-07）——这是 Go bridge 端对接的契约源。

## 退出标准核对

| 标准（DESIGN §13）| 状态 | 凭据 |
|---|---|---|
| 协议 schema 冻结 | ✅ | `pnpm gen:schema` 产出 12 份 JSON Schema |
| EventLog `schema_version` 入库 | ✅ | `EVENTLOG_SCHEMA_VERSION = 1`，`contracts.test.ts` 断言 |
| 与 yo-aichat `AgentEvent` 同构性 review 通过 | ✅ | `protocol/test/homomorphism.test.ts`（见下表）|
| 四接口冻结（Provider/Tool/Surface/Condenser）| ✅ | `kernel/test/contracts.test.ts` 用 `satisfies` 证明可实现 |

## 同构性 review（yo-aichat AgentEvent → yo-agent kind）

yo-aichat 的 sealed `AgentEvent` 共 **14 变体**（实测自 `yo-aichat/packages/core/lib/src/agent_event.dart`）。
yo-agent 是其**严格超集**——仅两处改名，另多出 6 个内核能力事件。bridge 的 `YoAgentAdapter` 因此几乎是恒等映射。

| yo-aichat | → yo-agent | 备注 |
|---|---|---|
| SessionStarted / AssistantText / Reasoning | 同名 | |
| ToolCallStarted / ToolCallOutput / ToolCallCompleted | 同名 | |
| FileChanged / ApprovalRequested / ApiRetry | 同名 | |
| TurnCompleted / TurnFailed / BackgroundProcess | 同名 | |
| **TodoUpdated** | **Todo** | 改名 |
| **AgentErrorEvent** | **Error** | 改名 |
| —— | TurnStarted / Plan / SubagentStarted / SubagentResult / ContextCompacted / UsageUpdate | yo-agent 独有（内核更丰富）|

## 本地验证

```bash
pnpm install          # node ≥ 20, pnpm 10
pnpm run check        # = typecheck + gen:schema + test
# 或分开：
pnpm run typecheck    # tsc -p tsconfig.json（源码态包，paths→src，noEmit）
pnpm run gen:schema   # 重新生成 packages/protocol/schema/*.json
pnpm run test         # vitest：15 个测试（协议校验 + 同构 + 接口可实现性）
```

## 不在 Phase 0（→ 后续阶段）

- **Kernel turn 循环 / EventLog SQLite 实现 / Provider 5 adapter** → Phase 1。
- **RpcSurface（JSON-RPC over TLS）+ 与 yo-aichat bridge 联调** → Phase 2。
- 构建产物（dist/）与可运行 CLI 入口（`apps/yo-agent`）也留到 Phase 1——Phase 0 是源码态 workspace（`exports` 指向 `src`），无运行入口，故只做类型检查不出包。
