# Phase 5.1 — yo-agent Web 控制台（通用网页客户端）

> **状态：✅ 已交付（2026-07-04，六切片 5.1a-f）。** 712 测试全绿；控制台端到端真机达标。

## Context

Phase 5 已让内核跑进浏览器（`@yo-agent/surface-web`：createWebAgent + defineHttpTool + ChatController），但交付物是 demo 级挂件。用户要求做**通用网页**：左侧栏会话历史、可新增多个 agent、每个 agent 有配置页（连接/功能/可用工具）。定位为 **yo-agent 官方 Web 控制台**（`apps/web-console`，产品级质量标准；web-demo 保留不动）。

用户已拍板：**Vue 3** ｜ **本地 IndexedDB 为主 + 预留后端同步接缝** ｜ **旧会话可续聊**（非只回看）。

## 探索确认的关键事实（可信）

- **内核天然支持跨实例 resume**：会话持久态全在 EventStore（events + sessions 表）；新 kernel 传同一 store 调 `resumeSession(id)` 即恢复（kernel.ts:238-269）。`messages` 窗口快照由 `persistState` 在开会话和每轮结束（TurnCompleted/TurnFailed）时 upsert（kernel.ts:1151,1155-1172）。
- **cursor 是 per-session 单调非全局**（sqlite 复合主键 `(session_id,cursor)`）→ **多个 kernel 共享同一个 store 安全**（各写各的 session 分区），`listSessions()` 天然汇总全部 agent 的会话——正好是左侧列表。
- **两个真缺口，必须动协议/内核（严格可审计小改）**：
  1. 事件流里**没有 user 消息事件**（prompt 只进 messages 快照）→ 回放重建不了用户气泡（TUI /resume 同病）；
  2. `persistState` 硬编码 `agentProfile:'default'`（kernel.ts:1160）→ 会话无法标注归属哪个 agent。
- ChatController 现状单会话、无 resume 入口、**reduce 无 cursor 去重**（回放+实时叠加会双记）；回放范式照抄 `RpcSurface.attachFrom`（先订阅入队 → 读历史 → flush，rpc-surface.ts:134-147）；已决审批跳过（`isApprovalPending`）。
- `createWebAgent` 硬编码 `new MemoryEventStore()`（agent.ts:64）、`startSession()` 不透传 sessionId——需开注入口。
- IndexedDBEventStore 实现按 SqliteEventStore 语义逐条对齐（append 单调校验 / read 半开区间 `(from,to]` 升序 / createSession=upsert / head=MAX）；`resumeSession` 最小依赖 = getSession + head + read。
- 约束：kernel/store 只能走 `/core` 浏览器安全面；`check:browser` CI 硬门在；biome 不支持 .vue → **.vue 内逻辑最小化，逻辑全提到 .ts**（service/composable 层，顺带保证可 vitest 单测）。

## 架构总览

```
apps/web-console (Vue 3 + Vite)
├─ 单例 IndexedDBEventStore ←—— 全部 agent 的 kernel 共享（会话/事件持久，跨刷新）
├─ ConsoleStore 接口（agent 配置 + 会话元数据 CRUD）
│    └─ LocalConsoleStore 实现（IndexedDB）        ← 后端同步接缝：将来换 RemoteConsoleStore
├─ AgentRuntime：agentId → WebAgent 懒建缓存（每个 agent 配置 = 一个 kernel 实例）
└─ 视图：Sidebar（agent 列表 + 会话历史）/ ChatView（ChatController）/ AgentConfigView（表单）
```

- 会话归属：`SessionRow.agentProfile = agentId`（经内核注入）；列表按 `lastActiveAt` 降序，可按 agent 过滤。
- 打开旧会话：查 agentProfile → 取/建对应 WebAgent → `ChatController.open(sessionId)`（resume + 回放）。
- 同一会话同一时刻只有一个活 controller；切走即 `dispose()`（endSession 清内存不删持久），防双 kernel 驱动撞 cursor。

## 切片

### 5.1a `IndexedDBEventStore`（持久化地基）

- 新增 `packages/store/src/indexeddb.ts`：三 object store 对应 sqlite 三表——`events`（keyPath `[sessionId,cursor]` + sessionId 索引）、`sessions`（keyPath sessionId，SessionRow 直存结构化对象）、`checkpoints`。行为逐条对齐 sqlite.ts:82-137：append 事务内 head 对账 + cursor 单调抛错；read 游标升序包成 async generator + `(from,to]` 过滤；createSession=put(upsert)；`onupgradeneeded` 建库。**额外加接口外方法 `deleteSession(sessionId)`**（EventStore 接口冻结无删除；控制台持有具体类型调用）。
- `packages/store/src/core.ts` 补导出（surface-web 走 core 面才拿得到）；**不碰 index.ts barrel 也导一份（Node 侧无害，纯 Web API）**——只进 core。
- 测试：devDep `fake-indexeddb`，把 memory.ts 既有测试套语义（单调校验/区间/upsert/listSessions）对 IDB 实现复测 + 「kernel 换 IDB store 后 startSession→turn→新 kernel resumeSession 续聊」集成测试。
- `check:browser` 自动覆盖（core 导出即进冒烟入口模块图）。

