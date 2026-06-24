# Phase 1 —— 内核 + 编程 CLI MVP

> 对应 [`DESIGN.md`](DESIGN.md) §13 Phase 1。本阶段按"零网络风险"分片交付，每片全离线可验证。
> **Slice A**：内核纵切（已完成）。**Slice B-1**：SQLite 持久化 + OpenAI 兼容 provider + yo.md 加载（已完成）。
> **Slice B-2**：Gemini / OpenAI-Responses adapter + 双轨 prompt-shim + models.dev 风目录、真 Condenser 接主循环、
> checkpoint(shadow-git) + gap 溢出降级、Ink TUI + 交互审批 + headless `--mode jsonl`（**已交付**，离线 111 测试全绿；
> 多 provider 对抗式审查 24 项确认缺陷已全部修复；**§13 退出标准已真机验证**：真实 OpenAI 兼容端点上流式对话 +
> 工具调用 + 多轮 infer→tool→observe + 熔断端到端跑通）。

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

**验证门全绿**：`pnpm run check` —— typecheck 0 错误 + 12 份 JSON Schema + **42 个测试（11 文件）**。
内核测试覆盖：纯文本 turn、工具调用事件溯源、死循环熔断、`max_tokens` 续传、审批通过/拒绝、resume。

## Slice B-1 已交付

| 包 | 实现 | 说明 |
|---|---|---|
| `@yo-agent/store` | **`SqliteEventStore`** | `node:sqlite`（Node 内置，免原生编译）落盘持久化；append/read/head + 拒绝非递增 cursor + 重开仍可读；不支持环境 `open()` 抛错，CLI 自动降级内存 |
| `@yo-agent/provider` | **`OpenAiCompatibleProvider`** | `/v1/chat/completions` 兼容端点，一个 adapter 覆盖 OpenAI Chat / DeepSeek / Ollama / OpenRouter / Groq（配 `baseUrl`+`headers`）；SSE 流式工具调用解码 + body 构造单测 |
| `@yo-agent/kernel` | **`loadConventionFiles`** | yo.md / AGENTS.md / CLAUDE.md 发现链（全局→根→cwd 合并，每目录取第一个，32 KiB 上限）；CLI 自动注入为 system（§5.2） |

端到端：`YO_DB=path` 跑 CLI → 事件落 SQLite（实测 `SessionStarted→TurnStarted→AssistantText→TurnCompleted`，重开可读）。

## Slice B-2 已交付

