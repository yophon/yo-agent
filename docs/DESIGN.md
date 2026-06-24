# yo-agent 架构设计

> **范围**：单进程 self-host 起步，所有边界按"一个内核 × 多 surface × 多 provider × 多平台"建模。yo-agent 是 **TypeScript/Node 单栈通用 agent 引擎**：同一个内核既能当编程 agent（读写代码 / 跑命令 / diff 审批，对标 Claude Code / Codex / opencode / pi），又能挂接 QQ / Telegram / Discord 等聊天平台（对标 AstrBot / nanobot / openclaw），还能被 **任意远端客户端 / IDE（ACP）/ Claude Code（MCP）** 用 cursor-可恢复的 JSON-RPC/JSONL 协议驱动或集成（对标 codex app-server / pi `--mode rpc`）。
>
> _注：早期设计曾以"被 yo-aichat 的 Go bridge 当第四类 agent 驱动"为命脉目标；**yo-aichat（Flutter 远程操控客户端）已废弃**，该耦合已移除——可恢复协议保留并泛化为通用远端驱动协议，鉴权改为 yo-agent 自带（§6 / §9.3 / §13 Phase 2）。_
>
> **北极星（一句话架构）**：**一条 append-only 的 sealed `AgentEvent` 事件流是唯一事实源；内核只跑一个可熔断、可中断、可 resume(cursor) 的 turn 循环；工具/provider/surface/协议全部围绕这条流做声明式插拔——编程态与聊天态是同一内核换 policy，不是两套代码。**
>
> **三句话定全局**：(a) `Provider` 把 Anthropic / OpenAI / Gemini / DeepSeek / 任意 OpenAI 兼容端点归一成一条 `Stream<ProviderEvent>` + 双轨工具调用（native function-calling 优先，prompt-and-parse 回退）；(b) `Kernel` 把"组装上下文 → 调 provider → 执行工具 → 审批 → 注入 observation → 熔断/压缩/恢复"归一成一条 append-only `Stream<AgentEvent>`，落盘 SQLite 事件日志，支持 `resume(cursor)`；(c) `Surface`（CLI / 聊天平台 / IDE-via-ACP / RPC（通用远端驱动）/ MCP-server）只消费同一条 `AgentEvent` 流并回灌输入，**永不按内核内部分支**。

---

## 0. 设计目标与非目标

### 0.1 目标（must）

1. **单内核双形态**：编程 agent 与聊天 bot 共享同一 turn 循环、同一事件流、同一工具系统、同一 provider 抽象。形态差异收敛为**注入不同 policy / 工具集 / system 约定文件**，而非 fork 代码（借鉴 OpenClaw `kind=both`；避开 Claude Code「Channels 仍以 CLI 会话为主控」的桥接式 IM 体验）。
2. **可恢复协议一等公民**：从第一天就说一套 sealed 事件流 + JSON-RPC 方法集，支持 `resume(cursor)`、`turn/steer`、`turn/interrupt`、协议级审批。**这套协议同时满足"被任意远端客户端 / IDE / 编排器驱动"和"独立 CLI / 挂 IM"**（借鉴 codex app-server 三层事件流 + pi `--mode rpc`）。
3. **BYOK 多 provider**：直连 Anthropic / OpenAI（Responses + Chat）/ Gemini / DeepSeek / 任意 OpenAI 兼容端点，**不经第三方后端**（避开 Codex 砍掉 chat/completions、Gemini CLI 强锁单一生态的反例）。
4. **TS/Node 单栈**：Node ≥ 20，TS ≥ 5，pnpm workspace monorepo。
5. **可扩展内核**：主循环稳定，所有横切关注点（审批 / 审计 / 记忆 / 拦截 / 平台适配）做成生命周期 hook 与声明式插件，**不闭源不锁死 loop**（避开 Claude Code 主循环不可定制的反例）。
6. **安全可控**：多档权限 + 协议化审批 + 工具沙箱 + 危险命令防护 + 注入防护 + yo-agent 自带 ed25519 + 配对码设备鉴权。

### 0.2 非目标（won't / not-now）

- **不做自建云中继 / 托管 SaaS**：与 yo-aichat「无云中继」一致；多用户/团队留接缝（§8.6 思路），不在 MVP 实现。
- **不追求 OS 级强沙箱完备性**：Node 现实下做不到 Codex 的 seatbelt/landlock 内核级隔离；采用"子进程权限白名单 + 可选容器 + checkpoint 回滚"组合（§3.4 决策），明示残余风险。
- **不自研 provider SDK 全家桶**：provider 抽象层薄封装官方/社区 SDK，不重写 SSE 协议栈（但 SSE 解析自己控，避免缓冲坑）。
- **不做向量长期记忆（MVP）**：长期记忆用结构化文件 + 按需注入（借鉴 .goosehints / MEMORY.md 双轨；RAG 留 Phase N）。
- **不强绑单一 runtime**：内核纯 Node（不绑 Bun / Deno），避开 opencode「Effect-TS + Bun 强绑、贡献门槛高」的反例。

### 0.3 一句话架构（再次强调）

> **AgentEvent 是脊柱，Kernel 是唯一会写这条脊柱的人，Surface 只读这条脊柱并往里灌 prompt/approval，Provider/Tool/Plugin 是脊柱旁可热插拔的声明式器官。**

---

## 1. 总体架构（分层）

```
┌──────────────────────────────── Surfaces（接入层，只消费 AgentEvent 流）─────────────────────────────┐
│  CliSurface     RpcSurface(JSON-RPC/JSONL)   ChatSurface(QQ/TG/Discord)   AcpSurface(IDE)   McpServer  │
│  (TUI/headless)  ★给 yo-aichat Go bridge      (Transport+Adapter 二层)      (Zed/JetBrains)   (被编排)   │
│       │                │                          │                          │              │           │
│       └────────────────┴──────────┬───────────────┴──────────────────────────┴──────────────┘           │
│                                    │  register(surface)  ── 同一条 Stream<AgentEvent> + submitInput()    │
└────────────────────────────────────┼────────────────────────────────────────────────────────────────────┘
                                      ▼
┌──────────────────────────────── Protocol（事件/方法单一事实源，schema-gen）────────────────────────────┐
│  AgentEvent sealed union   JSON-RPC 方法表   StopReason 枚举   cursor/resume 语义   ApprovalRequest      │
│  与 yo-aichat AgentEvent 同构；TS 类型 + JSON Schema；可生成 Go 端给 bridge 对接                          │
└────────────────────────────────────┬────────────────────────────────────────────────────────────────────┘
                                      ▼
┌──────────────────────────────────────── Kernel（内核，唯一写事件流）────────────────────────────────────┐
│  SessionManager   TurnLoop(infer→tool→observe)   Condenser   LoopBreaker   ApprovalGate   SubagentMgr    │
│  ContextAssembler(AGENTS.md/yo.md + memory + skills)   PolicyEngine(SecurityAnalyzer×ConfirmationPolicy) │
│        │                    │                       │                    │                  │             │
│        ▼                    ▼                       ▼                    ▼                  ▼             │
└────────┼────────────────────┼───────────────────────┼────────────────────┼──────────────────┼─────────────┘
         ▼                    ▼                       ▼                    ▼                  ▼
┌────────────────┐  ┌──────────────────────┐  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Tools         │  │  Provider            │  │  Store       │  │  Plugins/Hooks   │  │  Sandbox/Exec    │
│  内置+MCP+插件  │  │  BYOK 5+ 家归一       │  │  SQLite      │  │  生命周期钩子     │  │  子进程隔离/容器  │
│  声明/执行分离  │  │  双轨 tool calling    │  │  EventLog DAG│  │  skills/recipes  │  │  权限白名单       │
│  ToolRegistry  │  │  models.dev 目录      │  │  checkpoint  │  │  subagent 委派    │  │  checkpoint 回滚 │
└────────────────┘  └──────────────────────┘  └──────────────┘  └──────────────────┘  └──────────────────┘
```

**六层职责**：

| 层 | 职责 | 关键借鉴 / 避开 |
|---|---|---|
| **Kernel** | 唯一写 `AgentEvent` 流；跑 turn 循环；管 session/turn/step 状态机、压缩、熔断、审批门、子 agent。 | 借鉴 OpenHands 事件溯源、Claude Code/Codex hook 矩阵；避开 Claude Code 闭源不可改 loop。 |
| **Tools** | 声明/执行分离的工具系统；内置 + MCP + 插件三源统一注册；按 availability 条件动态显隐。 | 借鉴 OpenClaw `ToolDescriptor+ExecutorRef`、AstrBot/LangBot 多源统一注册表。 |
| **Provider** | BYOK 多家归一；流式；双轨 function calling；模型目录；用量计费。 | 借鉴 opencode（Vercel AI SDK + models.dev）、Cline `@cline/llms`；避开 Codex/Gemini 锁单一 wire format。 |
| **Surfaces** | CLI / RPC / 聊天平台 / ACP / MCP-server，只消费事件流回灌输入。 | 借鉴 NoneBot2 Transport+Adapter 二层、Codex app-server agent-as-server。 |
| **Protocol** | 事件/方法单一事实源；schema-gen 出 TS + 多语言 binding（给任意客户端）。 | 借鉴 codex app-server Thread/Turn/Item、pi `--mode rpc`、ACP。 |
| **Store** | SQLite append-only EventLog（DAG，id+parentId）+ checkpoint + 配置 + 用量。 | 借鉴 OpenHands EventLog、pi JSONL DAG、OpenClaw SQLite-only。 |

---

## 2. Agent 内核（Kernel）

### 2.1 主循环：turn / step 模型

内核是经典 **infer → tool → observe 单循环 ReAct**（业界共识最简、最好维护——pi/Goose/Gemini 都是；plan/并发/子 agent 全做成内核之上的可选机制，借鉴 pi「primitives-not-features」），但叠加 **事件溯源**（OpenHands）使每一步状态变更都 append-only 落盘。

**三层概念**（直接对齐 codex app-server 的 Thread/Turn/Item，便于远端客户端对接）：

- **Session**（≈ codex Thread）：`(owner, surface, workspace/project, agentProfile)` 维度的长生命周期实体，跨连接、跨重启、跨 resume 存活。
- **Turn**：一次用户 prompt 触发的"推理直到停止"的完整往返，可含多个 step。
- **Step**：一次"调 provider → 执行 0..N 个 tool → 注入 observation"。

```
        submitInput(prompt, idemKey)
                │
                ▼
   ┌─────────── Turn 开始 ──────────────────────────────────────────┐
   │  emit(TurnStarted)                                              │
   │     │                                                           │
   │     ▼   ┌─────────────── Step 循环 ──────────────────────────┐  │
   │  ContextAssembler:                                          │  │
   │   yo.md/AGENTS.md(软约束) + memory + skills摘要 + 工具列表 + 历史 │  │
   │     │  (静态前缀固定→最大化 prompt cache，借鉴 Codex)            │  │
   │     ▼                                                        │  │
   │  Provider.stream() ──emit──▶ AssistantText/Reasoning deltas │  │
   │     │                                                        │  │
   │     ├─ 无 tool_call & stop ─────────▶ break(StopReason)      │  │
   │     ▼ 有 tool_call                                           │  │
   │  LoopBreaker.check(toolCall) ─死循环?─▶ emit(Error)+中止     │  │
   │     │                                                        │  │
   │     ▼                                                        │  │
   │  PolicyEngine: SecurityAnalyzer(risk) × ConfirmationPolicy  │  │
   │     ├─ 需审批 ─▶ ApprovalGate ─emit(ApprovalRequested)──▶ 等  │  │
   │     │              await approval.decide(allow/deny/modify)  │  │
   │     ▼ allow                                                  │  │
   │  ToolExecutor(sandbox) ─emit─▶ ToolCallStarted/Output/Done  │  │
   │     │   大输出写盘只回路径(借鉴 nanobot 50KiB)                  │  │
   │     ▼                                                        │  │
   │  注入 observation 回历史 → checkpoint                        │  │
   │     │                                                        │  │
   │  ContextManager.maybeCompact() ─超阈值~80%?─▶ Condenser      │  │
   │     └──────────────────── 回 Step 循环 ─────────────────────┘  │
   │     │                                                           │
   │     ▼  emit(TurnCompleted{usage,cost}) | TurnFailed{error}     │
   └────────────────────────────────────────────────────────────────┘
```