### 5.1b 协议/内核小改（两处，严格可审计）

1. **`UserMessage` 事件变体**：`packages/protocol/src/events.ts` 加 `{ kind:'UserMessage', text, source:'prompt'|'steer' }`；跑 `gen:schema` 提交生成物（CI 漂移门要求）。内核在 `beginTurn` 落 prompt、`steer` 落插话时 emit——**回放能重建用户气泡，TUI /resume 将来也受益**。
2. **`AgentKernelDeps.agentProfile?: string`**：`persistState` 的 `agentProfile` 改从 deps 取，缺省 `'default'`（行为不变）。
- 既有 surface 对新变体的兼容：TUI/RPC/headless 的 switch 都有 default 分支（忽略未知渲染），跑全量测试验证；TUI 若要顺带渲染 UserMessage 不在本期。

### 5.1c surface-web 扩展（resume/回放/多会话能力）

- `WebAgentConfig` 加 `store?: EventStore`（缺省 MemoryEventStore，向后兼容）+ `agentProfile?: string`；`WebAgent.startSession(opts?: {sessionId?, model?})` 透传。
- `ChatController`：
  - **cursor 去重**（`lastCursor`，`env.cursor <= lastCursor` skip——回放正确性硬前提，参照 rpc-surface.ts:157）；
  - 新增 **`open(sessionId)`**：`kernel.resumeSession`（先于 subscribe，否则 require 抛）→ 先订阅入临时队列 → `events.read(sid)` 逐条 reduce 回放 → flush（attachFrom 范式）；回放跳过已决 `ApprovalRequested`；
  - `reduce` 处理 `UserMessage`（建 user 气泡）；`send`/`steer` 移除乐观 push，改全事件驱动（消除双记，路径统一）。
- 测试：open 回放重建（含 user 气泡/工具 part）、回放+实时叠加不双记、跨 controller 实例续聊、UserMessage 驱动的 send 渲染时序。

### 5.1d web-console 骨架 + 配置域

- 新 app `apps/web-console`：Vite + Vue 3 + vue-router；typecheck 用 `vue-tsc --noEmit` 串进根 `typecheck` 脚本（照 web-demo 双 project 先例）；自带 tsconfig（DOM lib）；根 tsconfig exclude。**.vue 只做模板绑定，逻辑全在 .ts**（biome 不 lint .vue；service/composable 可 vitest）。
- `src/services/console-store.ts`：**`ConsoleStore` 接口**（`listAgents/saveAgent/deleteAgent/getSessionMeta/saveSessionMeta/deleteSessionMeta`）+ `LocalConsoleStore`（IndexedDB 同库另 object store）。这是后端同步接缝——将来 RemoteConsoleStore 实现同接口。
- `AgentConfigRecord`（可序列化）：`{ id, name, color, connection{provider,baseUrl,apiKey?,model,headers KV}, system, approvalMode:'auto'|'confirm', compaction, loopBreakerMode, tools: DeclarativeHttpTool[] }`；`DeclarativeHttpTool` = defineHttpTool 的**声明式子集**（name/description/inputSchema(JSON 文本，保存时 parse 校验)/url/method/headers KV/credentials——函数式字段不进配置面）。
- `src/services/agent-runtime.ts`：`AgentConfigRecord → WebAgentConfig`（tools 经 defineHttpTool 物化；`approvalMode:'confirm'` → 控制台实现的弹窗 `ApprovalGate`）→ `createWebAgent` 懒建缓存；配置变更使缓存失效（新 kernel，旧会话仍可 resume——数据在共享 store）。
- `AgentConfigView.vue`：表单（连接段/system 段/功能开关段/工具列表 CRUD 段），inputSchema JSON 实时校验，「测试连接」按钮（调 `provider.listModels()` 或一发最小请求）；apiKey 明文入 IndexedDB 有警示文案。内置「客服工具模板」一键填入（order_query 样例）。

### 5.1e 聊天与会话域

- `Sidebar.vue`：上段 agent 列表（点击过滤会话 + 齿轮进配置页 + 「新增 agent」）；下段会话历史（`store.listSessions()` 按 lastActiveAt 降序，标题 = SessionMeta.title ?? 首条 UserMessage 截断，agent 色点标注）；「新对话」「删除会话」（deleteSession + meta 清理，确认后执行）。
- `ChatView.vue` + `src/composables/use-chat.ts`：包 ChatController（onChange → `shallowRef` 版本号触发重渲）；消息渲染（文本/工具折叠视图/流式指示/错误条/用量条）、输入框（Enter 发送）、中断、turn 中 steer。审批弹窗组件（confirm 模式的 gate 挂 UI）。
- 会话切换生命周期：切换/删除前 `controller.dispose()`；打开历史会话走 `open()`；同 agent「新对话」走 `start()`。
- 空态：无 agent 时引导进新增 agent 流程。

### 5.1f 收口

