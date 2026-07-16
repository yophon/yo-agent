# Phase 5.3 — 内核并发闸 + 会话 DAG 兑现（5.3a 已交付；5.3b/c 规划）

> **状态：5.3a 已交付（2026-07-15）**——内核 turn 队列 + idemKey 去重 + interrupt/endSession 清队 + 扩展 followUp 取消回队；
> `pnpm run check` 全绿（750 测试，+7：kernel turn-queue 6 + extension-host 回队 1），退出标准 ①-⑤ 全达成。
> 5.3b/c 为规划切片，实施前按本文档勘察事实直接开工，无需重新探索。

## Context

Phase 5.2 收口审查留下两个内核层欠账，且互为前置：

1. **MED-2 并发 turn 竞态**（PHASE-5.2.md 审查节）：内核无「同会话 turn 进行中」互斥闸。TUI 本地队列（app.ts）与扩展 followUp 队列（extension-host host.ts）判据一致（`TurnCompleted{stopReason:'end_turn'}` 出队），两队列同时非空时同一事件双路触发 submit → 两 turn 并发交错。RPC 客户端并发 `turn/start` 同样命中。防线目前全在 surface 自律，与「内核是事件唯一写入方、也应是状态一致性守门人」的架构立场矛盾。
2. **会话 DAG 未兑现**（pi 研究的第三样精华，research/pi.md §12）：`EventEnvelope.parentId` 协议已预留（protocol/src/events.ts:257）、三 store 全存取（sqlite `parent_cursor` 列 / indexeddb / memory），但 kernel `doEmit` 恒填 `null`（kernel.ts:1149）；DESIGN §6.2 预留的 `session/fork(sessionId, atCursor)` RPC 方法未实现。Phase 6 聊天平台的 `UnifiedMessage.replyToId → parentId` 映射（kernel/src/index.ts:160）在等它。

**顺序拍板：先 5.3a 并发闸，后 5.3b/c DAG。** 三个理由：① fork 产生多活跃分支后，多路输入打同一内核的机会只增不减；② fork 一个 turn 进行中的会话必须拒绝或排队——需要「turn 进行中」成为内核正式状态位，正是并发闸的产物；③ 并发闸小（一个文件为主），MED-2 已入档缺陷立刻销账。

## 5.3a 并发闸：内核 turn 队列（✅ 已交付）

### 关键勘察事实：为什么是队列而不是互斥拒绝

`TurnCompleted` 的 fan-out 发生在 `runTurn` 尚未返回的同一异步栈上：`completeTurn`（kernel.ts:1203）在 `runTurnInner` 内部 emit，`doEmit` 同步遍历 subscribers（kernel.ts:1156）——此刻 turn 的收尾簿记（`runTurn` finally、launchTurn 的 catch 兜底）都还没跑。而「收到 `TurnCompleted{end_turn}` 立即提交下一条」是两处既有合法模式（TUI 队列出队、扩展 `dequeueFollowUp`）。若做互斥拒绝（busy 抛错），这两处会**恒定**撞闸——不是极端 timing，是每次。所以闸必须是队列：busy 入队，当前 turn 完结自动出队起跑。

### 设计定论

- **`SessionState` 增 `turnActive: boolean` + `turnQueue: QueuedTurn[]`**。`launchTurn` 拆两段：入口同步查 `turnActive`——active 则入队（turnId 预分配、done 为 deferred）立即返回；否则 `startTurnNow`：**同步置 `turnActive=true`**（先于首个 await，封死同 tick 双进），emit TurnStarted/UserMessage → runTurn，done 的 finally 里清 flag + `drainTurnQueue`（出队下一条走 `startTurnNow`，其 done 管道进队列条目的 deferred）。TurnStarted 前的 emit 抛错（落库失败）同样清 flag + drain + 向调用方传播。
- **排队 turn 的事件序**：TurnStarted/UserMessage 在**实际起跑时**才 emit——EventLog 保持严格线性（turn 事件不交错），回放语义零改动。`beginTurn` 的契约从「发出 TurnStarted 即返回」放宽为「返回预分配 turnId；TurnStarted 在实际起跑时经订阅推送」——全部既有消费方兼容（RPC turnStart 只透传 turnId；ACP 挂订阅等终态；TUI/MCP/Web 用阻塞版 submitInput）。
- **idemKey 去重**：`TurnStarted.promptIdemKey` 本就为重试对账预留。队列使重试**更**危险（此前并发交错、现在会排成重复 turn），故入口先查活跃 turn 与队列条目的 idemKey——命中则返回既有 `{turnId, done}` 不新建。仅对活跃+排队比对，不查历史（历史去重是 store 层对账职责）。既有 surface 的 idemKey 生成（TUI `tui-${Date.now()}`、MCP `mcp-${Date.now()}`、ext `ext-followup-${seq}`、Web randomUUID）无跨面撞键可能。
- **`interrupt` 清队**：中断语义 = 「立即全停」，排队条目以 reject 取消（否则中断后排队 turn 自动起跑，违背用户意图）。TUI 自有队列本就「中断保留待手动」，不受影响；扩展 `dequeueFollowUp` 已出队的那条改为 **reject 时 unshift 回队**（只在「turn 未运行」的 reject 路径触发——done 的 runTurn 异常被 TurnFailed 兜底吞掉，不会走到 reject，无双跑风险）。
- **`endSession` 清队**：不清则排队 deferred 永久悬挂 + drain 在已驱逐的 SessionState 上起孤儿 turn（endSession 审查 gap#3 同病）。
- **`submitInput` 语义不变**（排队+跑完才 resolve）；排队被取消时 reject——调用方必须知道「没跑」。