每个 `emit(...)` 都：① 分配单调递增 `cursor`；② append 进 SQLite EventLog（带 `parentId` 形成 DAG）；③ fan-out 给所有订阅该 session 的 surface。**这是 resume/重放/审计三件套的根（OpenHands 模式）。**

### 2.2 sealed 事件类型表（TS 类型）

`AgentEvent` 是 protocol 包的 sealed union 单一事实源（schema-gen 出 JSON Schema + 多语言 binding），任意客户端可据此零成本归一 yo-agent 的事件流（对标 bridge 归一 codex/claude/pty 的范式）。

```typescript
// protocol/src/events.ts —— 单一事实源（schema-gen 出 JSON Schema 给任意客户端）
type Cursor = number;          // 服务端/本地单调递增
type Id = string;              // ULID

interface EventEnvelope<T extends AgentEvent = AgentEvent> {
  sessionId: Id;
  cursor: Cursor;              // 单调递增，resume 锚点
  parentId: Cursor | null;     // DAG：聊天 reply / fork 映射到此（借鉴 pi JSONL DAG）
  turnId: Id | null;
  ts: number;                  // server-time 基准（避免客户端时钟漂移）
  event: T;
}

type AgentEvent =
  | { kind: 'SessionStarted'; externalId: Id; model: string; tools: string[]; workspacePath: string; permissionMode: PermissionMode; profile: string }
  | { kind: 'TurnStarted'; turnId: Id; promptIdemKey: string }
  | { kind: 'AssistantText'; delta?: string; full?: string }
  | { kind: 'Reasoning'; delta?: string; text?: string }              // thinking / reasoning
  | { kind: 'ToolCallStarted'; id: Id; name: string; toolKind: ToolKind; summary: string; input: unknown }
  | { kind: 'ToolCallOutput'; id: Id; chunk: string; exitCode?: number }
  | { kind: 'ToolCallCompleted'; id: Id; status: 'ok' | 'error'; truncatedToPath?: string }
  | { kind: 'FileChanged'; path: string; changeKind: 'create' | 'edit' | 'delete' | 'rename' }
  | { kind: 'Todo'; items: TodoItem[] }
  | { kind: 'Plan'; steps: PlanStep[] }                               // 借鉴 ACP AgentPlan
  | { kind: 'ApprovalRequested'; requestId: Id; tool: string; input: unknown; risk: RiskLevel; suggestions: ApprovalSuggestion[] }
  | { kind: 'SubagentStarted'; childSessionId: Id; label: string; model: string }
  | { kind: 'SubagentResult'; childSessionId: Id; summary: string }   // 只回摘要，借鉴 Claude Code Explore
  | { kind: 'ContextCompacted'; fromCursor: Cursor; toCursor: Cursor; tokensSaved: number }
  | { kind: 'ApiRetry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { kind: 'BackgroundProcess'; procId: Id; label: string; status: 'running' | 'exited'; exitCode?: number }
  | { kind: 'UsageUpdate'; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd?: number }
  | { kind: 'TurnCompleted'; stopReason: StopReason; usage: Usage; costUsd?: number }
  | { kind: 'TurnFailed'; error: ErrorInfo }
  | { kind: 'Error'; message: string };

// ACP 对齐的 9 种工具语义标签（取代自定义字符串，便于 IDE / IM 统一渲染）
type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

// 借鉴 ACP StopReason 枚举（任何前端语义一致）
type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_steps' | 'tool_budget_exceeded'
                | 'loop_detected' | 'interrupted' | 'refusal' | 'error';

type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';
type PermissionMode = 'read-only' | 'supervised' | 'autonomous';
```

**设计决策**：
- 事件**对外只暴露 `TurnCompleted`/`TurnFailed`** 两个完成态（与 yo-aichat 一致），内部多种停止原因收敛到 `StopReason` 枚举（借鉴 ACP）。
- `Reasoning` / thinking 单独建模，便于 IM 端折叠、IDE 端展开。
- `ToolCallCompleted.truncatedToPath`：大输出写盘只回路径（nanobot 50KiB 阈值），事件流不塞全文。

### 2.3 停止条件与熔断

**横向调研的硬共识：所有有自主能力的实现都有 loop 熔断，且不能依赖 LLM 自识别死循环——必须在引擎层做**（OpenClaw 4 模式 + 30 历史窗 + 30 硬截断；opencode DOOM_LOOP=3；LangBot 128 轮；Goose MAX_TURNS=1000）。

`LoopBreaker`（直接采纳 OpenClaw 四模式 + 历史窗设计）：

```typescript
interface LoopBreaker {
  // 维护最近 N 条 tool 调用历史窗（默认 30，借鉴 OpenClaw TOOL_CALL_HISTORY_SIZE）
  check(call: ToolCall): 'ok' | 'warn' | 'break';
}
// 四种检测模式（OpenClaw）：
//   generic_repeat       —— 同 tool + 同 input 连续重复
//   unknown_tool_repeat  —— 反复调不存在的工具
//   poll_no_progress     —— 轮询类工具无状态变化
//   ping_pong            —— A↔B 两工具往返振荡
// WARN_THRESHOLD=10（注入提醒），BREAK 触发 emit(Error)+StopReason='loop_detected'
```

多重硬上限（叠加，引擎层强制）：
- `maxStepsPerTurn`（默认 128，借鉴 LangBot `MAX_TOOL_CALL_ROUNDS`）；
- `tokenBudgetPerTurn`：per-turn token 预算追踪，耗尽中止（借鉴 Codex 0.142 token 预算，把意外账单从事后变实时阻断）；
- `wallClockTimeout`：整 turn 硬超时兜底。

### 2.4 错误、中断与恢复

| 场景 | 内核行为 | 借鉴 |
|---|---|---|
| **provider 流中途失败（已吐 token）** | 保留 partial + `emit(Error)`，**不自动重试**（避免双计费）；429/5xx/529/network/timeout 才退避重试（遵守 `Retry-After`）。 | yo-aichat §6.6 |
| **refusal**（`stop_reason:'refusal'`） | **丢弃 partial**（与普通 mid-stream error 区分），`StopReason='refusal'`。 | yo-aichat / Anthropic |
| **用户中断**（`turn/interrupt`） | 取消 in-flight provider 请求 + 杀当前 tool 子进程（非 long-running）；`StopReason='interrupted'`；状态机回 IDLE。 | Codex `turn/interrupt` |
| **mid-turn steer**（`turn/steer`） | 当前 step 的 tool 执行完后，把 steer 文本插入历史再继续（不打断正在跑的 tool）；follow-up 模式则全部完成后追加。 | pi steer/follow-up、Codex `turn/steer` |
| **进程崩溃 / 重启** | 从 SQLite EventLog 末尾 `resume(cursor)` 重放恢复 session 状态（确定性重放）。 | OpenHands |
| **死循环** | LoopBreaker BREAK，见 §2.3。 | OpenClaw |

**resume 语义两分**（借鉴 ACP / Codex / opencode）：
- `session/resume(cursor)`：**带历史**——从 cursor 之后重放/续接（默认）。
- `session/reconnect(cursor)`：**无历史重连**——只续实时流，不重放（IM 长会话省带宽）。

### 2.5 子 agent 模型

**默认场景**：探索型任务（读大量文件 / 搜索 / 长日志）→ spawn child agent（独立上下文、独立工具集），**只把 `SubagentResult{summary}` 注入主 session，防主上下文污染**（Claude Code Explore / Gemini / Cline Boomerang 的共识；IM 场景预算更紧，尤其需要）。

```typescript
interface SubagentManager {
  spawn(opts: {
    parentSessionId: Id;
    profile: string;            // 声明式 mode/recipe（工具白名单 + 独立 prompt + 绑定 model）
    task: string;
    mode: 'foreground' | 'background';
    model?: string;             // 子 agent 可换便宜模型（如 explore 用 haiku）
  }): Promise<{ childSessionId: Id }>;
}
```

三个关键决策：
1. **进程/Worker 隔离**：子 agent 跑在 `worker_threads`（默认）或 `child_process`（需独立 OS 权限时），**子任务崩溃不拖垮主循环**（Goose / OpenClaw lane 共识）。
2. **异步 steering 注入**：background 子 agent 完成后，结果进 steering queue，在 parent 下一个 step 自然注入，**不阻塞主 turn**（OpenClaw steering queue / opencode synthetic 消息）。
3. **权限只收紧不放宽**：子 session policy 从 parent 派生，`deriveSubagentPolicy` 只能缩紧（opencode `deriveSubagentSessionPermission`）。
4. **声明式 profile**：子 agent 用 YAML/MD recipe 定义（§8.3），行为可版本控制（Roo mode / Goose Recipes）。

---

## 3. 工具系统（Tools）

### 3.1 声明 / 执行分离（核心架构决策）

**采纳 OpenClaw `ToolDescriptor + ToolExecutorRef` 分离**，因为 yo-agent 要"既编程又聊天、工具集动态切换"——若在主循环写 if-else 判断哪些工具可用，必然膨胀失控。工具是否进入 LLM 上下文完全由声明式 `availability` 表达式决定。

```typescript
interface ToolDescriptor {
  name: string;
  kind: ToolKind;                          // ACP 9 种语义标签之一
  description: string;
  inputSchema: JSONSchema7;                // function-calling schema
  owner: 'core' | 'plugin' | 'mcp';        // 三源统一（AstrBot/LangBot 验证过）
  availability: AvailabilityExpr;          // allOf/anyOf 组合 auth/config/env/context 条件
  approval: 'always' | 'risk-based' | 'never';
}

interface ToolExecutorRef {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;  // 流式进度
}

// AvailabilityExpr：声明式动态显隐（OpenClaw）
type AvailabilityExpr =
  | { allOf: AvailabilityExpr[] }
  | { anyOf: AvailabilityExpr[] }
  | { surface: SurfaceKind }               // 如 fs 工具仅在 CLI/编程态显隐
  | { profileHasTool: string }
  | { configFlag: string }
  | { always: true };
```

`ToolRegistry` 是**多源统一注册表**（AstrBot FunctionToolManager / LangBot 4-Loader 验证过的生产范式）：内置工具、MCP 工具、插件工具走同一接口注册，agent loop 对接入方式透明。组装 prompt 时 `registry.resolveAvailable(ctx)` 才 evaluate availability，得到当前可见工具集。

### 3.2 内置工具集

对齐 Claude Code / nanobot / openclaw 的"够用"内置集（不靠 MCP 才能动文件，借鉴 nanobot servers/system）：