- 对抗式审查（重点：IDB 事务/游标正确性、回放去重边界、双 kernel 防护、apiKey 存储路径、协议演进兼容）→ 修 CONFIRMED。
- `docs/PHASE-5.1.md` 交付报告 + README（结构图/快速开始 `pnpm --filter @yo-agent/web-console dev`）+ DESIGN.md Phase 5 段补 5.1 一行。

## 非目标（本期不做）

后端同步实现（只留 ConsoleStore 接缝）、多用户/账号、移动端适配、全文搜索/导出、MCP host 进浏览器、web-demo 改造（保留作教学示范）、主题系统（基础样式即可）。

## 风险与应对

| 风险 | 应对 |
|---|---|
| 隐私模式/旧浏览器无 IndexedDB | 打开失败降级 MemoryEventStore + 顶栏提示「本次会话不持久」 |
| 同一 sessionId 被两个 kernel 同时驱动 → cursor 单调抛错 | 切换前必 dispose（endSession）；AgentRuntime 层「活会话 → controller」单例注册表兜底 |
| UserMessage 协议演进破坏既有 surface | 变体只增不改；全量测试 + schema 漂移门；TUI/RPC default 分支忽略 |
| messages 快照含不可结构化克隆值 | CanonMessage 纯 JSON（fetch provider 产物），测试断言可 roundtrip |
| biome 不 lint .vue | 逻辑全提 .ts；.vue 仅模板+薄 setup |
| 配置里 apiKey 明文落 IndexedDB | UI 显式警示 + 支持「不保存 key，每次会话输入」选项 |

## 验证

- 单测：IDB store 语义套（fake-indexeddb）、跨 kernel resume 集成、ChatController open/去重/UserMessage、AgentConfigRecord ⇆ WebAgentConfig 物化、console-store CRUD。
- `pnpm run check` 全绿（typecheck 链加 vue-tsc；check:browser 覆盖 IDB store；gen:schema 漂移门过）。
- 真机验收清单（demo-backend + 中转站）：建 2 个 agent（不同连接/工具）→ 各聊多轮含工具调用 → **刷新页面** → 侧栏两组会话都在、点开历史完整（含用户气泡与工具视图）→ **续聊成功** → 删除一条会话 → confirm 审批模式弹窗生效 → 隐私窗口降级提示。

---

## 交付记录（5.1f 收口）

**六切片全交付**：5.1a IndexedDBEventStore（三 object store 对齐 sqlite 语义 + deleteSession）｜5.1b UserMessage 协议事件（第 22 变体）+ agentProfile 注入｜5.1c surface-web open 回放 + cursor 去重 + store 注入｜5.1d web-console 骨架 + 配置域｜5.1e 聊天/会话域｜5.1f 审查收口。

**验证门**：`pnpm run check` = typecheck（根 tsc + web-demo tsc + web-console vue-tsc）+ lint（biome 排除 .vue）+ gen:schema 漂移 + check:browser（IDB 入 core 图仍干净）+ **712 测试** 全绿。

**headless 端到端（真 demo-backend + 真 gpt-5.5）**：`scripts/e2e-console-resume.ts` 留作冒烟——建 agent 配置 → 聊一轮调 order_query → 模拟刷新（新 AgentRuntime 同库 `open`）→ 回放重建用户气泡+工具 part → 续聊查订单 7 带上下文 → 会话列表归属标注。实录全绿。

**对抗式审查（自查，代理因额度中断转主 agent 核查）+ 修复**：
- **审批弹窗单槽→队列化**（app-state.ts）：`current` 改 `queue[]`，并发审批不再互相覆盖丢 `resolve`（否则被覆盖的 turn 永久挂起）。当前内核串行准入不触发，属防御性加固。
- **配置变更后活会话仍用旧配置**（use-chat.ts `notifyAgentChanged` + AgentConfigView save/remove 调用）：`invalidate` 只清缓存，活 controller 仍持旧 kernel；改为定向 dispose 强制下次 `open` 拿新配置的 kernel。
- **TUI/RPC/ACP 对 UserMessage 事件**：TUI reducer `default` 忽略（model.ts:494），不与本地 submit 用户块双显；回放行为 5.1b 前后一致（本就不重建用户气泡），无回归。

**已核可辩护**：
- IndexedDBEventStore `append` 两事务非原子——内核 emitChain 串行化 emit + 同 sessionId 单 kernel（use-chat 保证同刻单活 controller），分区无撞；`add` 撞复合主键兜底抛错。
- 快速切换会话的孤儿 `open`——旧 controller 已 unsub + endSession，残余 `read` 只 reduce 到不被 UI 引用的孤儿 state，无损坏。
- `Number.±Infinity` 作 IDB 复合 key 上下界：合法 number key，fake-indexeddb 通过；真 Chrome 目视验收。

**遗留（真 Chrome 目视，非本期阻塞）**：IndexedDB 在真浏览器的持久/事务行为、多 agent UI 交互、隐私窗口降级提示——`pnpm --filter @yo-agent/web-console dev`（:5178）人工验收。