| 包 | 实现 | 说明 |
|---|---|---|
| `@yo-agent/provider` | **`GeminiProvider`** | `:streamGenerateContent?alt=sse`；`downgradeSchemaForGemini` 降 OpenAPI-3.0 子集（剥 minLength/pattern/maximum…）；`functionResponse` parts；functionCall 整块、合成 id；finish→tool_use 修正 + flush 兜底 |
| | **`OpenAiResponsesProvider`** | `/v1/responses`；typed SSE（`output_text.delta` / `function_call_arguments.delta` / `completed`）；input item（function_call / function_call_output）；effort→`reasoning.effort`（xhigh/max 降 high）；incomplete→max_tokens |
| | **双轨 tool-calling** | `nativeStrategy` / `promptShimStrategy` + `selectStrategy(caps)`；**`PromptShimProvider`** 包弱/本地模型：工具声明注入 prompt、解析 ` ```tool_call ` JSON → 合成 ToolCall*；`encode/parse` 纯函数容错 |
| | **`ModelCatalog`** | models.dev 风 bundled 目录（caps+pricing+contextWindow）+ `estimateCost`（input/output/cacheRead/cacheWrite 分价）+ `merge` 运行时刷新 + 未知 id 优雅降级 |
| `@yo-agent/kernel` | **`SummarizingCondenser`** + `estimateTokens` | 保首+保尾原始+中段 LLM 结构化 Handoff 摘要 + 标识符逐字保留（§5.1）；边界保护尾段不以孤儿 tool_result 起头；接入主循环 `maybeCompact`（token 阈值触发 + min-rounds guard），emit `ContextCompacted` 落库、原始 EventLog 不删 |
| | **协议化交互审批** | `requestApproval` 挂起注册 pending、等外部 `decideApproval` 唤醒（§6.2），可选超时默认 deny（§6.3）；4 选项 suggestions |
| | **L3 checkpoint 接入** | edit 类工具成功后发 `FileChanged` + 调 `Checkpointer.snapshot`，快照引用落 EventStore |
| `@yo-agent/store` | **`ShadowGitCheckpointer`** | isomorphic-git 独立 gitdir 影子快照（与真实 .git 隔离）；`snapshot`/`rollback`/`list`；忽略 node_modules/.git/.yo-agent |
| | **`ResumeBuffer` + `gapOverflowSummary`** | 内存 ring 重连缺口；fromCursor 被淘汰→只保留状态变更/审批/FileChanged，折叠流式噪声（§6.3） |
| `@yo-agent/surface-cli` | **CliSurface（新包）** | Ink 差量渲染 **TUI**（`CliApp` + 交互审批 ↑↓/Enter）+ `HeadlessRenderer` + `JsonlRenderer`（`--mode jsonl`）+ `selectProvider`/`buildCondenser`/`usableContextTokens` 组合根辅助 |
| `apps/yo-agent` | **三态 CLI** | `--tui`（Ink+交互审批）/ `--mode jsonl`（结构化）/ headless；多 provider 选择 + 模型目录成本 + 可选 checkpoint/Condenser |

**验证门全绿**：`pnpm run check` —— typecheck 0 错误 + 12 份 JSON Schema + **111 个测试（22 文件）**。
新增覆盖：Gemini/Responses SSE 解码 + body + schema 降级（含 oneOf/allOf/anyOf/$ref/type 数组）+ functionResponse 真名映射、prompt-shim 解析（含未闭合块剥除）、目录成本 + 深合并、Condenser 保首尾 + head/tail 双边界保护 + 相邻 user 合并 + 接主循环、checkpoint 快照/回滚 roundtrip + untracked 清理、gap 溢出降级（含 BackgroundProcess + 上界防护）、交互审批（唤醒/超时/interrupt 解除/always 缓存/updatedInput）、OpenAI tool_result 回灌、Ink TUI 渲染 + ↑↓ 审批裁决。

**对抗式审查 + 真机验证（本轮）**：5 维多智能体审查 → 24 项确认缺陷全部修复（critical：Gemini functionResponse 用真名；high：Condenser head 孤儿 tool_use / 相邻 user / interrupt 解除审批挂起 / ResumeBuffer 上界 / jsonl 漏 SessionStarted；及 medium/low 一批）。真机端到端（真实 OpenAI 兼容端点）跑通时另发现并修复一个 Slice B-1 遗留 bug：**OpenAI Chat 适配器丢弃 `role:'user'` 内的 tool_result 块**（致工具结果不回模型、空转触发熔断），现已拆为独立 `role:'tool'` 消息。

## 运行

```bash
pnpm install
pnpm run check                                   # typecheck + gen:schema + 95 测试

# CLI 三态（FakeProvider 演示，无需 key）
pnpm --filter @yo-agent/cli start -- -p "你的提问"             # headless 文本
pnpm --filter @yo-agent/cli start -- --tui -p "你的提问"        # Ink TUI（交互审批 ↑↓/Enter）
pnpm --filter @yo-agent/cli start -- --mode jsonl -p "你的提问"  # 结构化 JSONL（给 bridge/脚本）

# 接真实 provider（流式编程对话）。可叠 YO_DB= / YO_COMPACT=1 / YO_CHECKPOINT=1 / YO_MODEL=
ANTHROPIC_API_KEY=sk-... pnpm --filter @yo-agent/cli start -- -p "用 ts 写个快排"
GEMINI_API_KEY=...        pnpm --filter @yo-agent/cli start -- -p "..."         # Gemini
OPENAI_API_KEY=... OPENAI_MODE=responses pnpm --filter @yo-agent/cli start -- -p "..."  # OpenAI Responses
OPENAI_API_KEY=... OPENAI_BASE_URL=http://localhost:11434/v1 YO_TOOL_SHIM=1 \
                         pnpm --filter @yo-agent/cli start -- -p "..."          # Ollama 等弱模型双轨
```

## 剩余（Phase 2 接力 + 后续打磨）

- **退出标准 ✅ 已达成**：真机（真实 OpenAI 兼容端点，gpt-5.5）跑通流式对话 + native 工具调用（ls）+ 多轮 infer→tool→observe + 熔断（loop_detected）+ jsonl 结构化事件流（SessionStarted→…→TurnCompleted）。交互审批/resume/checkpoint 由单测覆盖。
- **Phase 2 接力**：`ResumeBuffer`/`gapOverflowSummary` 已就绪，待 RpcSurface（JSON-RPC/JSONL + `session/* turn/* approval/*`）消费；audit 鉴权（ed25519 + 配对码）。
- **后续打磨**：effort 按模型 capabilities 过滤再发（§15.4，当前内核未发 effort 故为潜伏项）；Gemini/Responses 的 thinking 块原样回传与跨模型丢弃；prompt-cache breakpoint 注入；provider fallback 链/auth rotation。