| 工具 | kind | 说明 | 借鉴 |
|---|---|---|---|
| `read` | read | 读文件（行号 + 范围 + 大文件分页） | 全员标配 |
| `write` | edit | 写/覆盖文件 | 全员 |
| `edit` | edit | 精确字符串替换 / unified-diff 双格式可配（按模型选最优，benchmark 驱动） | Aider edit-format + Cline apply_patch/apply_diff |
| `bash` | execute | 跑命令（经 sandbox，流式输出，可后台） | 全员 |
| `grep` | search | ripgrep 内容搜索 | opencode/CC |
| `glob` | search | 文件名 glob | opencode/CC |
| `ls` | read | 目录列举 | 多家 |
| `web_fetch` | fetch | 抓 URL（净化 + 大小限制） | 多家 |
| `web_search` | fetch | 搜索（provider 内置或外接） | 多家 |
| `todo_write` | other | 任务清单（turn 内任务管理） | CC/opencode |
| `apply_patch` | edit | 多文件补丁（大改动） | Codex/Cline |
| `subagent_spawn` | other | 派生子 agent（§2.5） | CC/OpenClaw |
| `skill_activate` | other | 懒加载 skill 全文（§5） | CC/AstrBot/LangBot |

**工具描述与 JSON Schema 约定**：每个内置工具的 `inputSchema` 是标准 JSON Schema 7；面向 Gemini 时由 provider 层自动降级到 OpenAPI-3.0 子集（剥 `minLength/pattern/maximum`，借鉴 yo-aichat §6.4）。schema 是工具**声明的一部分**，但执行体独立——同名工具可被插件注册沙箱化替换版（pi「扩展可注册同名工具覆盖内置工具」），不同部署装不同执行体即可。

### 3.3 MCP host 集成

**决策：MCP 做双向**（借鉴 Codex / OpenClaw / nanobot / LangBot 的双向模式；避开 pi 主动拒绝 MCP 导致与生态脱节）。

- **作为 MCP host/client**：用 `@modelcontextprotocol/sdk` 的 `Client`，支持 **stdio / Streamable HTTP**（SSE 已 deprecated，仅兼容旧服务器），OAuth 2.0。MCP 工具映射为 `ToolDescriptor{owner:'mcp'}` 注入 `ToolRegistry`，与内置工具走同一审批流。
  - **生产防护**（OpenClaw 经验）：会话级**懒加载** + **TTL**（10 分钟）+ **失败熔断**（`BUNDLE_MCP_FAILURE_THRESHOLD=3`，60s 冷却）。
  - **prompt cache 警告**（Codex 明确指出）：MCP 动态 `tools/list_changed` 会破坏 prompt 缓存前缀导致昂贵 cache miss——工具列表变更走显式重建，不在 turn 中途热换。
  - 大量工具用 **ToolSearch 懒加载**（Claude Code），不全量塞进上下文。
- **作为 MCP server**（`yo-agent --mcp-server`）：把 yo-agent 自身暴露为 MCP server（Codex `mcp-server` / nanobot「Agent as MCP Server」），使其既能独立跑、又能当 Claude Code / Cursor / Agents SDK 的可编排执行节点，复用全部内置工具无需重复开发。

### 3.4 工具审批与沙箱策略（TS/Node 现实下的可行方案）

**调研结论的尖锐取舍**：大量 TS 编程 agent（pi/opencode/Cline/Goose）**没有 OS 级沙箱**，靠 checkpoint 回滚兜底，这是已知风险；而真正的 OS 级隔离（Codex seatbelt/bwrap、OpenHands Docker）成本高、跨平台一致性差。yo-agent 的决策是**分层、可配、明示残余风险**：

| 隔离层 | 实现 | 默认场景 | 借鉴 / 避开 |
|---|---|---|---|
| **L0 权限白名单**（必备） | `bash` 工具命令经 `PolicyEngine` 静态/LLM 标注危险性 + allowlist/denylist + 路径保护（保护 `.git`/`.ssh`/yo.md/secret 路径） | 所有部署 | Claude Code Protected Paths、Cline 8 类权限、nanobot 能力维度白名单 |
| **L1 子进程隔离**（默认生产） | tool 执行在独立 `child_process`，以受限环境变量 + 受限 cwd（workspace 内）+ 可选独立低权 OS 用户运行；env 不含 yo-agent 自身 secret | 编程态生产 | Goose `child_process`、yo-aichat §8.4 进程隔离 |
| **L2 容器隔离**（opt-in 严格） | tool 执行委派给 Docker/Podman exec（`bash`/`apply_patch` 在容器内），workspace volume 挂载 | 开放渠道 / 不可信任务 | AstrBot Local/Sandbox 双模式、LangBot Docker/nsjail/E2B、OpenHands DockerWorkspace（取其"同一 API 三档 Workspace"思路） |
| **L3 checkpoint 回滚**（兜底，与沙箱正交） | 工具执行层封装 shadow-git checkpoint，每次写操作后快照，暴露 `rollback(checkpointId)` | 全部（无 OS 沙箱时的最低安全网） | Cline Shadow Git、Gemini checkpointing、Aider auto-commit |

```typescript
// 沙箱抽象（同一 API 三档实现，对工具代码透明，借鉴 OpenHands Workspace）
interface ExecBackend {
  exec(cmd: string, opts: ExecOpts): AsyncIterable<{ chunk: string; exitCode?: number }>;
  kind: 'local-subprocess' | 'docker' | 'ssh-remote';
}
```

**审批（与沙箱正交，借鉴 Codex「审批策略 × 沙箱模式独立配置」）**：见 §9.2。审批走 **ACP 式协议消息**而非进程内 UI——`emit(ApprovalRequested{requestId, risk, suggestions})`，前端（CLI 弹窗 / IM 按钮 / IDE 对话框）渲染相同语义，`approval.decide(requestId, 'allow_once'|'allow_always'|'reject_once'|'reject_always', updatedInput?)` 回灌。这与远端客户端 / IDE（ACP）的原生审批回路天然对接。

---

## 4. Provider 抽象（BYOK）

### 4.1 核心抽象（内核永不按 provider 分支）

```typescript
interface Provider {
  streamChat(req: ChatRequest): AsyncIterable<ProviderEvent>;
  listModels(): Promise<ModelInfo[]>;          // 运行时 /models 发现
  readonly capabilities: ProviderCapabilities; // 是否支持 native tool-calling / thinking / cache 等
}

interface ChatRequest {
  modelId: string;
  messages: CanonMessage[];                    // 归一消息（含 tool_result）
  tools: ToolSpec[];                           // canonical {name, description, jsonSchema}
  toolChoice?: ToolChoice;
  system?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';  // 独立归一轴，按 provider 翻译
  maxTokens?: number;
  providerOptions?: Record<string, unknown>;   // 逃生口
}

type ProviderEvent =
  | { kind: 'TextDelta'; text: string }
  | { kind: 'ThinkingDelta'; text: string }
  | { kind: 'ToolCallStart'; id: string; name: string }
  | { kind: 'ToolCallArgsDelta'; id: string; delta: string }
  | { kind: 'ToolCallEnd'; id: string }
  | { kind: 'UsageUpdate'; usage: Usage }
  | { kind: 'Stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' }
  | { kind: 'Error'; error: LlmError };
```

### 4.2 五个 adapter（复用 yo-aichat 的 provider 踩坑结论 —— 技术学习，与其存废无关）

1. **AnthropicProvider** — `POST /v1/messages`，content-block，typed SSE；`tool_result` 全放单条 user 消息；4.7/4.8/Fable 拒绝 `temperature/top_p`，用 `output_config.effort` + adaptive thinking。
2. **OpenAiResponsesProvider** — `POST /v1/responses`（openai.com 主路）。
3. **OpenAiChatProvider** — `POST /v1/chat/completions`（兼容基座）。
4. **GeminiProvider** — `:streamGenerateContent?alt=sse`；schema 降 OpenAPI-3.0 子集；`functionResponse` parts；整块 functionCall。
5. **OpenAiCompatibleProvider** — 可配 baseUrl + headers + 能力 flags，覆盖 **DeepSeek + Ollama/LM Studio/OpenRouter/Groq** 等。

> **决策：自己控 provider 抽象层 + SSE 解析，但可选引入 Vercel AI SDK 作为 OpenAI-compatible 与 Gemini 的底层 transport。** opencode 用 Vercel AI SDK + models.dev 是成熟解（75+ provider 开箱即用），但 yo-agent 与 yo-aichat 共享 provider 踩坑结论（Fable retention/refusal、Gemini schema 降级、tool_result 扇出差异），**这些归一逻辑必须自己控**，不能全黑盒交给 AI SDK。故 adapter 层自研，必要时内部调 AI SDK / 官方 SDK 做 wire 传输。

### 4.3 双轨函数调用归一（BYOK 全模型覆盖的必备基础设施）

**横向共识**：强模型用 native function-calling（省 token + 并行），弱/本地模型用 prompt-and-parse 回退（Cline Native-JSON+XML / OpenHands NonNativeToolCallingMixin / Goose Tool Shim）。

```typescript
interface ToolCallingStrategy {
  // 按 provider 能力自动选择
  encodeTools(tools: ToolSpec[]): unknown;        // native: JSON schema / shim: 注入 prompt
  parseToolCalls(ev: ProviderEvent[]): ToolCall[]; // native: 原生解析 / shim: 文本解析
}
// NativeStrategy   —— Anthropic/OpenAI/Gemini 原生
// PromptShimStrategy —— Ollama 等无 native function-calling 的弱模型（借鉴 Goose Tool Shim）
```

累积差异归一：Anthropic `input_json_delta` 与 OpenAI `tool_calls[].arguments` 分片**累积到完成才 parse**；Gemini 整块。id：Anthropic/OpenAI 原生，Gemini 合成。

### 4.4 模型目录、成本与用量

- **模型目录**：bundled JSON catalog（caps + pricing）+ 运行时 `/models` 发现 + 可远程刷新（借鉴 **models.dev 思路**，opencode 动态拉 context window 避免硬编码）+ 未知 id 优雅降级。`effort` 独立归一轴，按 provider 翻译，**丢弃模型不接受的参数而非盲传**（yo-aichat 教训）。
- **成本与用量**：每 step `emit(UsageUpdate)`，每 turn 末 `TurnCompleted{usage, costUsd}`。用量落盘 `usage` 表。
- **fallback 链 + auth profile rotation**（OpenClaw / LangBot）：多 key 轮换 + 按失败类型（rate_limit / billing / context_overflow）走不同策略——rate_limit 换 key，context_overflow 触发 compaction，其余换 provider。**工具调用循环内 commit 首个成功模型**，避免跨模型 tool_result 解读不一致（LangBot 经验）。
- **prompt cache 前缀固定**（Codex）：静态内容（system + yo.md + 工具定义）置 prompt 绝对前部，动态内容追加末尾，最大化 cache 命中率——长会话 token 成本从二次降为线性，IM 持续活跃群尤其关键。

---

## 5. 上下文与记忆

### 5.1 窗口管理与压缩触发

**决策：独立可替换的 `Condenser` 组件**（OpenHands Condenser + opencode 独立 compaction agent 共识，不内嵌压缩逻辑）。

```typescript
interface Condenser {
  shouldCompact(ctx: ContextState): boolean;     // 默认 used >= 80% usable（横向共识阈值）
  condense(events: Event[]): Promise<Event[]>;
}
```

**压缩策略**：保首 `keep_first` 条 + 保尾 N 轮原始 + 中段 LLM 摘要（OpenHands 双端保留，实测 token 减半无质量损失；远胜 LangBot/NoneBot 纯硬截断的失忆反例）。摘要为**结构化 Handoff 文档**（Goal / What Happened / Current State / Next Steps，nanobot；比自由文本可靠）。

**两条关键防护**（踩过坑的经验）：
1. **强制保留不透明标识符**（OpenClaw `IDENTIFIER_PRESERVATION`）：摘要 prompt 明确 "preserve all opaque identifiers exactly as written, no shortening or reconstruction"——否则 agent 压缩后因 UUID/hash/URL 失真无法续接。
2. **压缩用可换的便宜模型**（haiku/mini，opencode），Condenser 绑定独立 model。

