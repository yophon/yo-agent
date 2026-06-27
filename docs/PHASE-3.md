# Phase 3 —— MCP host + ACP + 上下文/记忆打磨（接生态另一半）

> 对应 [`DESIGN.md`](DESIGN.md) §13 Phase 3 / §3.3 / §5 / §15.3 / §15.5。延续 Phase 0-2 的「离线可验证 / 零开放渠道风险」分片：每片用 in-memory transport + 本地 stub MCP server / `@zed-industries/agent-client-protocol` 的 client 端离线对驱验证，**不依赖真实第三方 server 或浏览器 OAuth**（端到端真机冒烟仅在指定切片末做一次）。
>
> **Phase 2 收口基线**：145 测试（28 文件）全绿。本阶段在此之上增量交付，每片末跑全量回归不退化。
>
> **本计划已经过代码级精读（7 子系统）+ 三角度切片设计 + 对抗式完备性批判**。批判核实并修正了若干「设计文档以为要从零做、实则现状已有」的误判，见 [§现状已核实修正](#现状已核实修正避免重复造轮)——这是本计划与朴素拆分的关键差异。

---

## 范围与排序原则

Phase 3 有两条字面退出标准（DESIGN §13）：

1. **yo-agent 挂外部 MCP server 并用其工具**（接生态：把别人的工具拉进来）。
2. **被 Zed/JetBrains 经 ACP 接管跑通编程对话**（接生态：被 IDE 当 agent 后端）。

外加一组与上述正交的上下文/记忆打磨（结构化 Handoff + 标识符保真 + 动态 auto-memory）。

**排序原则（风险优先 / 护栏底座先行）**：外部 MCP server 是**不可信输入源**。所有最危险的失败模式——撞名静默覆盖、prompt-cache 前缀漂移、`approval:'never'` 绕过审批、脏 schema/注入式 description 直达 provider、in-flight 调用挂死整个 turn——都在「引入外部工具」那一刻触发。因此**先把纯本地、纯单测可验的护栏底座（3A）做掉，再接外部连接（3B/3C）**，比把护栏混进 happy-path 片更可验、回归面更清晰。ACP（3F）依赖 3A 暴露的 `risk` 评估与 `signal` 接缝。上下文打磨（3D/3E）与 MCP/ACP 正交，可并行。

### 退出标准达成口径（写死，否则达成度无法判定）

- **退出标准①**：在 **3C 末**用真实 npm MCP server（`@modelcontextprotocol/server-filesystem` 作 stdio）冒烟——host 连它、LLM 调用其 `read_file` 成功。这是唯一一次真机网络/子进程冒烟，对齐 Phase 1/2「单测覆盖 + 末尾真机验证退出标准」的范式。
- **退出标准②**：接受「`@zed-industries/agent-client-protocol` 的 client 端经 loopback/InMemoryChannelPair 离线对驱 = 切片完成；真实 Zed/JetBrains GUI 接管留人工验收」。理由同 Phase 2 用 SDK `Client` 验 MCP server——协议层等价于真实 IDE 接管，且离线可 CI。

---

## 切片总览

| 片 | 标题 | 服务退出标准 | 依赖 | 新建包 | 离线可验证 |
|---|---|---|---|---|---|
| **3A** | 工具集稳定性底座 + 内核共享接缝（**无外部连接**） | ①② 前置 | — | — | ✅ 已交付 |
| **3B** | MCP host 连接层 + 三层信任配置（stdio，opt-in 防供应链） | ① | 3A | — | ✅ 已交付 |
| **3C** | MCP host 韧性（懒加载/TTL/熔断/取消超时/跨进程重连/连接状态） + **真机冒烟①** | ① | 3B | — | ✅ 已交付(+真机) |
| **3D** | Condenser 结构化 Handoff + 标识符保真（**增量改造**） | 打磨 | — | — | ✅ 已交付 |
| **3E** | 动态 auto-memory（独立 MemoryStore + workspace 隔离 + @import） | 打磨 | (3D 蒸馏子项) | — | ✅ 已交付 |
| **3F** | AcpSurface（复用 RpcSurface 骨架 + 事件翻译 + request_permission + fs/*） | ② | 3A | `surface-acp` | ✅ |
| **3G** | MCP 进阶通道（resources/prompts/sampling/progress） + Streamable HTTP/OAuth | ① 增强 | 3B,3C | — | ✅(OAuth mock) |

> 3A 是 3B/3C/3F 的共享前置（`signal`/`risk`/工具排序均跨 MCP 与 ACP）。3D/3E 与 MCP/ACP 全正交，可与 3B-3C 并行推进提高吞吐。3G 隔离出最依赖外网/OAuth、最可能 WIP 拖延的部分，不阻塞退出标准①（本地 server 在 3B/3C 已达成）。

---

## 3A — 工具集稳定性底座 + 内核共享接缝（无外部连接） ✅ 已交付

**目标**：在引入任何 MCP 连接代码前，把「外部工具会触发的所有危险」防住，且全部纯本地可单测。同时把 MCP 与 ACP **共享的内核接缝**（`signal`、`risk`、ContextCompacted 字段、工具排序）一次性打底，避免后续片反复改 `kernel.ts`、避免「先写 `callTool(ctx.signal)` 后接线」的悬空。

**交付物**：
- **撞名护栏**：`InMemoryToolRegistry.register` 增同名检测（`registry.ts:14` 现为 `Map.set` 后写覆盖前写）——MCP 工具与内置 `read/write/ls` 或跨 server 撞名时抛错/告警，禁止静默丢工具 + `executor(name)` 错路由（`kernel.ts:374`）。
- **命名校验器** `assertMcpToolName(server, tool) → mcp__{sanitize(server)}__{tool}`（server 名仅 `[a-z0-9_-]`），落实 `index.ts:19` 当前仅注释的命名约束。
- **审批 clamp**：注入 `owner:'mcp'` 工具时工厂层强制 `approval !== 'never'`（默认 `'risk-based'`），堵住「误设 never 跳过 ApprovalGate（`kernel.ts:342`）」。
- **schema 清洗器** `sanitizeMcpInputSchema(jsonSchema)`：`maxDepth`/`maxProps`/`maxStringLen` 上限（建议 8/64/8192，列为常量）、剥/拒不合规结构、`description` 截断 + `[external]` 前缀（降 tool-poisoning 注入面）；解不开则降级 `{type:'object'}` 并告警。置于 `register` 前、`kernel.ts:557` 透传 provider 前；与 `downgradeSchemaForGemini`（`gemini.ts:149`）剥除清单语义一致（清洗后仍须能过 Gemini 降级）。
- **工具排序修正（§15.4 隐蔽 violation）**：`resolveAvailable` 当前是**全局字典序**（`registry.ts:24` `a.name < b.name`），不区分来源——MCP 工具混入会改变**内置工具的相对前缀位置**，击穿 prompt cache。改为 **内置按注册序、MCP 按 `server+name` 字典序** 两段拼接（§15.4 规定）。
- **toolset 版本化 + turn 内 snapshot**：`resolveAvailable` 加单调 `toolsetVersion`（注册/反注册自增）；kernel 在一个 turn 起点 snapshot 一次可见工具集，**turn 中途的增删不改本 turn 可见集**（防 prompt 前缀漂移）。为 3C 的 TTL/熔断动态增删铺路。
- **`registry.unregister(name)` + `evalAvailability` 接 `configFlag`/health 谓词**：`registry.ts:34-39` 现仅实现 `always/allOf/anyOf`，`surface/profileHasTool/configFlag` fall-through 默认放行（注释 `registry.ts:33` 已标「后续阶段接 ctx」）。接真实谓词，使 3C 熔断时「server 离线→工具 `availability=false` 从 `resolveAvailable` 消失」可声明式表达。
- **内核接缝 `signal`**：`toolCtx(s)`（`kernel.ts:550`，现仅 `{sessionId,cwd}`）补 `AbortSignal`；`runTurn` 起 `AbortController`，`interrupt()` 触发 abort（现仅翻 `s.interrupted` 在 step 间检查，不取消 in-flight）。`ToolContext.signal` 类型字段已存在（`tools/index.ts:36`）但从未接线。
- **`RiskLevel` 评估器**：替换 `kernel.ts:488/498/500` 硬编码 `'unknown'`。输入维度明确为 **`ToolKind` 静态分级 + input 内容动态升级**（如 `edit`/`execute` kind 为 medium，命中 Protected Paths（§15.7）升 high）；列出关键词/kind→RiskLevel 映射表常量。ACP `request_permission` 的风险分级依赖此真实值，故必须在 ACP（3F）之前就位。
- **`ContextCompacted` schema 扩展**：加 `handoffSummary?` / `preservedIdentifiers?` 字段（`events.ts:134-138` 现仅 `fromCursor/toCursor/tokensSaved`），同步 `AGENT_EVENT_KINDS`（`events.ts:181`）+ `store/resume.ts:18` 重放白名单 + Go schema 生成。为 3D 落库铺路（schema 变更集中在 3A，3D 只填值）。

**触及**：`packages/tools`、`packages/kernel`、`packages/protocol`。**退出标准**：
- 重复 register 同名工具被拒；`mcp__` 工具与内置 `read` 撞名被拒。
- turn 进行中并发 register 新工具，本 turn `resolveAvailable` 快照不变、下一 turn 才出现；`toolsetVersion` 自增可观测。
- 内置工具相对顺序在 MCP 工具注入前后不变（排序修正断言）。
- `approval:'never'` 的 `owner:'mcp'` 被 clamp 到 `'risk-based'`。
- 恶意 schema（超深/超长 desc/`$ref` 环）被清洗或安全降级，降级后仍过 `downgradeSchemaForGemini`。
- `interrupt()` 触发 `toolCtx.signal` abort（hang stub executor 验证）；per-call 超时同样 abort。
- `edit`/`execute`/Protected-Path 工具的 `ApprovalRequested.risk` 非 `'unknown'`。
- 现有 145 测试全绿。

**交付状态**：tools 护栏（撞名/`unregister`/版本化/两段排序/`configFlag` 谓词/MCP 命名+schema 清洗纯函数）+ kernel signal 接缝（turn `AbortController`/per-call 超时/turn 内 **desc 与 executor 双 snapshot**）+ `assessRisk` 评估器。验证门 **172 测试（30 文件）** 全绿。经 5 维对抗式审查（24 agents，19 findings → 9 确认）全部修复：
- **SNAP-1/2**（核心）：executor 与 desc 同源 snapshot（`execMap`）——mid-turn `unregister` 不影响本 turn 执行；snapshot 外工具（`desc===undefined`）拒绝执行、不绕审批/risk。
- **CONC-2**：`interrupt` 后工具循环早退，不回填中断 observation、不 compact（防 resume 上下文污染）。
- **RISK-01/02/05**：`riskProbeText` 补 `file_path`/`paths`/`files`；危险命令补 `--recursive`/`--force` 长选项；`sanitizeMcpInputSchema` 改路径栈语义（不误判共享 `$defs` 为循环）。
- **SNAP-4 / TST-3/4**：前瞻注释 + snapshot 不变性 + 撞名不污染断言。
> **TST-5 登记（3B 必补）**：MCP 注入链端到端——`owner:'mcp'` 工具经 `clampMcpApproval`（`never`→`risk-based`）后 kernel 必走 `ApprovalGate`；`sanitize` 后 schema 进 `ToolSpec`。纯函数已单测，端到端衔接待 3B。

---

## 3B — MCP host 连接层 + 三层信任配置（stdio，opt-in 防供应链） ✅ 已交付

**目标**：实现 outbound MCP client：连接 → `tools/list` 发现 → 经 3A 护栏映射注册 → `tools/call` 包成 `ToolExecutorRef`。核心风险是**供应链**：project 配置默认不激活，必须显式 opt-in 信任。

**交付物**：
- `packages/surface-mcp/src/mcp-host.ts`：`McpConnection`（封装一个 SDK `Client` + 一个 `Transport` + 生命周期）+ `McpHostManager`（多 server 编排、register/unregister 到 registry）。与 `mcp-surface.ts`（作 server）对称——`createStdioClientTransport(params)` 对称于既有 `createStdioTransport()`（`mcp-surface.ts:24`），SDK 依赖收在本包；`index.ts` 新增 `./mcp-host` re-export，app 依赖面不扩大。
  > **决策**：MCP host 落在 `packages/surface-mcp`（新增文件）而非独立新包——server/host 是对称物，复用度最高；若后续 host 体量膨胀再拆 `@yo-agent/mcp-host`。
- **三层配置解析**（§15.3）：`~/.yo-agent/mcp.json`（user，激活） / `.yo-agent/mcp.json`（project，**默认 inactive，需显式 opt-in 信任记录**，防供应链） / local。`${VAR}` 走 `process.env` 展开，**绝不写回配置文件、不入日志**；缺失变量报错而非静默空。
- `toolDescriptorFromMcp(server, tool)`：SDK `Tool{name,description,inputSchema}` → `ToolDescriptor`（`owner:'mcp'`、3A 命名校验、3A schema 清洗、`kind` 默认 `'other'`、`approval:'risk-based'`、`availability` 绑连接健康为 3C 留 `configFlag`）。`inputSchema` 经清洗后原样入 `descriptor.inputSchema`，自动经 `kernel.toolSpecs`（`kernel.ts:554-558`）→ provider，Gemini 降级在 provider 层无需改。
- `mcpExecutor(client, remoteName)`：`execute()` 内 `await client.callTool({name,arguments:input}, undefined, {signal: ctx.signal})`，`CallToolResult.content[]` 逐块归一为 `ToolEvent{kind:'output',chunk}`；`isError` → throw 触发 kernel 既有 `ToolCallCompleted{status:'error'}`。**已知有损降级**：images/resource-link/structured 内容当前压成 string chunk（`ToolEvent` 仅文本），非文本承载推迟（见 §已知限制）。
- **app 布线**：`main.ts:114-115`（`builtinTools` 注册后）插入 host 引导（连 server → `tools/list` → register），host 工具走 `buildKernel` 的**真实 `ApprovalGate`，绝不复用 `autoApproveGate`**（`mcp-surface.ts:17` 那是把不受信第三方工具无审批放行的安全灾难）。

**触及**：`packages/surface-mcp`、`apps/yo-agent`、`packages/tools`。**退出标准**：
- 本地 stub MCP server（SDK `McpServer` + `InMemoryTransport`，同进程）暴露 `echo`/`add`，host 连后 `resolveAvailable` 含 `mcp__stub__echo`/`mcp__stub__add` 命名正确、字典序稳定。
- kernel 跑一轮，FakeProvider 产出 `mcp__stub__echo` 调用 → `callTool` → 输出回流为 `ToolCallOutput/Completed`。
- project `mcp.json` 未 opt-in 时其 server 工具不进 registry；opt-in 后才出现。
- `${VAR}` 展开成功且配置文件未被改写；缺失 env 报错。
- host 工具默认 `risk-based`，无 gate 时被 deny（不静默执行、不绕审批）。
- 现有测试全绿。

**交付状态**：`mcp-config.ts`（三层配置解析 + opt-in 信任门 + `${VAR}` 展开，纯函数 + fs 薄包）+ `mcp-host.ts`（`McpConnection`/`McpHostManager`/`createStdioClientTransport`/`toolDescriptorFromMcp`/`mcpExecutor`/`listAllTools`/`mapDiscoveredTools` + 健康标志喂 `toolFlags`）+ `main.ts` 引导（`bootstrapMcpHost` + `installShutdown`，rpc/headless/tui 用真实 `ApprovalGate`，**mcp-server 模式不引导**防 autoApprove 放行外部工具）。验证门 **202 测试（32 文件）** 全绿。
- **TST-5 兑现**：端到端 `owner:'mcp'` 工具经 `clampMcpApproval` 必走 `ApprovalGate`、`risk='medium'`（非 unknown）、`allow→callTool` 输出回流；无 gate→默认 deny。
- 退出标准全覆盖：stub server（`InMemoryTransport`）连接后 `mcp__stub__{add,boom,echo}` 命名正确、外部段字典序稳定；project/local 未 opt-in 不进 registry、信任后出现；`${VAR}` 展开且磁盘配置未改写、缺变量 per-server 跳过；`availability` 绑健康标志（无 flag 不可见，3C 熔断接缝）。

**对抗式审查（5 维 + 完备性批判，64 agents）**：23 候选 → 18 确认（含跨维去重后 11 真问题）全部修复：
- **HIGH ×2**：① local 层（仓库内、无法保证 gitignore）曾无条件最高优先级合并 → 绕过信任门；现 **local 同 project 一律 opt-in 信任门**（仅 user 自动激活）。② 单个非法远端工具名（`toolDescriptorFromMcp` 在 `.map` 内抛错、在 per-tool try/catch 之外）曾拖垮整台 server；现抽 `mapDiscoveredTools` **per-tool 隔离** + `mcpToolName` 清洗 tool 段（字符集白名单 + 64 长度上限 + 稳定哈希后缀）。
- **MEDIUM ×4**：③ 单 server 缺 `${VAR}`/单层文件损坏曾连累全部 server → **per-server 展开隔离 + per-layer 读隔离**（与 `host.start` 容错口径一致）。④ rpc 常驻/异常路径不回收子进程 → `installShutdown`（SIGINT/SIGTERM/EPIPE）+ headless/tui try/finally `closeAll`。⑤ `listTools` 忽略 `nextCursor` 丢分页工具 → `listAllTools` 游标循环。⑥ 丢 `structuredContent`（outputSchema 工具空观测）→ 空 content 时回退 `JSON.stringify`。
- **LOW ×4**：信任清单 `JSON.parse` 无保护 + null 顶层 `TypeError`（fail-closed 守卫）；`command` 不展开但文档自相矛盾（parse 阶段拒 `${`）；成功/错误路径块拼接不一致（统一 `join('\n')`）；规范化名撞名空载子进程（spawn 前守卫）。
> **DEFER**：信任仅按 server 名 pin、不绑 `command` 指纹（TOCTOU 硬化）——需先有写信任记录的 opt-in CLI 才能落哈希，手写信任文件无法附指纹，记为后续硬化项。已知取舍：MCP 非文本内容（image/audio/resource）仍有损降级为占位串（Phase N）。

---

## 3C — MCP host 韧性 + 真机冒烟① ✅ 已交付

**目标**：处理 MCP host 的运行时危险——长挂 `callTool`、server 掉线后工具仍可见、TTL 清理与 in-flight 竞态、`tools/list_changed` 破 cache、跨进程 resume 后连接丢失。把连接健康回路接到 3A 的 `availability`/版本机制。**末尾做退出标准①真机冒烟**。

**交付物**：
- **会话级懒加载 + 空闲 TTL(10min) 断连**；TTL 清理前查 in-flight 调用计数，有未完成则推迟断连（防竞态）。
- **失败熔断状态机**：连续失败 ≥ `BUNDLE_MCP_FAILURE_THRESHOLD=3` → 60s 冷却（§15.3），冷却期 server 工具经 3A `unregister`/`configFlag` 联动 `availability=false` 从 `resolveAvailable` 消失；冷却后恢复。
- **per-call 超时**（默认 60s 可配）：超时 → `signal` abort + `ToolCallCompleted{error}`，不阻塞整个 turn。复用 3A 的 `toolCtx.signal` 接缝。
- **`tools/list_changed` 不热换**（§15.4 prompt cache）：显式重建工具集 + `toolsetVersion` 自增，经 3A 的 turn 内 snapshot 保证不在 turn 中途漂移前缀。
- **跨进程 resume 重连**（批判定调为交付项，非开放问题）：`resumeSession`（`kernel.ts:132`）在新进程重建会话后，host 须**重连 + 重注册** `mcp__` 工具，否则之前可见工具从 `resolveAvailable` 消失→工具集漂移→击穿 cache + 历史 `tool_use` 指向消失工具。
- **连接状态可观测**：新增 `McpServerConnected/Disconnected/Failed` AgentEvent 变体（或复用 `BackgroundProcess`——见 §待决），同步 `AGENT_EVENT_KINDS` + `resume.ts:18` 白名单 + Go schema。
- **`getServerCapabilities()` 协商**：判断远端是否支持 tools/resources/prompts（为 3G 铺路）。
- `>20` 工具时启 **ToolSearch 懒加载**占位（只暴露稳定摘要前缀，保字典序）——见 §待决（复用既有 ToolSearch 机制 vs host 内部自管）。

**触及**：`packages/surface-mcp`、`packages/kernel`、`packages/tools`、`packages/protocol`、`packages/store`。**退出标准**：
- 熔断：stub 连续 3 次失败 → 60s 冷却（注入时钟）工具从 `resolveAvailable` 消失、冷却后恢复。
- 取消：stub 工具 hang，`interrupt()` 后 `callTool` 收到 abort、turn 不阻塞；per-call 超时同样触发。
- 竞态：TTL 到期遇 in-flight 调用，断连推迟到完成；turn 中途 `list_changed` 不改本 turn 可见集、版本自增。
- resume 后 `mcp__` 工具重连重注册、工具集不漂移。
- `McpServerConnected/Disconnected` 落 EventLog 且在 resume 白名单，Go schema 同步。
- **真机冒烟①**：本机起 `@modelcontextprotocol/server-filesystem`（真实 npm server，stdio），host 连它，LLM 用其 `read_file` 成功 → **退出标准① 达成**。
- 现有测试全绿。

**交付状态**：`mcp-host.ts` 韧性回路——`CircuitBreaker`（阈值3→60s冷却→半开，纯时钟驱动）+ mcpExecutor MCP-local per-call 超时（默认60s）+ 失败归因 hooks + 空闲 TTL `sweepIdle`（in-flight 守卫防竞态）+ `tools/list_changed` 显式重建（脏位 coalescing + await 后连接复核）+ `ensureConnected` 按需重连（`connecting` map 并发去重）+ `statusSnapshot`/`epoch` 世代号；kernel `syncMcpStatus`（连接状态 diff 落 EventLog，**仍唯一事件写者**）+ `invalidateMcpApprovals`（epoch 变→失效审批缓存）+ 超时 reason `TimeoutError` 归因；`McpServerStatus` 协议变体（enum/discriminatedUnion/`AGENT_EVENT_KINDS`/resume 白名单/JSON+Go schema 全同步，21 变体）；`main.ts` 布线（`mcpStatusSource`/`mcpEnsureConnected`/`onStatus` + rpc 空闲清理 interval）。验证门 **228 测试（32 文件，+25）+ 真机冒烟** 全绿。

- **退出标准① 达成**：真机起真实 `@modelcontextprotocol/server-filesystem`（stdio 子进程，npx 缓存），host 连接发现 14 个真实工具、kernel turn 调其 `read_file` 读回文件内容（`mcp-smoke.test.ts`，`YO_MCP_SMOKE=1` 门控离线 CI，亲测通过）。
- 退出标准全覆盖：熔断（注入时钟）flags 显隐 + 冷却恢复；per-call 超时 + 用户中断/超时/传输错失败归因；TTL 到期遇 in-flight 推迟断连；list_changed 重建 + `toolsetVersion` 自增；跨进程 resume 重连不漂移；`McpServerStatus` 落 EventLog + resume 白名单 + Go schema 同步。

**对抗式审查（6 维 + 完备性批判，43 agents → 二轮聚焦复验 3 agents）**：首轮 10 确认 + 3 补充、二轮 1 阻断，全部修复：
- **HIGH ×1（SEC-8）**：`list_changed` 重建可经会话审批缓存 rug-pull 绕审批（被入侵 server 换同名工具实现）→ host 加 `epoch` 世代号（连接/重连/重建 +1、跨 disconnect 不重置），kernel 据 epoch 变化失效该 server 审批缓存，强制重新走 ApprovalGate。
- **阻断 ×1（CONC-RECONN-1，二轮复验发现）**：并发 `ensureConnected` 对同一 server 双连接（子进程泄漏 + 工具孤儿）→ `connecting` map 按 server 名去重，复用进行中 promise。
- **MEDIUM/LOW**：list_changed 风暴丢通知→脏位 coalescing；重建 await 后未复核连接→孤儿工具→连接复核（`conns.get(name)!==conn` 弃置）；空闲断连无重连→`ensureConnected` 按需重连（`specs` 转活）；冷却期成功提前清零→honor 固定冷却 + 保留半开计数；turn 中途熔断漏记→tool 循环后补 `syncMcpStatus`；双层超时误判为用户中断→`TimeoutError` reason 归因；`toolCount` 陈旧→epoch 变化触发 emit。
> **已知限制（残留，记 Phase N）**：① 超长（>idleTtl）单 turn 内 `sweepIdle` 可能断开本 turn 快照引用但未调用的连接（按需重连 + in-flight 守卫已大幅缓解，失败工具下一 turn 自愈）；② resume 不重播 `lastMcpStatus`（崩溃前 connected 的 server 重连失败时观测态滞后，仅观测无功能影响）；③ list_changed 重建按 server 名（非 conn 身份）键的窄自愈竞态；④ `ensureConnected` 重连不接 turn signal（不可中断，SDK 请求超时兜底）。MCP 非文本内容（image/audio/resource）仍有损降级（沿 3B）。

---

## 3D — Condenser 结构化 Handoff + 标识符保真（增量改造，非新建） ✅ 已交付

> **现状已核实**：`condenser.ts` **已实现** 保首(`keepFirst=2`)+保尾(`keepTail=6`)+中段 LLM 摘要三段式、便宜模型摘要器（`makeProviderSummarizer`）、`SUMMARY_SYSTEM` **已含**四节「目标/已发生/当前状态/下一步」+「逐字保留不透明标识符」prompt（`condenser.ts:35-40`）。`minStepsBetweenCompact` guard **已存在**（`kernel.ts:417-419`）。**Phase 3 的真正 delta 很小**——不要重复实现既有逻辑。

**目标**：把摘要从「自由文本」升级为「可机读 + 可审计 + 可 resume 复原」，并用**机制（diff 校验）而非 prompt 文字**保证标识符逐字保留。

**交付物（仅增量）**：
- **结构化 Handoff**：`Summarizer`（`condenser.ts:23`）返回结构对象（zod `{goal, whatHappened, currentState, nextSteps, preservedIdentifiers[]}`）并校验；`condense` 产出落地为单条 user 消息时**保持 `mergeAdjacentUser` 不变量**（`condenser.ts:99-110`，Anthropic 严格交替）。把结构化 Handoff 写入 3A 已扩展的 `ContextCompacted.handoffSummary`（`maybeCompact` `kernel.ts:416-436`）。
- **标识符保真机制**：压缩前抽取中段标识符集合（UUID/path/hash/URL/error-code 正则）→ 压缩后 **diff 断言逐字包含** → 缺失则回填注入或对便宜模型**单次重试**。这是确定性护栏，替换「纯靠 `condenser.ts:38-39` 的 prompt 文字约束」。
- **compact guard 校准**：`minStepsBetweenCompact` 仅补「刚 compact 完不立即再 compact」语义 + cache 失效成本注释 + 测试（**标注「已存在 `kernel.ts:417`，仅补语义+测试」**）。

**触及**：`packages/kernel`、`packages/protocol`。**退出标准**：
- 含 5 个 UUID/path/hash 的中段，stub summarizer 故意丢 2 个 → 校验器检出并回填/重试，最终 summary 含全部标识符。
- `condense` 产出过 Handoff zod 校验、四节齐全；`ContextCompacted` 落库带 `handoffSummary`，resume 后结构化交接可读回。
- `mergeAdjacentUser` 不变量保持（无相邻 user、无孤儿 `tool_use`/`tool_result`）。
- 连续两次满足 token 阈值，guard 阻止第二次立即 compact。
- 现有测试全绿。

**交付状态**：`HandoffSummarySchema`（protocol，四节 zod）+ `ContextCompacted` 扩 `handoffSummary?`/`preservedIdentifiers?`（向后兼容可选字段，变体数仍 21，JSON Schema 重新生成）；`condenser.ts` 增量改造——`parseHandoffSections`（确定性解析便宜模型四节 markdown，无标题回退 whatHappened 不丢内容）+ `extractIdentifiers`（URL/UUID/path/hash/error-code 消费式去重提取，过滤散文误命中）+ **标识符保真机制**（diff 检出缺失 → 对便宜模型单次重试 → 仍缺则确定性回填段，保证渲染后逐字含全部）+ `onHandoff` 回调（向后兼容，**不改 `condense` 返回类型**，内核据此填 ContextCompacted 落库）；`maybeCompact` guard 补 cache 失效成本注释。验证门 **264 测试（+36）** 全绿。
- 退出标准全覆盖：5 标识符故意丢 2 → 重试补齐（无回填段）/ 恒丢 → 回填段保证逐字全含；四节解析 + 无标题回退；`ContextCompacted` 落 `handoffSummary`；`mergeAdjacentUser` 不变量保持（沿用既有边界保护测试）；`minStepsBetweenCompact` guard 阻止立即再压。
- **审查节奏（ADR-14）**：本片为纯本地上下文打磨，按新节奏只做实现 + 针对性单测（标识符保真机制有专测），大规模对抗式审查随 Phase 3 整体收口统一做。

---

## 3E — 动态 auto-memory（独立 MemoryStore + workspace 隔离 + @import） ✅ 已交付

> **决策（避免违反 ADR-1）**：auto-memory 持久化走**独立 `MemoryStore` 子系统**，**不扩展冻结的 `EventStore` 接口**（`store/index.ts:39`，ADR-1 把 EventLog 设为唯一事实源的冻结接口）。`MemoryStore` 与 EventLog 共 SQLite 库不同表（`memory` 表 PK `workspace_path+key`），`MemoryEventStore`/`SqliteEventStore` 不受影响。

**目标**：agent 具备跨会话长期记忆，**严格按 workspace/git repo 隔离**，@import 防逃逸/循环。

**交付物**：
- `MemoryStore`（新）：`MemoryRecord{workspacePath, key, content, updatedAt, source}` + `readMemory/writeMemory/listMemory(workspacePath)`；SQLite `memory` 表 + 内存实现（文件名 `automemory.ts`，**避免与既有 `MemoryEventStore` 命名混淆**）。
- **context-files 两级懒加载**（§15.5）：`loadConventionFiles`（`context-files.ts:18-40`）文件名表加 `MEMORY.md`；MEMORY.md 索引 cap **前 200 行 / 25KB**（§15.5 精确数字，非 32KiB 整体预算）；per-topic 文件按需 `read`。
- **workspace 隔离根**：以 git repo 根或显式 `workspaceRoot` 为隔离边界（`ConventionOpts` 加 `workspaceRoot/memoryFilename`），**不复用** `dirChain` 一路到 fs 根的发现链（`context-files.ts:43-49`，复用会跨 workspace 泄漏记忆）；subagent 用**独立 `agent-memory/`**（§15.5）。
- **@import 解析**：递归解析 `@path`，**相对导入文件位置（非 cwd）**、与 skill `@-reference` 共用 resolver（§15.5）；`realpath` 校验目标在 `workspaceRoot` 内（拒路径逃逸）；`visited` set 防循环；深度上限。32KiB 截断改 UTF-8/标识符边界安全切。
- **蒸馏（最小）**：手动 `#remember` 落盘为主路；「从 `ContextCompacted.preservedIdentifiers`/折叠事件自动蒸馏」作占位最小实现。**明示**：本阶段「动态」= 手动 `#remember` + 静态 MEMORY.md 两级加载，自动蒸馏管线留 Phase N（避免「动态」虚标）。

**触及**：`packages/store`、`packages/kernel`、`apps/yo-agent`。**退出标准**：
- workspace A 写入的 memory 在 workspace B 的 `loadConventionFiles` 不可见；git repo 根作隔离边界生效。
- `@import ../../etc/passwd` 或 workspace 外路径被 `realpath` 校验拒；A↔B 循环 import 被 `visited` 检出。
- MEMORY.md 索引按 200 行/25KB 加载，per-topic 文件未 read 直到引用触发。
- `writeMemory`/`readMemory` 在内存与 SQLite 两实现一致，resume 后记忆可读回。
- 现有测试全绿。

**交付状态**：`automemory.ts`（独立 `MemoryStore`：`InMemoryMemoryStore` + `SqliteMemoryStore`，共库不同 `memory` 表 PK `(workspace_path,key)`，**不扩 ADR-1 冻结的 EventStore**，持久层不引入时钟由调用方戳 `updatedAt`）；`context-files.ts` 增强——`expandImports`（递归 @import：相对引用文件位置解析 + `realpath` 逃逸防护 + `visited` 防循环 + 深度上限 + 缺失占位，**matchAll 预收集避免递归共享 /g lastIndex 污染**）+ workspace 隔离 MEMORY.md（仅从 `workspaceRoot` 读、不沿 dirChain 上溯）+ `capMemoryIndex`（前 200 行/25KB，§15.5）+ `safeTruncateBytes`（UTF-8 字节安全 + 回退空白边界不切断标识符）；手动主路 `parseRememberDirective`/`appendMemoryLine`/`memoryKeyFor`/`findWorkspaceRoot`；`main.ts` 接线（`#remember` 落盘 MEMORY.md + 写 MemoryStore 不耗 LLM 轮次；`loadConventionFiles` 传 git 根作 `workspaceRoot`）。验证门 **264 测试（+36）** 全绿。
- 退出标准全覆盖：workspace A 记忆在 B 不可见 + 父目录 MEMORY.md 不上溯泄漏；`@../secret.md`/越界经 realpath 拒、内容不内联；A↔B 循环 import 被 visited 拦 + 深度上限兜底；MEMORY.md cap 200 行/25KB；内存与 SQLite 两实现合约一致 + 落盘重开可读回。
- **审查节奏（ADR-14）**：纯本地上下文打磨，只做实现 + 针对性单测（逃逸/循环/隔离/截断均有专测），大规模对抗式审查随 Phase 3 整体收口。
- **已知限制（记 Phase N）**：① 自动蒸馏管线未做——"动态" = 手动 `#remember` + 静态 MEMORY.md 两级加载（设计明示，非虚标）；② `#remember` 仅接一次性 `-p` 路径，TUI/RPC 交互内 `#remember` 拦截留后续；③ subagent 独立 `agent-memory/` 隔离待 SubagentManager（Phase 4）兑现；④ @import 仅接 MEMORY.md，约定文件（yo.md/CLAUDE.md）@import 与 skill @-reference 共用 resolver 已就绪但未在约定加载链启用。

---

## 3F — AcpSurface（复用 RpcSurface 骨架 + 事件翻译 + request_permission + fs/*）

**目标**：被 ACP client 接管跑通编程对话（退出标准②）。最大化复用 surface-rpc 的 `JsonRpcPeer`/`MessageChannel`/`JsonlStreamChannel` 骨架与 kernel 审批/订阅接口；ACP 自己的 schema 与「EventEnvelope→session/update」翻译表是主要工作量。

> **决策**：新建 `packages/surface-acp`（`kind:'acp'` 已在 `SurfaceKind`，`kernel/index.ts:18`），复用 surface-rpc 的 transport/jsonrpc，但隔离 ACP schema（引入 `@zed-industries/agent-client-protocol`）与阻塞语义——不污染 RPC 协议表。

**交付物**：
- 照抄 `RpcSurface` 骨架（`rpc-surface.ts:25-61`），复用 `JsonRpcPeer`（`jsonrpc.ts`，**`void handleRequest` 不阻塞读循环 = 并发不死锁**，`jsonrpc.ts:78`）+ `JsonlStreamChannel`（stdio JSONL，ACP 协议即此，零改动）+ `InMemoryChannelPair`（测试对驱）。
- **ACP 方法表**：`initialize`（协商 protocolVersion/capabilities，**显式声明无 `steer` 能力**——ACP 只有 `session/cancel`）、`session/new`（返回 sessionId+modes）、`session/load`（复用 `attachFrom` 先订阅→fill→flush 防丢序，`rpc-surface.ts:134-147`）、`session/prompt`（**阻塞**返回 `stopReason`）、`session/cancel`（→`kernel.interrupt`）。
- **`session/prompt` 阻塞语义**：`beginTurn` 后挂 promise，等 `TurnCompleted/TurnFailed` 才 resolve（RpcSurface 的 `turn/start` 是非阻塞立即返 turnId，`rpc-surface.ts:79-83`，语义不同）。**`stopReason` 完整映射表**：`end_turn`→`end_turn`、`max_tokens`→`max_tokens`、`interrupted`→`cancelled`、`refusal`→`refusal`、`loop_detected`/`max_turn_steps`/`tool_budget_exceeded`→`refusal`（或 ACP `end_turn` 兜底，需核对 ACP 枚举）。
- **EventEnvelope→`session/update` 同步翻译表**（重写 `push()` 唯一映射点 `rpc-surface.ts:157-174`，**保持同步**不引入 await 以不破坏 `attachFrom` 顺序）：`AssistantText`→`agent_message_chunk`、`Reasoning`→`agent_thought_chunk`、`ToolCallStarted/Output/Completed`→`tool_call`(+status)。
- **request_permission 阻塞反向请求**：`peer.request('session/request_permission', ...)`（`jsonrpc.ts:64-71` 带 id 反向请求已支持）；`ApprovalRequested.suggestions`（`events.ts:120`）→ ACP `PermissionOption[]`（四选项 `allow_once/allow_always/reject_once/reject_always` 已对齐 `enums.ts:62-69`）；`outcome.optionId`→`ApprovalDecision`→`kernel.decideApproval`；`cancelled`→`reject_once` 兜底。**复用既有 `isApprovalPending` 去重**（`rpc-surface.ts:164` 已实现「仅对仍挂起审批重投」）——只对真正 pending 且未发过的发一次，避免 `session/load` 重放时弹窗风暴/id 冲突（批判核实：此去重模式现成可复用，非新风险）。
- **ACP fs/* 反向能力**：用 **ACP 规范命名 `fs/read_text_file`/`fs/write_text_file`**，**不复用** `rpc.ts:21-23` 的 `fs/readFile` 占位常量（那是为 RpcSurface 设计，真实 IDE 接管时方法名对不上）。补 `RPC_PARAM_SCHEMAS`（`rpc.ts:118-129` 当前缺 fs/*）；接 Protected Paths 硬编码枚举（§15.7）+ 路径逃逸防护。

**协议 schema 数据缺口处理**（批判核实的三处「翻译表引用但事件无数据」）：
- **Plan 事件零生产者**（核实：`kernel`/`apps` 无 `emit kind:'Plan'`）→ **MVP `initialize` 不声明 plan 能力**（翻译表的 `Plan→plan` 暂为死代码）；最小 Plan 生产者留 Phase 4（plan-mode/子 agent）。
- **`PlanStep` 无 `priority`**（核实 `events.ts:23` `{text,status}`）→ 若 Phase 4 启用 plan，届时补 `priority`（schema 变更 + Go 同构 + resume 白名单）；本阶段不动。
- **`FileChanged` 无 diff**（核实 `events.ts:102` `{path,changeKind}`）→ ACP 端 `tool_call` **降级为只报 `path`+`changeKind` 不带 diff**（不为 ACP 单独扩 `FileChanged` schema）。

**触及**：`packages/surface-acp`(新)、`packages/protocol`、`apps/yo-agent`。**退出标准**：
- `@zed-industries/agent-client-protocol` 安装并锁版；`surface-acp` typecheck 通过。
- ACP client（测试端）经 loopback 完成 `initialize`→`session/new`→`session/prompt`（含工具调用）一轮，`session/prompt` 阻塞至 turn 完成才返回正确 `stopReason`。
- 各 EventEnvelope kind 正确翻 `session/update`（翻译函数保持同步，高频 chunk 不乱序）。
- `tool_call` 触发 `session/request_permission` 阻塞 request，client 回 `allow_once`→`kernel.decideApproval`→工具执行；`session/load` 重放已挂起审批只发一次。
- `session/prompt` await 期间，client 对 `request_permission` 的 response 仍被 dispatch（不死锁，复用 `void handleRequest`）。
- `fs/read_text_file`/`fs/write_text_file` 反向请求可读写，Protected Paths + 路径逃逸被拦。
- `session/cancel`→`interrupt`，prompt 以 `stopReason=cancelled` 返回。
- **退出标准② 达成口径**：ACP client 离线对驱跑通含审批+fs 写入的一轮编程对话；真实 Zed/JetBrains 留人工验收。
- 现有测试全绿。

---

## 3G — MCP 进阶通道 + Streamable HTTP/OAuth（① 增强，最难离线，隔离收口）

**目标**：补齐挂真实生态 server 的高级能力。单独成片因其依赖外部网络/OAuth、最难离线验证、最可能 WIP——隔离出去不阻塞退出标准①（本地 server 在 3C 已达成）。

**交付物**：
- `createHttpClientTransport(url, {authProvider})`：`StreamableHTTPClientTransport` + `reconnectionOptions`。**抬高并锁 SDK 版本**（`package.json` 声明 `^1.12.0`，实测 `1.29.0`；host 用到的 `authProvider`/`reconnectionOptions`/`StreamableHTTP` 在低版本不存在）→ 锁 `1.29.x`。
- **OAuth**（§15.3/§15.10 C4）：实现 `OAuthClientProvider`（token/`codeVerifier` PKCE 持久化到 `~/.yo-agent`，**与 ed25519 设备鉴权（Phase 2D）分离的存储后端**）；headless 常驻进程无浏览器 → **带外授权**（device-code / 预置 token）不卡死首次连接；**WS 传输配 OAuth → fail-fast**（WS 不支持 OAuth，OAuth 必走 Streamable HTTP）。
- **MCP resources**：`list_resources` + `subscribe`（**心跳超时清理** + 多 mime，§15.3）映射为可观测通道。
- **MCP prompts**：映射 `/mcp__<server>__<prompt>` slash 命令（§15.3）。
- **MCP sampling**（§15.3 承重项，非可选）：host 端 `sampling/createMessage` 路由当前会话 Provider + **限流 + 配额计费**（成本计入 user 配额——批判指出三草稿都漏了此硬约束）。
- **progress notifications ↔ `ToolCallOutput` delta**：`mcpExecutor` 接 SDK `onprogress` → kernel 消费（当前仅 `'output'`，`kernel.ts:385`）。
- **stdio host 子进程兜底**：`StdioClientTransport` 子进程 stderr 不污染本进程协议 stdout；子 server 崩溃/EPIPE 独立兜底（区别于 `main.ts:143` 只兜本进程 server 侧）。

**触及**：`packages/surface-mcp`、`apps/yo-agent`、`packages/kernel`、`packages/protocol`。**退出标准**：
- `createHttpClientTransport` 连本地 HTTP MCP server 跑通 `tools/list`+`callTool`；mock `OAuthClientProvider` token 持久化/复用/刷新；WS 配 OAuth fail-fast。
- headless 带外/预置 token 不阻塞连接。
- stub `list_resources`+`subscribe` 回流（心跳超时清理）；`/mcp__stub__greet` prompt slash 可调；`sampling/createMessage` 经内核 Provider 回复且限流生效。
- progress→`ToolCallOutput` delta 可见；stub 子 server stdout 日志不破帧、EPIPE 独立兜底。
- SDK 版本锁定。

---

## 现状已核实修正（避免重复造轮）

对抗式批判逐条核实代码，修正了若干「设计文档以为要从零做」的误判。**实现时务必据此，勿重复实现既有逻辑**：

| 误判 | 核实现状 | 计划修正 |
|---|---|---|
| 「从零做结构化 Handoff」 | `condenser.ts:35-40` 已有四节 prompt + 标识符保留要求 + 便宜模型摘要 + 三段式 | 3D 定位为**增量改造**：仅加 zod 结构化 + diff 机制护栏 |
| 「新增距上次 compact guard」 | `kernel.ts:417-419` `stepsSinceCompact`/`minStepsBetweenCompact` **已实装** | 3D 仅补语义校准 + 测试 + cache 成本注释 |
| 「ACP 审批重放风暴是全新风险，需重写」 | `rpc-surface.ts:164` `isApprovalPending` 去重**已实现** | 3F 直接复用既有 pending 守卫语义 |
| 「`owner:'mcp'` 需扩 ToolDescriptor」 | `index.ts:18-28` owner 联合**已含 `'mcp'`**；`SurfaceKind` 已含 `'acp'`（`kernel/index.ts:18`） | 注入零接口改动，happy-path 复用 `register` |
| 「checkpoint/shadow-git 要新做」 | `ShadowGitCheckpointer` 已完整实现 snapshot/rollback/list（`checkpoint.ts:33`） | Phase 3 不碰 checkpoint |
| 「auto-memory 扩 EventStore」 | `EventStore` 是 ADR-1 冻结接口（`store/index.ts:39`） | 3E 走**独立 MemoryStore**，不扩冻结接口 |
| 「`resolveAvailable` 已保 cache 稳定」 | `registry.ts:24` 是**全局字典序**，不分内置/MCP（§15.4 要求内置注册序） | 3A 修正排序为两段拼接 |

---

## 关键决策（ADR 增补）

- **ADR-9（护栏底座先行）**：外部 MCP server 是不可信输入源，所有危险在「引入外部工具」那刻触发。先做纯本地可单测的护栏底座（3A），再接连接（3B/3C）。对比 Draft1/Draft3 把护栏混进 happy-path 片——那样护栏与 SDK/网络逻辑耦合、单测要起 server 才能验、赶 happy-path 时易漏护栏。
- **ADR-10（MCP host 同包对称）**：host 落 `packages/surface-mcp`（新文件）而非独立包，与 server 对称复用工厂模式/SDK 依赖/app 边界；体量膨胀再拆。
- **ADR-11（AcpSurface 独立包 + 复用 transport）**：ACP schema 与阻塞语义（`session/prompt` 等 turn 完成、`request_permission` 阻塞反向请求）与 RPC 的非阻塞 notify 分歧大；独立 `surface-acp` 隔离翻译层与 `@zed-industries/agent-client-protocol` 依赖，但复用 `JsonRpcPeer`/`JsonlStreamChannel`（含 `void handleRequest` 不死锁特性）。
- **ADR-12（auto-memory 独立 MemoryStore）**：不扩 ADR-1 冻结的 `EventStore`；记忆与 EventLog 共库不同表，关注点分离。
- **ADR-13（退出标准达成口径）**：① 由 3C 末真实 `server-filesystem` stdio 冒烟达成；② 由 ACP client 离线对驱达成（真实 IDE 人工验收）。离线可 CI + 协议层等价真实接管，延续 Phase 1/2 范式。
- **ADR-14（审查节奏：大阶段收口才做大规模对抗式审查）**：自 3D 起调整验证节奏——**小切片（3D/3E/…）只做实现 + 单测，"大体无误即过"**；**大规模对抗式审查（Workflow 多 agent finder→adversarial verify→completeness critic）推迟到一个大阶段（Phase 3 整体）收口时一次性做**，覆盖该阶段所有切片的跨片交互。理由：① 切片间存在共享接缝（`condenser`/`context-files`/`MemoryStore`/`kernel`），逐片审查会重复扫同一批接缝且看不到跨片交互（如 3D 的 `preservedIdentifiers` ↔ 3E 的自动蒸馏占位）；② 大阶段末审查能以"整阶段交付物"为单元做完备性批判，回归面更完整；③ 节省逐片审查的 token/时延。**保留底线**：每片末 `pnpm run check` 全绿（typecheck + schema gen + 全量测试只增不减），关键护栏（标识符保真 diff、@import 逃逸、workspace 隔离）必须有针对性单测。**触发例外**：若某片触及不可信输入/审批/供应链/prompt-cache 等高危面，仍即时单片审查（3B/3C 已做，其性质属"接外部连接"）。3D/3E 为纯本地上下文打磨，按新节奏走。

---

## 待决问题（实现前需拍板）

1. **MCP 连接状态事件**：新增专用 `McpServerConnected/Disconnected/Failed` 变体（须同步 Go schema + resume 白名单 + sealed union 冻结承诺）还是复用 `BackgroundProcess`？影响 3C。
2. **ToolSearch（>20 工具）**：复用本环境已有的 ToolSearch 机制（deferred tools），还是 MCP host 内部自管？是否独立工具/provider 往返？影响 3C 占位实现的形态。
3. **`risk` 评估动态维度**：3A 的 RiskLevel 是否结合 input 内容（write 到 Protected Path 升级 high），还是仅 `ToolKind` 静态？Protected Paths/SSRF 白名单（§15.7）并入 3A 还是独立安全片？
4. **MCP 多 session 连接作用域**：常驻进程下 per-cwd/session 隔离还是全局共享 `Client`？现 registry 跨 session 单例、`evalAvailability` 无 session 谓词——3C 是否按 `workspacePath` 隔离连接防跨 session 工具泄漏？
5. **OAuth 带外授权形态**（3G）：device-code flow 还是仅预置 token？

---

## 风险与缓解

| 风险 | 缓解 | 落点 |
|---|---|---|
| **prompt-cache 失效**（MCP 异步注入/TTL/熔断/`list_changed`/全局字典序混入改内置前缀） | 3A toolset 版本化 + turn 内 snapshot + 排序两段拼接；3C `list_changed` 显式重建不热换；3D compact guard | 3A/3C/3D |
| **MCP 供应链/工具投毒** | 3B project 配置默认 inactive 需 opt-in；`${VAR}` 不写盘；3A schema 清洗 + desc 截断 + approval clamp；host 用真实 ApprovalGate 非 autoApprove | 3A/3B |
| **撞名静默覆盖错路由** | 3A register 撞名检测 + `mcp__{server}__{tool}` 命名空间隔离 | 3A |
| **in-flight callTool 挂死整个 turn** | 3A `toolCtx.signal` 接缝 + 3C per-call 超时 + interrupt abort | 3A/3C |
| **标识符失真**（便宜模型改写 UUID/path） | 3D 抽取→diff 断言→回填/重试机制护栏（非纯 prompt） | 3D |
| **auto-memory 跨 workspace 泄漏 / @import 逃逸** | 3E 独立隔离根 + `realpath` 校验 + `visited` 防循环 + UTF-8 安全截断 | 3E |
| **ACP 审批语义漂移**（notify vs 阻塞 request 重放风暴） | 3F 复用 `isApprovalPending` 去重 + 翻译函数同步防丢序 | 3F |
| **ACP 数据缺口**（Plan 零生产者 / PlanStep 无 priority / FileChanged 无 diff） | 3F MVP 不声明 plan 能力 + FileChanged 降级无 diff；priority 留 Phase 4 | 3F |
| **协议演进破坏 sealed union 同构** | 凡动 `events.ts` 同步 `AGENT_EVENT_KINDS` + `resume.ts` 白名单 + Go schema + resume 重放断言 | 3A/3C |
| **SDK 版本不一致**（声明 ^1.12.0 实测 1.29.0） | 3G 抬高下限锁 1.29.x，CI 锁文件校验 | 3G |

---

## 已知限制（明示，不在 Phase 3 收口）

- **MCP `CallToolResult` 非文本内容**（images/resource-link/structured）当前压成 string chunk（`ToolEvent` 仅文本）——有损降级，非文本承载推迟 Phase N。
- **JSONL stdout 背压**：`JsonlStreamChannel.send` 不处理背压（`transport.ts:96`）；ACP 大量 `session/update` chunk 经慢消费端可能堆积，弱于真实 ACP 实现。
- **真实 Zed/JetBrains GUI 接管**：仅人工验收，capability 协商/fs 能力/背压的真机差异不在离线 CI 覆盖内。
- **自动记忆蒸馏**：本阶段仅手动 `#remember` + 静态 MEMORY.md 加载，自动蒸馏管线（从 ContextCompacted 提取）留 Phase N。

---

## 退出标准 —— Phase 3 达成判据

- ① **挂外部 MCP server 并用其工具**：3A 护栏 + 3B 连接/信任 + 3C 韧性 → **3C 末真实 `@modelcontextprotocol/server-filesystem` stdio 冒烟，LLM 调用其 `read_file` 成功**。
- ② **被 Zed/JetBrains 经 ACP 接管跑通编程对话**：3F AcpSurface → **`@zed-industries/agent-client-protocol` client 离线对驱跑通含审批+fs 写入的一轮编程对话**（真实 IDE 人工验收）。
- 上下文/记忆打磨：3D 结构化 Handoff + 标识符保真、3E workspace 隔离 auto-memory，均离线单测覆盖。

**验证门**：`pnpm run check` —— typecheck 0 错误 + JSON Schema 全量 gen + 测试在 Phase 2 的 145 基线上**只增不减**全绿；每片末跑全量回归。**对抗式审查节奏（ADR-14）**：3B/3C（接外部连接，高危）已逐片审查；3D/3E（纯本地上下文打磨）按新节奏只做实现+单测，与 3F/3G 一并在 **Phase 3 整体收口**时做一次大规模对抗式审查。

---

## 后续（Phase 4 接力）

- Plan 事件生产者（plan-mode / 子 agent 规划）+ `PlanStep.priority` 补全 → 激活 ACP plan 通道。
- 自动记忆蒸馏管线；向量 RAG（opt-in，Memory MCP，§13 Phase 6）。
- L1 子进程隔离 + L2 容器（开放渠道前置底座，§13 Phase 4）；MCP 工具执行委派沙箱。
- MCP `CallToolResult` 非文本内容承载（扩 `ToolEvent` 变体）；ACP 背压处理。
- SubagentManager（Worker 隔离）——子 agent `agent-memory/` 隔离（§15.5）兑现。