### 退出标准

① 并发 submitInput 串行化，事件流无交错（B 的 TurnStarted cursor > A 的 TurnCompleted cursor）；② `TurnCompleted` 订阅回调内同步 submitInput 正常排队不误伤（MED-2 回归：双订阅者双提交 → 两 turn 串行各跑一次）；③ 同 idemKey 重复提交去重返回同 turnId；④ interrupt/endSession 清队 reject、扩展 followUp 被取消后回队重试；⑤ 全量 `pnpm run check` 零回归。

## 5.3b fork 最小闭环（规划，下期实施）

### 核心拍板一：fork = 新 sessionId，不做单会话内 DAG 多头

pi 是单 JSONL 文件内 `id+parentId` 挂树、会话内多头。yo-agent 的整个读路径建立在「per-session cursor 线性单调」上：`read` 半开区间、ResumeBuffer、`append` 单调校验、ChatController cursor 去重——改树遍历伤筋动骨。拍板走 DESIGN §6.2 预留形态：**fork 开新会话**，每会话保持严格线性，DAG 存在于会话之间。`SessionRow` 增 `forkedFrom?: { sessionId: Id; cursor: Cursor }`（tree 视图的全部数据源）；会话内 `parentId` 字段留给 Phase 6 聊天 reply 线程标注（纯标注、不影响回放序）。

### 核心拍板二：历史点 messages 用 per-turn 快照，否决事件回放重建

fork 要在历史点续聊，需要该点的 `CanonMessage[]`。内核 resume 走的是 `SessionRow.messages` 快照（resumeSession kernel.ts:240-253），**不是**事件回放——而快照是 turn 完结时覆盖式 upsert（persistState kernel.ts:1158-1178），只有最新一份。两条路：

- ~~事件回放重建~~：**否决**。压缩不可逆——`doCondense` 直接替换 `s.messages`（kernel.ts:946），`ContextCompacted` 事件只含 handoffSummary/标识符集，**重建不出压缩后的真实消息窗口**；流式增量、tool_call/result 配对重建也是保真雷区。
- **per-turn 快照**：**采纳**。persistState 本就每 turn 边界跑一次，从覆盖改为按 `(sessionId, cursor)` 追加留存即可，零重建保真风险，压缩效果天然入照。代价是存储线性膨胀（可配保留策略，后续再收）。约束随之明确：**fork 只在 turn 边界**（`TurnCompleted` 的 cursor）——对用户这就是消息粒度，与 pi /tree 节点体验等价。

### 其余定论

- `kernel.forkSession(sessionId, atCursor) → newSessionId`：校验 atCursor 是 turn 边界快照点 → 新会话以该快照为 messages 起点、`forkedFrom` 记来源 → emit `SessionStarted`（可考虑事件面加 `forkedFrom` 字段，schema 再生成）。源会话 turn 进行中：拒绝（5.3a 的 `turnActive` 状态位）。
- store 三实现（sqlite/indexeddb/memory）同步加 turn 快照表 + SessionRow.forkedFrom；EventStore 接口新增方法，旧库无表自动建（sqlite CREATE IF NOT EXISTS 惯例）。
- **shadow-git 联动（可选甜点）**：`Checkpoint{cursor, shadowGitRef}` 本就按 cursor 挂（store/src/index.ts:15-21）——fork 时若有对应 checkpoint，可一并恢复工作区文件 = 对话+文件系统双时间旅行，pi 没有的组合。开着 `YO_CHECKPOINT=1` 才生效，降级无感。
- RPC `session/fork`（DESIGN §6.2 预留签名）+ schema。

## 5.3c 表面兑现（规划，下期实施）

- TUI `/fork [n]`（缺省最近 turn 边界）+ `/tree`（sessions 表 forkedFrom 链渲染，含分支首条 UserMessage 摘要）。
- web-console：会话列表按 forkedFrom 缩进/连线成树；聊天视图 turn 边界挂 fork 按钮。
- Phase 6 接点：聊天 replyToId → 会话内 parentId 标注落 emit 参数（doEmit 签名扩展）。

## 勘察事实清单（file:line，实施前免重查）

| 事实 | 位置 |
| --- | --- |
| launchTurn 无并发检查；interrupted 重置在入口 | kernel.ts:321-339 |
| currentTurnId/turnAbort 仅 runTurn 内设/清，非闸 | kernel.ts:425-435 |
| TurnCompleted 在 runTurnInner 栈上 emit（fan-out 同步） | kernel.ts:1203-1212 + 1156 |
| emitChain 只保 EventLog 单调，不保逻辑互斥 | kernel.ts:1129-1142 |
| doCondense 整体替换 s.messages（回放重建否决依据） | kernel.ts:946 |
| persistState 覆盖式 upsert 单份快照 | kernel.ts:1158-1178 |
| resumeSession 靠快照非回放 | kernel.ts:240-271 |
| doEmit parentId 恒 null | kernel.ts:1149 |
| TUI 队列出队判据 | surface-cli/src/tui/app.ts:219-233 |
| 扩展 followUp 队列出队判据 + 错误处理 | extension-host/src/host.ts:323-352 |
| RPC turnStart 非阻塞透传 | surface-rpc/src/rpc-surface.ts:79-83 |
| ACP beginTurn 后挂订阅等终态 | surface-acp/src/acp-surface.ts:121 |
| Checkpoint 按 cursor 挂 shadowGitRef | store/src/index.ts:15-21 |
| session/fork RPC 预留 | DESIGN.md:476 |