压缩产出 `emit(ContextCompacted)` 事件入 EventLog（可审计、可逆），**原始事件不删**（EventLog 完整保留，只影响送 LLM 的窗口）。

### 5.2 约定文件：yo.md / AGENTS.md（软约束）

**决策：分层发现 + 合并注入 + 兼容生态**（Codex AGENTS.md 分层链 + Claude Code CLAUDE.md 软约束 + Gemini `@import`）：

- **发现链**（从 cwd 向上遍历，所有匹配文件拼接合并，非覆盖；上限 32 KiB，Codex `project_doc_max_bytes`）：
  全局 `~/.yo-agent/yo.md` → git 根 → 当前目录；**兼容 `AGENTS.md` / `CLAUDE.md`**（@import 互通，使 yo-agent 在任何有 AGENTS.md 的 repo 开箱即用）。
- **聊天平台扩展**（Codex 教训直接适配）：`群/频道级 yo.md`——每个 QQ 群 / Telegram channel 可注入独立行为规范（群级 persona），实现群级定制无需改代码。这把 AstrBot「按平台差异化 Persona」做成了文件约定。
- **软约束本质**：yo.md 作为 **user 消息注入**（非 system prompt），是软指导——硬约束由 hook 代码强制（§2 ApprovalGate / §11 hooks）。**这是 Claude Code「软约束/硬约束分层」的核心：行为指导与强制执行分离，避免系统提示被模型以"有充分理由"为由绕过。**

### 5.3 长期记忆（双轨）

**决策：静态约定文件 + 动态 auto-memory 双轨，权限不同**（横向共识：CLAUDE.md/.goosehints + auto memory/Memory MCP）：

| 轨 | 文件/机制 | 写者 | 加载 | 权限 |
|---|---|---|---|---|
| **静态约定** | yo.md / AGENTS.md | 人工 | 每次注入（token 固定） | agent **不可覆盖** |
| **动态记忆** | `~/.yo-agent/memory/MEMORY.md`（按 workspace/git repo 隔离，借鉴 Claude Code auto memory） | agent 自学习 | 按需加载前 N 行（懒加载） | agent 可读写 |

MVP 不做向量 RAG（避开 AstrBot「仅 RAG 无 episodic memory」的复杂度）；Phase N 可加 Memory MCP server（Goose 模式）按需注入。

### 5.4 子 agent 上下文隔离

子 agent 在**独立 EventLog 子树**（childSessionId）跑，**只回 `SubagentResult{summary}` 给 parent**——主 session EventLog 不被子任务的工具调用历史污染（Claude Code/Gemini/opencode 共识）。Skills 内容在压缩时受保护不被截断（opencode `PRUNE_PROTECTED_TOOLS`，否则压缩后 agent 失忆）。

---

## 6. 会话与可恢复协议（通用远端驱动）

> yo-agent 要能被**任意远端客户端 / IDE / 编排器**驱动，必须像 codex app-server 一样说一套持久、可恢复、协议级审批的 JSON-RPC。这套协议与任何特定前端解耦（早期的 yo-aichat bridge 已废弃，见 §13 Phase 2）。

### 6.1 协议形态决策

**双形态同一内核**（pi 三模态复用同一内核的范式）：

- **`yo-agent rpc`**（默认给远端客户端 / 嵌入式）：**JSON-RPC 2.0 over (TLS) socket**（stdio / Unix socket / WebSocket），事件用 `event` notification 推送。这是远端驱动主路（对标 codex app-server）。
- **`yo-agent --mode jsonl`**（轻量场景）：stdin/stdout **JSONL（LF 分隔）**，每行一个事件/命令（对标 pi `--mode rpc`、`codex exec --json`）。

两者**复用同一 Kernel 事件总线**，只是序列化/传输层不同。

### 6.2 JSON-RPC 方法表（client → yo-agent）

直接以 **codex app-server 为蓝本**（"对齐"列保留与 codex / ACP / pi 的范式对应；早期 yo-aichat 列已不再适用，仅作历史参照）：

| 方向 | 方法 | 语义 | 对齐 |
|---|---|---|---|
| C→S | `session/new(opts) → {sessionId, workspacePath}` | opts={project, agentProfile, model?, permissionMode, allowedTools?, env?, surfaceKind} | codex `thread/new`、yo-aichat `session.start` |
| C→S | `session/list() → Session[]` | 列持久会话 | codex `thread/list` |
| C→S | `session/resume(sessionId\|"last", fromCursor?) → {sessionId}` | 带历史重放恢复 | codex `thread/resume`、ACP `loadSession` |
| C→S | `session/reconnect(sessionId, fromCursor) → stream` | 无历史重连，只续实时流 | ACP `resumeSession` |
| C→S | `session/fork(sessionId, atCursor) → {newSessionId}` | DAG 分支（pi `--fork`） | codex `thread/fork`、pi fork |
| C→S | `turn/start(sessionId, prompt, idemKey, attachments?) → {turnId}` | **idemKey 幂等**：resumed/retried turn 不双执行（防双计费） | codex `turn/start`、yo-aichat idemKey |
| C→S | `turn/steer(sessionId, text)` | mid-turn 转向 | codex `turn/steer`、pi steer |
| C→S | `turn/interrupt(sessionId)` | 中断当前 turn | codex `turn/interrupt` |
| C→S | `approval/decide(requestId, decision, updatedInput?)` | 审批裁决回送（four-option，ACP） | ACP `request_permission`、yo-aichat `approval.decide` |
| C→S | `model/list() → ModelInfo[]` | 模型目录 | codex `model/list` |
| C→S | `fs/readFile / fs/writeFile / fs/watch` | 客户端能力覆盖（IDE 场景） | codex `fs/*` |
| **S→C** | `event(sessionId, cursor, AgentEvent)` | 流式事件 notification（§2.2） | codex item 流、yo-aichat `event` |
| **S→C** | `approval/request(requestId, sessionId, tool, input, risk, suggestions)` | **server→client 主动请求审批，阻塞 agent 直到应答/超时（默认 deny）** | codex serverRequest/approval、ACP request_permission |
| C↔S | `ping / pong` | 心跳 | 全员 |

**传输细节**（采纳 codex app-server 成熟做法）：stdio（JSONL，默认）/ WebSocket（TCP，HMAC-signed JWT）/ Unix socket；WebSocket 满载返回 `-32001`，客户端指数退避重试。

### 6.3 cursor resume 语义

EventLog 是 append-only DAG，每事件有单调 `cursor` + `parentId`。`resume(cursor)` = 从该 cursor 之后重放/重连：

```
客户端重连 → session/resume(sessionId, fromCursor=last_seen):
  ├─ fromCursor 仍在内存 ResumeBuffer → 重放 [fromCursor+1 .. head] 缺口 + 续实时
  └─ fromCursor 被淘汰（gap 溢出）→ 从 SQLite 全量 EventLog 取窗口内
      "状态变更/审批/FileChanged" 摘要（审计不丢，replay_gap_overflow）
      + 当前快照，标注"中间过程已折叠"
```

**审批跨重连存活**：`approval/request` 进 ResumeBuffer，客户端断线时审批 pending 不无限挂起——设超时（默认 5 分钟）**默认 deny**，重连时重放未决审批。（Phase 1 已落地 `ResumeBuffer` / `gapOverflowSummary` / 审批超时 deny，待 Phase 2 RpcSurface 消费。）

### 6.4 事件 schema 稳定性与多语言 binding

`AgentEvent`（§2.2）是 protocol 包的**单一事实源**：TS 类型 + JSON Schema（schema-gen），可据此生成 Go / 其他语言的 binding 给任意客户端，使第三方零成本归一 yo-agent 的事件流（对标 bridge 归一 codex/claude/pty 的范式）。schema 演进走 `schema_version` + 迁移（§10.1），旧事件始终可加载。鉴权由 yo-agent **自带**（ed25519 + 配对码 + nonce 挑战，§9.3）。

> 历史注：早期此节为"与 yo-aichat AgentEvent 逐项同构 + `YoAgentAdapter` 恒等映射"。yo-aichat 已废弃，同构约束移除；事件源设计本身与该客户端无关，独立成立、予以保留。

---

## 7. 多平台接入层（Surfaces）

### 7.1 适配器抽象（Transport + Adapter 二层）

**决策：直接照搬 NoneBot2 的 Transport + Adapter 二层解耦**（已被数十个真实适配器 + 895 插件验证的最干净接入层架构），配 AstrBot/LangBot 的统一内部消息类型。

```typescript
// Transport：管连接生命周期（HTTP/WS/反向 WS），不碰平台语义
interface Transport {
  connect(): Promise<void>;
  send(raw: unknown): Promise<void>;
  onRaw(handler: (raw: unknown) => void): void;
  close(): Promise<void>;
}

// PlatformAdapter：平台 payload ↔ 内部统一类型双向转换
interface PlatformAdapter {
  readonly platform: string;                          // 'onebot-v11' | 'telegram' | 'discord'
  parseInbound(raw: unknown): UnifiedMessage | null;  // 平台 → 内部
  formatOutbound(ev: AgentEvent, ctx: ChatContext): PlatformPayload[]; // 内部 → 平台
}

// Surface：把适配器接到 Kernel —— 平台消息推入 Kernel，Kernel 事件经 adapter 回写
interface Surface {
  readonly kind: SurfaceKind;  // 'cli' | 'rpc' | 'chat' | 'acp' | 'mcp-server'
  start(kernel: Kernel): Promise<void>;
}

// 统一内部消息（AstrBot AstrBotMessage / LangBot UniMessage）—— 平台细节不渗透内核
interface UnifiedMessage {
  platform: string;
  chatId: string;            // 群/频道/私聊
  senderId: string;
  replyToId?: string;        // ★ 映射到 EventLog parentId（pi DAG）——聊天线程=agent 分支统一存储
  parts: ContentPart[];      // text/image/file/mention 富文本
}
```

一个 Kernel 实例可同时 `register(new TelegramSurface())` 和 `register(new OneBotSurface())`，Transport 层完全不感知平台差异（NoneBot2 `fastapi+httpx` 组合范式）。

### 7.2 Surface 清单与决策

| Surface | 形态 | 借鉴 |
|---|---|---|
| **CliSurface** | TUI（差量渲染）+ headless（`-p` 单次 + `--mode jsonl`） | pi 三模态、Codex exec |
| **RpcSurface** | JSON-RPC 2.0 / JSONL，给远端客户端 & 嵌入式（§6，通用远端驱动） | codex app-server、pi rpc |
| **ChatSurface** | Transport+Adapter 二层，OneBot v11（QQ）优先，Telegram/Discord 跟进 | NoneBot2/AstrBot/LangBot |
| **AcpSurface** | ACP server（被 Zed/JetBrains/Kiro 直接接管，免逐 IDE 写适配） | opencode/Goose/OpenHands ACP |
| **McpServerSurface** | `--mcp-server`，yo-agent 作可编排节点 | Codex/nanobot |

**OneBot v11 优先**（覆盖 QQ/微信生态，AstrBot/LangBot/NoneBot 三家共识的国内 IM 标准）。**没有任何编程 agent 原生支持 QQ/Telegram——这正是 yo-agent 的空白机会。**

### 7.3 适配器样例（OneBot v11）

```typescript
class OneBotV11Adapter implements PlatformAdapter {
  readonly platform = 'onebot-v11';

  parseInbound(raw: OneBotEvent): UnifiedMessage | null {
    if (raw.post_type !== 'message') return null;
    return {
      platform: this.platform,
      chatId: raw.message_type === 'group' ? `group:${raw.group_id}` : `private:${raw.user_id}`,
      senderId: String(raw.user_id),
      replyToId: extractReplySegment(raw.message),   // CQ:reply → EventLog parentId
      parts: cqCodeToContentParts(raw.message),       // CQ 码 → 统一富文本
    };
  }

  formatOutbound(ev: AgentEvent, ctx: ChatContext): OneBotSendPayload[] {
    switch (ev.kind) {
      case 'AssistantText':
        return [{ action: 'send_msg', params: { ...ctx.target, message: ev.full ?? ev.delta } }];
      case 'ApprovalRequested':  // 审批渲染为带 reply 的提示 + 等待 /allow /deny 指令
        return [{ action: 'send_msg', params: { ...ctx.target,
          message: `⚠️ 请求执行 ${ev.tool}（风险 ${ev.risk}）回复 /allow_once 或 /deny` } }];
      case 'Reasoning': return [];  // IM 端默认折叠思考过程
      default: return [];
    }
  }
}
```

聊天平台接入采用**双向解耦**（横向共识）：消息路由层（平台适配 + 格式化 + 限流）与 agent 核心（推理 + 工具执行）完全分离，平台消息推入 Kernel 事件队列，结果由 adapter 格式化回写。

---

## 8. 插件 / 扩展 / 子 agent / 技能

### 8.1 扩展点总览

**决策：primitives-not-features（pi）+ 进程隔离（LangBot）+ 声明式（OpenClaw）三结合**——内核只有 turn 循环 + 工具总线 + 事件总线，plan/MCP/subagent/审批 UI/todo 全部是内核之上的可选插件/hook。

```typescript
interface Plugin {
  name: string;
  registerTools?(reg: ToolRegistry): void;          // 注册/覆盖工具（pi 同名覆盖）
  registerHooks?(hub: HookHub): void;               // 生命周期钩子（§11）
  registerSurfaces?(reg: SurfaceRegistry): void;    // 平台适配器
  registerSkills?(reg: SkillRegistry): void;        // 技能
}
```

**插件隔离**（避开 pi/NoneBot「require() 进主进程崩溃拖垮全局」的反例）：第三方插件默认跑在 **Worker 进程**，经结构化 IPC 通信（借鉴 LangBot 3 种 IPC：stdio / WebSocket / container），心跳自动重连，单插件崩溃不影响主进程。内置/可信插件可 in-process。

### 8.2 subagent 委派

见 §2.5。委派范式三选（按场景）：foreground 阻塞（探索）/ background 异步 steering 注入（并发）/ sequential + resume（长任务，OpenHands TaskToolSet）。

### 8.3 skills / recipes 机制

**Skills（懒加载 prompt 模板，横向共识：CC/AstrBot/LangBot/opencode/nanobot 全有）**：

- 结构：`<name>/SKILL.md`（YAML frontmatter `{name, description, tools?}` + Markdown body）。
- 发现路径：项目级 `.yo-agent/skills/` + 全局 `~/.yo-agent/skills/`（兼容 `.claude/skills/` `.agents/skills/`，借鉴 opencode 6 路径发现）。
- **懒加载**：base session 只注入 skill 的 name + description 摘要目录；agent 识别需求后调 `skill_activate(name)` 拉入全文。**base context 保持精简，理论上可维护无限 skill 而不增基础 token**（Claude Code）。压缩时 skill 内容受保护（opencode `PRUNE_PROTECTED_TOOLS`）。

**Recipes（声明式 agent 配置单元，GitOps 管理，Goose Recipes / Roo mode）**：

```yaml
# .yo-agent/recipes/code-reviewer.yaml
name: code-reviewer
model: claude-sonnet-4-6        # 可绑定独立 provider/model（成本分层）
instructions: |                  # = system prompt
  你是严格的代码审查 agent...
tools: [read, grep, glob]        # 工具白名单（声明式沙箱：无 edit 工具=天然只读）
permissionMode: read-only
parameters: { pr_number: { type: number } }
```

Recipe 把 system prompt + 工具白名单 + 绑定 model + 参数打包为可版本控制单元，用于定义 subagent profile 与不同 surface 的行为，**行为可配置化、可版本控制，无需改代码部署**。

---

## 9. 安全

### 9.1 密钥存储

- **provider key（BYOK）**：存 OS keychain（macOS Keychain / Linux libsecret / Windows DPAPI，经 `keytar` 或等价库），**绝不进 SQLite、绝不入日志/崩溃报告**（yo-aichat §8.3）。配置库只存 `key_ref` 引用。
- **MCP / 插件密钥**：加密持久化（LangBot Cipher 模式），stdout 脱敏。

### 9.2 权限：SecurityAnalyzer × ConfirmationPolicy 正交解耦

**决策：直接采纳 OpenHands 的两层解耦 + Codex 的审批/沙箱正交**——这是"同一内核适配宽松聊天与严格编程"的关键。

```typescript
interface SecurityAnalyzer { analyze(call: ToolCall): RiskLevel; }   // LOW/MEDIUM/HIGH/UNKNOWN
type ConfirmationPolicy =
  | { kind: 'NeverConfirm' }                       // autonomous（内部白名单放行）
  | { kind: 'AlwaysConfirm' }                      // supervised 每步审批
  | { kind: 'ConfirmRisky'; threshold: RiskLevel } // 按风险阈值（默认 HIGH）
```

| 形态 | 默认 policy | 沙箱 | 说明 |
|---|---|---|---|
| **编程 agent（CLI）** | `ConfirmRisky{HIGH}` | L1 子进程 | 危险操作（rm -rf/git push/写 secret）审批，常规放行 |
| **聊天 bot（开放渠道）** | `AlwaysConfirm` + DM pairing | L2 容器 | 默认每步审批 + 配对码门禁 |
| **CI / headless** | `NeverConfirm` + allowlist | L1/L2 | 仅 allow 规则与只读放行（Claude Code dontAsk） |
| **远端驱动（RPC）** | 跟随客户端协议审批 | 跟随 opts | 审批走 §6.2 `approval/request`，server→client 渲染 |

至少 **read-only / supervised / autonomous 三档 PermissionMode**（横向共识下限），会话内可临时升级 + 时间窗。审批走**协议消息**（ACP four-option），前端无关。

### 9.3 设备鉴权（yo-agent 自带）

RpcSurface（远端驱动）与开放渠道用 yo-agent 自带的鉴权模型（不依赖任何外部项目）：

- **ed25519 + 配对码 + 每连接 nonce 签名挑战**（抗捕获重放，非静态 bearer）。
- **开放渠道 DM pairing**（OpenClaw）：未知发送者默认 pairing 模式，需配对码审批才能触发 agent——开放渠道防 prompt injection 的最低门槛。
- 短 TTL token + 静默轮换 + 撤销实时断链。

### 9.4 工具沙箱与危险命令防护

- 沙箱见 §3.4（L0-L3 分层）。
- **危险命令防护**：`bash` 命令经 SecurityAnalyzer（静态规则 `rm -rf /`、`:(){ :|:& };:` fork bomb、`curl|sh`、命令替换注入 `$(...)` 检测——Gemini CLI 做法 + LLM 动态标注 `requires_approval`——Cline 做法）。Protected Paths 保护 `.git/.ssh/yo.md/secret` 路径（Claude Code）。
- **bypassPermissions / yolo 默认全关**，仅在明确逐会话授权 + 宿主隔离时临时启用，UI 红色警示（yo-aichat §8.5）。

### 9.5 注入防护

- **软/硬约束分层**（Claude Code 核心）：yo.md 软指导（user 消息）+ hook 硬强制（代码，不经模型判断），**避免越狱**。
- **审批分类器看不到工具结果**（Claude Code auto mode）：若启用风险分类器，分类器可见 yo.md 但看不到工具执行输出，防 prompt injection 经工具输出污染审批决策。
- **子 agent spawn 前/中/后三阶段审查**（Claude Code v2.1.178+ 思路，Phase N）。
- 开放渠道 DM pairing（§9.3）防公开渠道注入。

---

## 10. 持久化与可观测性

### 10.1 会话存储（SQLite）

**决策：SQLite 单库 + append-only EventLog（DAG）**（OpenHands EventLog + pi JSONL DAG + OpenClaw SQLite-only 共识；用 `better-sqlite3` 同步驱动或 `node:sqlite`）。

```sql
sessions(session_id PK, owner, surface_kind, agent_profile, workspace_path, git_ref,
         model, permission_mode, state, head_cursor, created_at, last_active_at)
events(session_id, cursor, parent_cursor, turn_id, kind, payload_json, ts,
       PK(session_id, cursor))                      -- ★ append-only DAG，唯一事实源
checkpoints(checkpoint_id PK, session_id, cursor, shadow_git_ref, created_at)
usage(session_id, turn_id, input_tokens, output_tokens, cache_read_tokens, cost_usd, ts)
config_kv(key PK, value_json)
mcp_secrets(server_id PK, cipher_blob)              -- 加密
```

- **schema 版本迁移**（OpenHands 教训，从第一天就建）：events 带 `schema_version`，旧事件始终可加载。
- **fork/branch 零额外设计**：`parent_cursor` 形成 DAG，`session/fork(atCursor)` 原地分支不复制（pi）。聊天 `replyToId` → `parent_cursor`。
- ResumeBuffer（内存 ring，最近 N 帧/10 分钟）服务实时重连；全量 events 表服务审计与 gap 溢出降级。

### 10.2 日志与追踪（OTel）

**决策：第一天内置 OpenTelemetry**（Gemini CLI 经验：在 loop 关键节点埋 span，方便调试 agent 行为与成本）：

- span：turn 开始/结束、每次 tool 调用前后、provider 请求、压缩、审批。
- 符合 GenAI 语义约定；session/tool/token 多维 metrics 推任意 OTLP 后端。
- 结构化日志（pino），key 脱敏。

### 10.3 用量

`usage` 表 + 每 turn cost 估算（按模型目录 pricing）；CLI `--show-cost`；token 可见性（pi footer 思路：↑↓ cache-hit-rate 实时显示）。

---

## 11. 配置系统

### 11.1 配置文件层级

```
~/.yo-agent/config.toml          # 全局：provider keys ref、默认 model、permissionMode
.yo-agent/config.toml            # 项目级：覆盖全局
~/.yo-agent/yo.md + 项目 yo.md   # 约定文件（§5.2，软约束）
.yo-agent/recipes/*.yaml         # subagent / mode 定义（§8.3）
.yo-agent/skills/*/SKILL.md      # 技能（§8.3）
.yo-agent/mcp.json               # MCP server 配置
```

### 11.2 slash 命令

CLI / 聊天平台共用一套 slash 命令（MCP prompts 映射为 slash，Claude Code/Gemini 做法）：

| 命令 | 语义 |
|---|---|
| `/model <id>` | 会话内切模型 |
| `/compact [指令]` | 手动触发压缩 |
| `/resume [id]` / `/fork [cursor]` | 恢复 / 分支 |
| `/plan` | 进入只读 plan 模式（Plan/Act） |
| `/allow_once` `/deny` | 审批裁决（IM 端） |
| `/skill <name>` | 激活技能 |
| `/mode <recipe>` | 切换 recipe profile |

### 11.3 hooks 生命周期

**决策：hook 矩阵 + 五种实现类型**（Claude Code 30 事件最细粒度，但取其精华做合理子集；Codex 10 事件证明够用）。hook 是**横切关注点的统一拦截点**，第三方经 hook 扩展而非改内核。

```typescript
interface HookHub {
  on(event: HookEvent, handler: HookHandler): void;
}
type HookEvent =
  | 'SessionStart' | 'SessionEnd'
  | 'UserPromptSubmit'                  // 注入/改写 prompt
  | 'PreToolUse'                        // ★ allow|deny|modify，不经模型（硬约束核心）
  | 'PostToolUse' | 'PostToolUseFailure'
  | 'PreCompact' | 'PostCompact'        // 干预压缩
  | 'SubagentStart' | 'SubagentStop'
  | 'TurnStart' | 'TurnComplete'
  | 'ApprovalRequest' | 'PermissionDenied';

// 关键：PreToolUse hook 是代码强制的硬约束（Claude Code 核心设计）
type HookHandler = (ctx: HookContext) =>
  Promise<{ decision: 'allow' | 'deny' | 'modify'; modifiedInput?: unknown } | void>;
```

实现类型：`command`（shell 脚本，第三方零 Node 门槛）/ `http`（webhook）/ `mcp_tool` / `inline`（Node 函数）。hook 信任基于 hash 记录，新/改 hook 触发人工审查（Codex 信任模型）。

---

## 12. 目录结构与技术选型

### 12.1 monorepo（pnpm workspace）

**决策：pnpm workspace + TypeScript project references**（避开 Bun 强绑；pnpm 是 TS monorepo 主流）。

```
yo-agent/
├─ pnpm-workspace.yaml
├─ packages/
│  ├─ protocol/        # ★ 单一事实源：AgentEvent union + JSON-RPC 方法 schema；TS 类型 + JSON Schema → 可 gen Go
│  ├─ kernel/          # TurnLoop / SessionManager / Condenser / LoopBreaker / ApprovalGate / SubagentMgr / PolicyEngine
│  ├─ tools/           # ToolRegistry + 内置工具 + ExecBackend(sandbox L0-L3)
│  ├─ provider/        # Provider 抽象 + 5 adapter + 双轨 tool-calling + 模型目录
│  ├─ store/           # SQLite EventLog + checkpoint + 迁移
│  ├─ mcp/             # MCP host(client) + MCP server
│  ├─ surfaces/
│  │   ├─ cli/         # TUI + headless
│  │   ├─ rpc/         # ★ JSON-RPC/JSONL，给远端客户端（通用远端驱动）
│  │   ├─ chat/        # Transport + Adapter 二层（onebot/telegram/discord）
│  │   ├─ acp/         # ACP server
│  │   └─ mcp-server/
│  ├─ plugins/         # 插件 SDK + Worker 隔离 IPC
│  ├─ skills/          # SKILL.md 加载 + recipe 引擎
│  ├─ auth/            # ed25519 + 配对码 + nonce 挑战（yo-agent 自带）
│  └─ obs/             # OTel + pino 日志 + 用量
├─ apps/
│  └─ yo-agent/        # CLI 入口（commander/yargs）、组合根
└─ docs/
```

### 12.2 关键技术选型清单

| 关注点 | 选择 | 理由 / 否决 |
|---|---|---|
| runtime | **Node ≥ 20** | 单栈；`node:sqlite`、`worker_threads`、fetch 内置。**否 Bun/Deno**（避 opencode 强绑教训） |
| 语言 | **TypeScript ≥ 5** | strict |
| monorepo | **pnpm workspace** + project references | TS monorepo 主流 |
| CLI | **commander** 或 **yargs** | 成熟 |
| TUI | **Ink**（React+Ink）或自研差量渲染 | Gemini CLI 用 Ink；pi 自研 diff 渲染 |
| SQLite | **`better-sqlite3`**（同步，性能）或 `node:sqlite` | EventLog 高频写需同步快路径 |
| MCP | **`@modelcontextprotocol/sdk`** | 官方 SDK，host+server 双向 |
| provider transport | 自研 adapter，内部可选 **Vercel AI SDK** / 官方 SDK | 归一逻辑自控（Fable/Gemini 踩坑），wire 可借 SDK |
| SSE 解析 | **自写行解析**（`ReadableStream` + 行分割） | 避 dio 式缓冲坑（yo-aichat 教训） |
| schema 校验 | **zod** / **typebox** | 工具 inputSchema 校验（pi 用 typebox） |
| JSON-RPC | 自研薄层（`vscode-jsonrpc` 可选） | 协议要自控 |
| ACP | **`@agentclientprotocol/*`** 或按 spec 实现 | 复用 ACP 生态 |
| 密钥 | **keytar** / OS keychain | 不进库 |
| 鉴权 | **`@noble/ed25519`** + argon2id（token hash） | yo-agent 自带 |
| 沙箱（L2） | **dockerode**（Docker exec）opt-in | 容器隔离 |
| checkpoint | **isomorphic-git** / shadow git | 文件回滚 |
| ripgrep | **`@vscode/ripgrep`** binding | grep 工具 |
| tree-sitter | **`web-tree-sitter`** | repo map（Phase N） |
| OTel | **`@opentelemetry/*`** | 可观测 |
| 日志 | **pino** | 结构化 + 脱敏 |
| 测试 | **vitest** | 快 |

---

## 13. MVP 里程碑与分阶段路线

### Phase 0 — 协议与骨架（不可跳）✅ 已完成

- `protocol/`：`AgentEvent` sealed union + JSON-RPC 方法表 + StopReason + cursor/resume 语义；TS 类型 + JSON Schema（可 gen 多语言 binding 给任意客户端）。
- pnpm workspace + `kernel`/`store`/`provider`/`tools` 接口冻结。
- 四接口冻结：`Provider` / `ToolDescriptor+ExecutorRef` / `Surface` / `Condenser`。
- **退出标准**：协议 schema 冻结，EventLog schema_version 入库。

### Phase 1 — 内核 + 编程 CLI MVP（第一可交付，零网络风险）✅ 已完成（见 [PHASE-1.md](PHASE-1.md)）

- Kernel turn 循环（infer→tool→observe）+ EventLog 落盘 + LoopBreaker + Condenser。
- Provider：5 adapter（Anthropic + OpenAI Responses + OpenAI Chat/兼容 + Gemini + DeepSeek-via-兼容）+ 双轨 tool-calling + 模型目录。
- 内置工具集（read/write/edit/bash/grep/glob/ls/todo）+ L0 权限白名单 + L3 checkpoint。
- CliSurface（TUI + headless `--mode jsonl`）+ yo.md 约定文件加载。
- **退出标准**：CLI 多 provider 流式编程对话 + 工具调用 + 审批 + resume + 熔断跑通。

> **路线调整（yo-aichat 废弃）**：原 Phase 2「为 yo-aichat Go bridge 对接」目标移除——yo-aichat（Flutter 远程操控客户端）已废弃，不再是 yo-agent 的消费者或同构对象。可恢复协议**保留并泛化为通用远端驱动协议**（任意客户端 / IDE / 编排器），鉴权改为 yo-agent 自带。Phase 2+ 按**价值 × 风险 × 复用度**重排：先"被集成"（协议暴露，复用最大、零开放渠道风险、Claude Code 即消费者）→ 再"安全底座"（沙箱/子 agent/可观测）→ 最后"开放渠道"（聊天平台，差异化但风险最高，依赖底座）。

### Phase 2 — 协议化暴露：泛化 RpcSurface + MCP server（最大复用、双消费者、零开放渠道风险）

- **泛化 RpcSurface**：JSON-RPC 2.0（stdio / Unix socket / WS）+ `--mode jsonl`（Phase 1 已有）；`session/* turn/* approval/* model/*` 方法集（§6.2）。消费 Phase 1 已落地的 `ResumeBuffer` / `gapOverflowSummary`：cursor resume + gap 溢出降级 + 审批跨重连存活。**通用远端驱动协议，不绑定任何特定前端。**
- **McpServerSurface**（`--mcp-server`）：把 yo-agent 暴露为 MCP server，被 Claude Code / Cursor / Agents SDK 当可编排执行节点直接调用（复用全部内置工具）——**现成消费者**。
- **auth**：yo-agent **自带** ed25519 + 配对码 + 每连接 nonce 签名挑战（§9.3，不再复用任何外部项目）。
- **退出标准**：① 任意远端客户端经隧道 resume(cursor) 驱动 yo-agent，断网/重启不丢 token / 不丢审批；② yo-agent 作 MCP server 被 Claude Code 调用、内置工具可用。

### Phase 3 — MCP host + ACP + 上下文/记忆打磨（接生态另一半）

- **MCP host/client**：stdio / Streamable HTTP，会话级懒加载 + TTL + 失败熔断；外部 MCP 工具映射 `ToolDescriptor{owner:'mcp'}` 注入注册表，与内置工具走同一审批流。
- **AcpSurface**：ACP server（被 Zed / JetBrains / Kiro 直接接管），与 RpcSurface 共享协议/审批机制（ACP request_permission 四选项已对齐）。
- ContextCompacted 结构化 Handoff + 不透明标识符保留打磨；动态 auto-memory（按 workspace 隔离）。
- **退出标准**：yo-agent 挂外部 MCP server 并用其工具；被 Zed/JetBrains 经 ACP 接管跑通编程对话。

### Phase 4 — 子 agent + 沙箱加固 + 可观测 + 插件（开放前的安全/健壮性底座）

- SubagentManager（Worker 隔离 + 异步 steering）+ recipes/skills 懒加载。
- L1 子进程隔离 + L2 容器（opt-in）+ 危险命令防护 + 注入防护三阶段审查。
- OTel 全链路 + 用量计费 + provider fallback 链 / auth rotation。
- 插件 SDK（Worker IPC 隔离）+ hooks 矩阵。
- **退出标准**：安全审查通过；子 agent 崩溃不拖垮主循环；插件隔离生效。**（是聊天平台开放渠道的前置底座）**

### Phase 5 — 聊天平台接入（QQ / Telegram，差异化空白点，依赖 Phase 4 底座）

- ChatSurface：Transport + Adapter 二层 + OneBot v11（QQ）优先，Telegram / Discord 跟进；DM pairing。
- ConfirmationPolicy 切聊天态（AlwaysConfirm + 配对码门禁）；群 / 频道级 yo.md（群级 persona）。
- **退出标准**：QQ 群驱动 yo-agent（审批 / pairing / 压缩 / 开放渠道注入防护端到端跑通）。**没有任何编程 agent 原生支持 QQ/TG——这是 yo-agent 的空白机会。**

### Phase 6 — 打磨 + 多用户接缝

- repo map（tree-sitter）；RAG 长期记忆（opt-in，Memory MCP）。
- 多用户 / 团队接缝兑现（per-device → machine 授权矩阵）。
- 评测门（skills evals + CI）；多平台 adapter 补全。

### 风险与缓解

| 风险 | 缓解 |
|---|---|
| **TS/Node 无 OS 级强沙箱** | L0-L3 分层 + checkpoint 兜底 + 明示残余风险；不可信场景强制 L2 容器（避开 pi/opencode 裸跑反例） |
| **provider wire format 漂移**（Fable/Gemini schema/Responses） | adapter 自控归一 + 能力表过滤参数 + 模型目录不硬编码 + CI 契约测试 pin SDK 版本 |
| **MCP 动态工具破坏 prompt cache** | 工具变更显式重建不热换；会话级懒加载 + TTL + 熔断（OpenClaw） |
| **EventLog schema 演进** | 从第一天 schema_version + 迁移机制（OpenHands） |
| **死循环烧 token** | LoopBreaker 四模式 + 历史窗 + 多重硬上限，引擎层强制（OpenClaw/LangBot/Codex） |
| **与远端客户端协议偏移** | protocol 单一事实源 schema-gen（TS + 可生成多语言 binding）；CI schema 一致性测试 |
| **架构过度复杂**（OpenClaw 反例） | 取其模式不照搬规模；primitives-not-features 内核保持薄 |
| **插件崩溃拖垮主进程** | Worker 进程隔离 + 3 种 IPC + 心跳重连（LangBot） |

---

## 14. 关键决策记录（ADR）

### ADR-1：内核状态源 = append-only EventLog（事件溯源）

- **决策**：所有状态变更 append-only 写 SQLite EventLog（DAG，id+parentId），是唯一事实源。
- **理由**：免费得到 resume + 确定性重放 + 审计三件套，直接解决"被远端客户端驱动需 resume(cursor)"与"IM 长会话恢复"两大刚需。
- **对比**：OpenHands EventLog（采纳）vs pi JSONL DAG（采纳 id+parentId 分支语义）vs Cline new_task 注入（仅作上下文接力，非状态源）。
- **被否**：纯内存 State（NoneBot 重启即失，反例）；线性日志（无法 fork）。

### ADR-2：对外协议 = JSON-RPC 2.0 + Thread/Turn/Item 三层，复用 codex app-server 范本

- **决策**：以 codex app-server 为蓝本设计 RPC（`session/* turn/* approval/* fs/* model/*`），作**通用远端驱动协议**（任意客户端 / IDE-via-ACP / 编排器）；同时提供 `--mode jsonl` 轻量形态。
- **理由**：事件源 + cursor resume 使断网/重启可精确续接；协议与前端解耦——schema-gen 出多语言 binding 即可被任意客户端归一；三模态复用同一内核（pi）。
- **对比**：codex app-server（主范本，最成熟）vs pi `--mode rpc`（轻量范本，采纳为 jsonl 形态）vs ACP（采纳其 request_permission 四选项 + StopReason，作 IDE 接管路；ACP 远端传输 WIP 不作主路）。
- **被否**：自研全新协议（与生态对接成本高）；纯 REST（无法双向 push 审批）。
- **修订（yo-aichat 废弃）**：原决策含"与 yo-aichat bridge `session.*` 逐项对齐 + `YoAgentAdapter` 恒等映射"；yo-aichat 已废弃，该对齐目标移除，协议泛化为通用远端驱动（不影响 codex app-server 蓝本与已落地的 ResumeBuffer/gap 降级）。

### ADR-3：工具系统 = 声明/执行分离 + 多源统一注册 + 双轨调用

- **决策**：`ToolDescriptor{availability 表达式} + ToolExecutorRef`；内置/MCP/插件三源统一注册；按 provider 能力选 native/prompt-shim。
- **理由**：yo-agent 要"既编程又聊天、工具集动态切换"，availability 声明化避免主循环 if-else 膨胀；双轨覆盖 BYOK 全模型（含 Ollama 弱模型）。
- **对比**：OpenClaw ToolDescriptor+ExecutorRef（采纳）vs AstrBot/LangBot 多源注册表（采纳）vs Cline 双轨/Goose Tool Shim（采纳）。
- **被否**：Aider「不用 function calling」（反共识虽有数据，但放弃并行调用 + 与 MCP 生态脱节，只作 edit-format 可配维度借鉴）；pi「No MCP」（与生态脱节，否决）。

### ADR-4：权限 = SecurityAnalyzer × ConfirmationPolicy 正交 + 协议化审批

- **决策**：风险打分与确认策略解耦，同内核换 policy 适配聊天（宽松）/编程（严格）；审批走 ACP 式协议消息四选项。
- **理由**："通用引擎"最关键的是同一内核多场景——正交解耦使聊天态注 `AlwaysConfirm+pairing`、编程态注 `ConfirmRisky{HIGH}`、CI 注 `NeverConfirm` 不改代码。
- **对比**：OpenHands SecurityAnalyzer+ConfirmationPolicy（采纳）vs Codex 审批×沙箱正交（采纳）vs ACP request_permission（采纳协议化）vs OpenClaw DM pairing（采纳渠道基线）。
- **被否**：AstrBot/LangBot 全自动无审批（开放渠道注入风险高，反例）；单一布尔开关（粒度不足）。

### ADR-5：沙箱 = L0-L3 分层（权限白名单 + 子进程 + 可选容器 + checkpoint），明示残余风险

- **决策**：不追求 OS 级强沙箱；分层可配，不可信场景强制 L2 容器，全场景 L3 checkpoint 兜底。
- **理由**：Node 现实做不到 Codex seatbelt/landlock 内核隔离；纯无沙箱（pi/opencode）有已知风险——分层是务实折中。
- **对比**：Codex OS 原生沙箱（理想但 Node 不可行）vs OpenHands Docker（采纳为 L2 opt-in）vs Cline/Gemini checkpoint（采纳为 L3）vs pi/opencode 无沙箱（明确避开）。
- **被否**：强制 Docker（边缘/IoT 无 Docker 受限，OpenHands 弱点）；纯靠规则自约束（危险）。

### ADR-6：上下文压缩 = 独立 Condenser，保首+保尾+中段 LLM 摘要 + 强制保留标识符

- **决策**：独立可替换 Condenser，~80% 阈值触发，结构化 Handoff，摘要 prompt 强制不透明标识符逐字保留，用便宜模型。
- **理由**：纯硬截断会失忆（LangBot/NoneBot 反例）；标识符失真致 resume 失败（OpenClaw 踩坑）。
- **对比**：OpenHands Condenser 双端保留（采纳）+ nanobot Handoff（采纳）+ OpenClaw 标识符保留（采纳）+ opencode 独立 compaction agent 换便宜模型（采纳）。
- **被否**：LangBot/NoneBot 纯硬截断（失忆，反例）。

### ADR-7：接入层 = Transport + Adapter 二层 + UnifiedMessage

- **决策**：照搬 NoneBot2 二层解耦 + AstrBot/LangBot 统一内部消息；OneBot v11 优先。
- **理由**：接入 N 平台开销最小（数十适配器验证）；reply_to → parentId 使聊天线程与 agent 分支统一存储。**没有编程 agent 原生支持 QQ/TG——空白机会。**
- **对比**：NoneBot2 Driver+Adapter（采纳）vs AstrBot UnifiedMessage（采纳）vs Claude Code MCP Channels（桥接式非原生，避开）。
- **被否**：每平台单独写 surface（碎片化）。

### ADR-8：单栈 Node + pnpm，内核保持薄（primitives-not-features）

- **决策**：Node ≥20 + TS ≥5 + pnpm workspace；内核只有 turn 循环 + 工具/事件总线，plan/subagent/MCP/审批 UI 全做成插件/hook。
- **理由**：yo-context 硬约束（TS/Node 单栈）；避开 OpenClaw 300+ 文件碎片化、opencode Bun/Effect-TS 强绑、Claude Code 闭源不可改 loop 三个反例。
- **对比**：pi primitives-not-features（采纳）vs OpenClaw 规模（取模式不取规模）vs opencode Bun 强绑（避开）。
- **被否**：Bun/Deno runtime（生态强绑）；内核内置一切 feature（维护成本高）。

---

## 15. 实现硬细节补遗（claudeLearning 31 篇 + claude-api 权威核查）

> 本节是把 Claude Code / Agent SDK / Anthropic API 的**承重实现细节**收进设计的"已采纳决策"清单。每条都对应一个上面的章节号。完整 ~70 条 findings 与出处见 [`docs/research/_SUPPLEMENT-from-claudeLearning.md`](research/_SUPPLEMENT-from-claudeLearning.md)。**§15.4 / §15.10 的 API 形态已用 claude-api skill 权威核查**（截至 2026-06），优先级高于 2026-05 学习笔记。

### 15.1 内核（补 §2）
- **`stop_reason='max_tokens'` 自动续传**：TurnLoop 遇到 `Stop{reason:'max_tokens'}` 时追加 `{role:'user', content:'请继续'}` 继续循环，**不 `emit(TurnFailed)`**（话未说完≠错误）。`StopReason` / `ProviderEvent.Stop.reason` 补 `'pause_turn'`（server-tool / extended-thinking 暂停），遇到时 `continue`。
- **同 step 多 tool_use 必须 `Promise.all` 并发**，所有结果**合并为单条 user 消息**内的多个 `tool_result` 回填（Anthropic 硬约束：一条 user 消息含全部 tool_result）。顺序 for 会把 5×200ms 退化成 1s。
- **streaming 只在 `finalMessage()` 后写 EventLog 的 assistant turn**；partial+Error（§2.4）不构成合法 turn、不触发 tool。ContextAssembler 可选用 `count_tokens` 预检：预估 > 0.9×窗口先触发 Condenser。
- **LoopBreaker `warn` 注入 tool_result 级提醒**给 LLM（"你已连续 N 次同操作…换思路"），而非仅内部记录。
- **子 agent 底层 = fork 新 Agent Loop + 复制父 options + 子 final text 作 tool_result 注入**（主循环无需特殊分支）。`spawn` opts 与 recipe 补 `maxTurns / isolation('none'|'worktree'|'container') / memory / skipContextFiles / outputMaxTokens`；background 子 agent 的 `ApprovalRequested` 经 `parentSessionId` 浮现到父 surface；`spawnBatch(tasks,{parallel:true})` + recipe 模板显式指示并行。

### 15.2 工具系统（补 §3.1/§3.2/§3.4）
- `ToolContext` 明确字段：`session_id / cwd / user_id / transcript_path`（RBAC / audit / 路径限制基座）。
- tool `description` 三段式（功能 / **TRIGGER 何时调** / **不返回什么**）；`inputSchema` 多用 `enum/minimum/maximum/pattern`（Gemini 降级时按 §4.2 剥除不支持字段）。
- **工具出错必须 `ToolCallCompleted{status:'error'}`**（MCP `isError:true` 映射至此），不可包在 `'ok'`+错误文本里致 LLM 幻觉串联。
- 列表型工具超阈值**截断 + `[截断，还有 N 行]` 提示**，约定 `limit`(默认 50/最大 200)/`offset`；与"大输出写盘只回路径"互补。
- 高危内置工具（bash/write）`inputSchema` 增 `confirm`（默认 dry_run）—— 与 ApprovalGate 形成纵深防御。
- **Permission matcher 采用 Claude Code 语法** `<工具>(<pattern>)`，如 `Bash(npm test:*)`；优先级 **deny > ask > allow > 默认**，**deny 跨层取并集**（任意层 deny 即拒，不可被上层 allow 覆盖）。
- 内置工具集补：`MultiEdit / EnterPlanMode / ExitPlanMode / ToolSearch / WaitForMcpServers / AskUserQuestion`（结构化多选，IM 渲染按钮）；`LSP` 标 Phase N。

### 15.3 MCP（补 §3.3）
- MCP 工具注入时 `name` 强制 **`mcp__{server}__{tool}`**，支撑权限通配 `mcp__github__*`；白名单字段 `enabledMcpServers`。
- **三层配置** `~/.yo-agent/mcp.json`(user) / `.yo-agent/mcp.json`(project，**默认不激活，需 opt-in 信任**，防供应链) / local；`${VAR}` 走 `process.env` 展开，不写盘不入日志。
- **内部 MCP server（McpServerSurface）三铁律**：破坏性 tool 须 `confirm`(默认 dry_run) + **每用户每分钟限流** + **stdio 日志写 stderr**（污染 stdout 即破坏 JSON-RPC，pino 配 `destination: stderr`）。
- **MCP Sampling**：实现 host 端 `sampling/createMessage`（路由到当前会话 Provider + 限流），让 server 反向借调 Host LLM（成本计入 user 配额）。
- `list_resources` + `subscribe`(心跳超时清理) + 多 mime；MCP Prompts 映射 `/mcp__<server>__<prompt>`（内置 skill/recipe 包装为 Prompt 暴露给宿主 UI）；progress notifications ↔ `ToolCallOutput` delta；>20 tool 启 ToolSearch 懒加载。
- **WebSocket 传输不支持 OAuth**（退化为静态 Bearer）——MCP server 配 OAuth 时**必须用 Streamable HTTP**（见 §15.10 C4）。

### 15.4 Provider / API 形态（补 §4 —— ✅ claude-api 权威核查）
- **推理力度 = `output_config: {effort}`**，取值 `low|medium|high|xhigh|max`，**GA、无 beta header**，默认 `high`；`xhigh`(Opus 4.7 新增)是 Claude Code 默认、编程/agentic 最佳。支持 Opus 4.5/4.6/4.7/4.8、Sonnet 4.6、Fable 5；Sonnet 4.5/Haiku 4.5 会 400。→ **§4.1 `ChatRequest.effort` 枚举补 `'xhigh'`**。
- **adaptive thinking = `thinking: {type:'adaptive'}`**（4.6+）；`display:'summarized'` 才回摘要（4.7/4.8/Fable 默认 `omitted`，否则前端是"空 thinking + 长暂停"）。同模型续接须**原样回传 thinking 块**（含空块）；跨模型自动丢弃、不计费。
- **`budget_tokens` 仅旧模型**（Sonnet 4.5 及更早）：在 4.7/4.8/Fable 上发送 → **400（已移除）**，4.6/Sonnet 4.6 上 deprecated。**因此 AnthropicProvider 的 `effort` 翻译走 `output_config.effort`，不是 `thinking.budget_tokens`** —— §4.2 原措辞正确，**笔记 C2 的"译为 budget_tokens"是过时结论，已被推翻（见 §15.10 C2）**。
- **`temperature/top_p/top_k` 在 4.7/4.8/Fable 上 → 400（已移除）**；`ProviderCapabilities` 必须按模型过滤、**丢弃不接受的参数而非盲传**（与 §4.4 一致）。
- **prompt cache 最小可缓存前缀按模型不同**：Opus 4.8/4.7/4.6/4.5、Haiku 4.5 = **4096** token；Fable 5、Sonnet 4.6 = 2048；Sonnet 4.5 = 1024（**笔记"~1024"对 Opus 4.8 不准**，ContextAssembler 按目标模型取阈值，低于则不打 `cache_control` 以免误判 UsageUpdate）。最多 **4 个 breakpoint**；render order **tools → system → messages**；`cache_control` 打在 **tools 数组末元素 / system 末块**；`usage` 必须落 `cache_creation_input_tokens`（写缓存加价 1.25×/2×）+ `cache_read_input_tokens`(0.1×) + `thinking_tokens`，否则成本低估 25%~100%。`ttl` 两档 5m/1h（批处理 recipe 用 1h）。
- **cache 失效分层**：改 tools/model → 全失效；改 system → system+messages 失效；改 message → 仅 messages（`tool_choice`/`thinking` 开关**不破** tools+system cache）。→ MCP 动态 `tools/list_changed` 走显式重建、不在 turn 中途热换（§3.3）；`resolveAvailable()` 工具顺序稳定（内置按注册序、MCP 按 server+name 字典序）防 cache miss。
- **Opus 4.8 mid-conversation `role:"system"` 消息**：把算子指令作为 `{role:'system'}` **追加进 messages**（不改顶层 system），**不破缓存前缀**且是**抗 prompt-injection 的算子权威通道**。→ 强化 §5.2/§9.5：yo.md 群级硬规范在 Opus 4.8 走 message-role=system，旧模型回退 user-turn 的 `<system-reminder>` 文本块。
- 服务端 compaction(beta `compact-2026-01-12`) 与 context-editing(`clear_tool_uses`) 是两套独立能力，作 Provider 层**可选** flag；yo-agent 默认自管 `Condenser`（§5.1）以跨 provider 一致。`stop_details` 仅在 `stop_reason=='refusal'` 时非空，读前必判空（§2.4 refusal 处理）。双轨 tool-calling 累积：Anthropic `input_json_delta.partial_json` / OpenAI `tool_calls[].arguments` **拼完才 `JSON.parse`**。

### 15.5 上下文与记忆（补 §5）
- **compact 后 prompt cache 必失效** → `shouldCompact()` 增"距上次 compact 轮次/时间"guard，防频繁手动 compact 叠加 cache-miss；ADR-6 补此成本后果 + 每日 compact 次数告警。压缩流程末**重设 cache breakpoint**（summary 之后），`condense(events,{hint?})` 把 `/compact` 指令注入 Handoff 摘要 prompt。
- auto-memory 两级懒加载：`MEMORY.md` 索引（启动加载前 200 行/25KB cap）+ per-topic 文件按需 `read`；subagent 用独立 `agent-memory/`。`@import` 路径**相对导入文件位置**（非 cwd），与 skill `@-reference` 共用 resolver。
- yo.md 质量清单：≤200 行/写事实非愿望/禁 secrets/禁过时/无临时 TODO；分 topic 规则放 `.yo-agent/rules/<glob>.md` 懒加载。长任务范式：`.yo-agent/<task>/plan.md`(目标/阶段/checkpoint) + session 分段 + git checkpoint + subagent 隔离（§13 Phase 4）。

### 15.6 Skills / subagent / recipe（补 §8）
- **Skill 渐进披露**：ContextAssembler 每轮 `SkillRegistry.listSummaries()` 把 `{name,description}` 摘要目录（近零 token）追加到 system 尾；LLM 识别后 `skill_activate(name)` 拉全文（压缩时受保护）。`SKILL.md.description` 用 **核心场景 + TRIGGER 关键词 + SKIP 条件** 三段（决定 ~95% 自动激活精度）。
- **`SKILL.md` 的 `tools?` 是 yo-agent 扩展**（Claude Code 原生 frontmatter 仅 `name + description`，工具约束归 recipe/subagent）——文档显式标注，避免误以为是 CC 标准（§15.10 C 系列）。SkillLoader 加载时展开 `@checklist.md` 等多文件引用。
- recipe / subagent frontmatter 完整字段：**`description`(最关键，决定主 agent 是否调用)** / `tools`(参数级 `Bash(gh pr diff:*)`) / `disallowedTools`(黑名单优先) / `model` / `permissionMode` / `isolation` / `memory` / `maxTurns` / `parameters`。
- §8 补**扩展机制选型决策矩阵**：确定性强制→Hook；知识/规范→yo.md/skill；自主行为→skill；独立子任务→subagent（反模式："commit 前跑测试"写 yo.md 会 ~5% 漏，应 PreToolUse hook）。project 级 `.yo-agent/skills/` 提交 git 即全队共享（一等协作特性）；配 `.yo-agent/evals/<skill>/case-N.md` + CI 评测门（§13 Phase 4/5 退出）。

### 15.7 安全（补 §9）
- `ConfirmationPolicy.decide()` 标 **async**（可查 RBAC/风控/DB），返回 `deny/allow/ask_user`——SaaS 多用户核心扩展点；ApprovalGate 增 per-session 计数（`maxCallsPerSession`）。
- permission mode 枚举扩展：`read-only(=plan) / supervised(=default) / accept-edits / autonomous / ci(dontAsk) / bypass(仅容器)`，Shift+Tab 三档循环。
- **Protected Paths 硬编码枚举**（`.git`/`.yo-agent`/`yo.md`/`.ssh`/`*.pem`/`*.key`/shell rc/.npmrc），非 bypass 模式 **allow 规则不可覆盖**。fetch 类工具 SSRF 白名单（默认 block `169.254.0.0/16`/localhost/`10/8`）；`ToolCallOutput` 注入前经 PostToolUse `OutputSanitizer` hook 做 PII 脱敏（企业硬需求）。

### 15.8 持久化与可观测（补 §10）
- `usage` 表 / OTel span 补 `cache_creation_tokens / thinking_tokens / task_type / is_batch`。新增核心 metric+告警：`compact.frequency`、`cache.hit_rate`(=cache_read/(cache_read+cache_creation+input)，target >70%)、`compact.token_reduction_rate`、日成本 >3× 基线、单用户单日配额；CLI `--show-cost` 显示实时命中率。可选 Batch API（离线 50% 折扣，Batch×Cache ≈ 原价 5%）作 `submitBatch()` + `batch_jobs` 表，用于批量抽取/评估集。

### 15.9 配置 / slash / hooks（补 §11）
- **Hook stdio JSON 协议**：stdin 固定字段 `{session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input(+tool_response/prompt/stop_hook_active)}`；**exit code 三义**：0=通过(stdout 进 transcript)、2=阻断(stderr 回灌 LLM)、其他非零=报错不阻断；JSON 输出 `decision / reason / continue / stopReason / suppressOutput`。HookHandler 补 `reason/suppressOutput`。
- HookEvent 设为**可扩展 union**，补关键事件：`PostToolBatch / StopFailure / PermissionRequest / UserPromptExpansion / InstructionsLoaded / FileChanged / Worktree* / Task* / McpElicitation`；实现类型补 `prompt`(结果追加给 LLM) 与 `agent`(spawn 子 agent) 两种；§11.3 加"已收录/暂缓/永不收录"决策表。
- **配置跨层合并语义**：hooks **叠加执行**（非覆盖）；**deny 跨层并集**；其他项 project>global 覆盖；临时配置放 `config.local.toml`(gitignore)。补第五层 enterprise/managed policy（优先级 enterprise>user>project>local>CLI）；config 预留 `kernel.bashTimeoutMs / maxThinkingTokens / obs.telemetry`；`provider.keyHelper` 脚本化密钥（接 Vault/1Password，支持轮换）。
- slash frontmatter：`description / argument-hint / allowed-tools(执行期覆盖，IM 端 /allow_once 锁死) / model / disable-model-invocation`；发现路径 `commands/<name>.md` + 子目录命名空间；`!`cmd`` / `@file` 受 allowed-tools 约束，**IM Surface 禁用 `!` 或锁 allowed-tools**（注入风险）。
- **Plan Mode 作内核可选机制**（跨章节）：内置 `EnterPlanMode/ExitPlanMode`；plan 态工具白名单强制只读（Edit/Write 全禁、有副作用 Bash 禁）；`ExitPlanMode` 触发 ApprovalGate；加对应 hook 事件。

### 15.10 需核实冲突点 —— 结论
| # | 冲突 | 结论（采纳） |
|---|---|---|
| **C1** | compaction 阈值 80% vs 85% vs 95% vs 60% | 三值对应不同层/路径，不矛盾。**默认 `0.80`，可配至 0.85**(`condenser.thresholdRatio`)；区分自动触发(80%) vs `/compact` 手动(help 写"建议 60-70%")；保留 95% 作紧急兜底。 |
| **C2** | effort 译为 `output_config.effort` 还是 `thinking.budget_tokens` | ✅ **claude-api 核查：`output_config.effort` 正确且是原生 GA 字段**（low/medium/high/xhigh/max）。`budget_tokens` 在 4.7/4.8/Fable 已**移除**(400)，仅旧模型用。**§4.2 保持 output_config.effort，推翻笔记 C2。** |
| **C3** | 内置 subagent 数量 3/4/5 | 以 claude-code.md 为准：**5 个**（Explore[Haiku,跳过约定文件]/Plan/general-purpose/statusline-setup/claude-code-guide）；yo-agent recipe 默认值参考其模型选择（explore 用便宜模型）。 |
| **C4** | WebSocket 是否支持 OAuth | 以 claude-code.md 为准：**WS 不支持 OAuth**（退化静态 header）；OAuth 必走 Streamable HTTP（§15.3）。 |
| **C5** | 子 agent `permissionMode` 在 auto 下的处理 | §2.5 `deriveSubagentPolicy` **显式定义**：父为 `autonomous`/auto 时，子自声明 permissionMode 的尊重/收紧优先级规则（不留空）。 |
| **C6** | §5.2 软约束 ↔ §9.5 硬约束缺交叉引用 | 连贯性缺口（非错误）：§5.2 注"（硬约束须写 PreToolUse hook、非 yo.md，才抗注入，见 §9.5）"，§9.5 反向指回。开放 IM 频道的群级 yo.md 尤其需要。 |
