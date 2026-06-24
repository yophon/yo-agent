# Phase 2 —— 协议化暴露（泛化 RpcSurface + MCP server）

> 对应 [`DESIGN.md`](DESIGN.md) §6 / §13 Phase 2。yo-aichat 废弃后路线重排：先"被集成"（协议暴露，复用最大、零开放渠道风险、Claude Code 即消费者）。延续"零网络风险"分片，每片离线可验证。
> **Slice 2A**：RpcSurface 核心（JSON-RPC over JSONL/in-memory，通用远端驱动）—— **已交付**。
> **Slice 2C**：McpServerSurface（`mcp-server`，被 Claude Code/Cursor 调用）—— **已交付**。
> **Slice 2B**：resume/reconnect 完整化（ResumeBuffer 接入 + gap 溢出 + 跨进程会话重建 + 审批跨重连存活）—— **已交付**。
> **Slice 2D**：设备鉴权（ed25519 + 配对码 + nonce 挑战）+ WS 传输 —— **已交付**。**Phase 2 全部交付。**

## Slice 2A 已交付

| 包 | 实现 | 说明 |
|---|---|---|
| `@yo-agent/surface-rpc` | **`JsonRpcPeer`** | 自研薄层 JSON-RPC 2.0；**请求并发分发**（不阻塞读循环）——turn/start 挂起等审批时 approval/decide 仍能并发处理，否则死锁 |
| | **`MessageChannel` + `InMemoryChannelPair` + `JsonlStreamChannel`** | 传输抽象：内存对（JSON round-trip 模拟序列化，测试用）+ LF 分隔 JSONL（stdin/stdout/socket，对标 codex exec --json / pi --mode rpc） |
| | **`RpcSurface`** | 把内核事件流暴露为通用远端驱动协议：`session/new · session/list · session/resume · turn/start · turn/steer · turn/interrupt · approval/decide · model/list · ping`；事件经 `event` 推送，ApprovalRequested 另发 `approval/request`（专用反向审批通道）；attach 在返回前重放历史后订阅（无事件窗口丢失） |
| `@yo-agent/kernel` | **`beginTurn`**（非阻塞起 turn）+ **`listSessions`** + **`listModels`** | 抽出 `launchTurn` 公共逻辑：阻塞版 `submitInput`（CLI）/ 非阻塞版 `beginTurn`（RPC，立即回 turnId、turn 后台跑、异常兜底 TurnFailed）；Kernel 接口补 startSession/beginTurn/listSessions/listModels |
| `apps/yo-agent` | **`rpc` 模式** | `yo-agent rpc`：JSON-RPC over stdin/stdout（stdout 是协议通道，日志走 stderr），常驻；客户端经 session/new 驱动。抽出 `buildKernel` 复用 |

## Slice 2C 已交付

| 包 | 实现 | 说明 |
|---|---|---|
| `@yo-agent/surface-mcp` | **`McpServerSurface`** | 用 `@modelcontextprotocol/sdk` 把 yo-agent 暴露为 MCP server；注册 `run` 工具——委派一个任务：yo-agent 用自己的模型 + 内置工具跑完整 turn，归并最终回答 + 工具活动摘要为 MCP CallToolResult。复用整个内核（DESIGN §3.3 可编排执行节点） |
| | **`autoApproveGate`** + `createStdioTransport` | autonomous 节点放行所有工具（orchestrator 已委派信任，§15.3 安全注：破坏性工具 MCP elicitation 二次确认留后续）；stdio 传输工厂把 SDK 依赖收在本包内 |
| `apps/yo-agent` | **`mcp-server` 模式** | `yo-agent mcp-server`：MCP over stdio（stdout 是协议通道、日志走 stderr），常驻；buildKernel 注入 autoApproveGate |

**验证门全绿**：`pnpm run check` —— typecheck 0 错误 + 12 份 JSON Schema + **123 个测试（24 文件）**。
- surface-rpc 8 测试：ping/pong、model/list、session/new + SessionStarted 推送、session/list、文本 turn 流式、**工具 turn + 协议化审批（approval/request → approval/decide(allow/reject)，并发不死锁）**、turn/interrupt 解除挂起、session/resume 历史重放、未知方法 -32601。
- surface-mcp 4 测试：tools/list 暴露 run、run 委派文本 turn、**run 委派工具 turn（autoApproveGate 放行 → 工具执行 + 活动摘要）**、未知工具 isError。

**真进程冒烟**：
- `yo-agent rpc` 经 stdin 喂 JSON-RPC → stdout 正确回 `pong` / 模型目录 / session/new(SessionStarted 事件 + sessionId) / session/list；并发分发可见。
- `yo-agent mcp-server` 经 stdio 真 MCP 握手：`initialize` 返回 `serverInfo{name:yo-agent}` + `tools/list` 返回 `run` 工具（完整 inputSchema）——真实 MCP 客户端（Claude Code/Cursor）即可发现并调用。

## Slice 2B 已交付

| 包 | 实现 | 说明 |
|---|---|---|
| `@yo-agent/kernel` | **ResumeBuffer 接入** + `bufferedSince` | emit 喂内存 ring（默认 512 帧）；`bufferedSince(session, fromCursor)` 返回缺口或 null（gap 溢出） |
| | **会话状态持久化** + `resumeSession` | turn 完成态把 `messages` 窗口快照 + headCursor 落 store（upsert 会话行）；`resumeSession` 在会话不在内存时从持久态**重建 SessionState**，使后续 turn 带完整上下文续接（跨进程 / 重启） |
| `@yo-agent/store` | `SessionRow.messages` + `EventStore.listSessions` | 会话行携带 messages 快照（opaque JSON）；listSessions 给 `resume "last"` / 跨进程发现；SQLite 落盘重开往返 |
| `@yo-agent/surface-rpc` | **`session/reconnect`** + `session/resume "last"` + cursor 去重 | reconnect 无重放只填缺口（ring 覆盖→推缺口；溢出→EventLog 取显著事件摘要折叠流式）；resume 带历史重放 + 跨进程先 `resumeSession` 重建；push 按 cursor 单调去重使缺口填充与实时订阅可叠加不重发 |

**新增覆盖**（共 **133 测试 / 26 文件**）：surface-rpc resume/ordering 测试（reconnect 缺口填充、gap 溢出折叠流式、跨进程重建续 turn、审批跨重连存活、cursor 对账、resume 不重投已决审批、**gap 溢出读期间并发实时事件不丢缺口摘要**、信道关闭 reject pending）；surface-mcp 熔断→isError；store sqlite 会话行 messages 往返。

## Slice 2D 已交付

| 包 | 实现 | 说明 |
|---|---|---|
| `@yo-agent/auth`（新包） | **`DeviceIdentity`**（ed25519）+ **`PairingGate`** + 握手 | 设备身份（seed 存安全存储、公钥作标识）；配对门：受信公钥集 + 一次性配对码（**HMAC-SHA256(code, pubKey) 证明绑公钥 + 失败锁定**）；`serverHandshake`/`clientHandshake`：hello→challenge(nonce)→auth(签名[+配对证明])→ok/err，**nonce 签名挑战证明持有私钥（抗捕获重放，非静态 bearer）** |
| `@yo-agent/surface-rpc` | **`WebSocketChannel`** + `serveWebSocket` / `connectWebSocket` | WS 传输（MessageChannel over ws，写错误/close→onClose 断连清算）；serve 每连接先过 serverHandshake 鉴权才交 RpcSurface；connect 先握手再回已鉴权信道 |
| `apps/yo-agent` | **`rpc --listen <port>`** | WS server 模式：YO_TRUSTED_KEYS 载入受信公钥、否则发一次性配对码（stderr）；每连接鉴权 → RpcSurface（共享内核）。建议仅经 Tailscale/WireGuard 隧道访问 |

**新增覆盖**：auth 9 测试（签名验/篡改换钥失败、seed 还原、受信通过、配对成功并注册、无码拒、错码拒、配对码一次性、失败锁定、**坏签名抗重放冒充**）；surface-rpc ws 3 测试（**真 localhost ws**：配对→受信→JSON-RPC ping/pong+驱动一轮、未配对拒绝、受信免码重连）。真进程冒烟：`rpc --listen 8799` 打印配对码 + WS 监听。

## 对抗式审查（Phase 2 表面）→ 15 项确认缺陷全部修复

5 维多智能体审查（JSON-RPC 并发 / RpcSurface / resume 跨进程 / MCP / app 接线）→ 17 原始、15 确认、逐条对抗式核验：

- **critical**：`session/reconnect` 溢出分支——异步读 EventLog 的 await 间隙里并发 turn 的实时事件抢先推进 lastCursor，把低 cursor 的 gap 摘要去重静默吞掉（含挂起审批 → 永久挂起）。修复：统一 attach/reconnect 为 **先订阅入临时缓冲 → 填历史/缺口 → flush 缓冲**，不依赖 EventStore.read 是否反映并发 append。
- **high**：① 信道关闭时 pending 请求永不 reject（挂起+泄漏）→ peer.close() + channel onClose 断连清算；② `JsonlStreamChannel` 写错误（EPIPE）无监听 → 崩进程 → 注册 output 'error'/input end/close、send 断后 no-op；③ attach 在 SQLite 冻结快照下 replay 与 subscribe 间窗口丢实时事件 → 同 critical 的统一修复；④ 跨进程 resume 不与 EventLog head 对账 → 续 turn cursor 冲突 append 抛错 → `headCursor=max(row, logHead)`；⑤ beginTurn 后台 runTurn 兜底 emit 自身抛错 → unhandledRejection 崩进程 → 兜底再包 try/catch；⑥ MCP 一次性会话永不回收 → 内存泄漏 → `kernel.endSession` + runTask finally；⑦ MCP 把 loop_detected/max_turn_steps/interrupted（藏在 TurnCompleted.stopReason）当成功 → 按 stopReason 判 isError。
- **medium**：`session/resume` 重放已决审批误弹 approval/request → `isApprovalPending` 门控（先登记 pending 再 emit）；rpc/mcp 常驻进程缺 stdout EPIPE / 全局错误兜底 → process 守卫。
- **low**：JSON-RPC 错误码（ZodError→-32602）；resume 丢 lastCompactCursor（→ headCursor）；MCP 工具计数改 ToolCallCompleted(ok)。（persistState.state 死字段、FakeProvider 演示态多轮静默 2 项已注记，影响极低暂留。）

## 运行

```bash
# RPC 模式（FakeProvider 演示，无需 key）；客户端经 session/new → turn/start 驱动
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"ping"}' \
 '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"project":"/tmp/ws","permissionMode":"supervised","surfaceKind":"rpc"}}' \
 | pnpm exec tsx apps/yo-agent/src/main.ts rpc

# MCP server 模式：被 Claude Code/Cursor 当节点调用（在其 mcp 配置里指向 `yo-agent mcp-server`）
pnpm exec tsx apps/yo-agent/src/main.ts mcp-server   # 常驻，stdio 说 MCP
```

## 退出标准 —— ✅ Phase 2 全达成

- ① **任意远端客户端经 resume 驱动 yo-agent，断网/重启不丢 token / 不丢审批**：session/reconnect 缺口填充 + gap 溢出降级 + 跨进程会话从持久态重建续 turn + 审批跨重连存活（2B），经对抗式审查加固（并发/排序）；**WS + ed25519 设备鉴权（2D）→ 可隧道内端到端**。
- ② **yo-agent 作 MCP server 被 Claude Code 调用、内置工具可用**：`run` 工具委派整个内核，真 stdio MCP 握手 + tools/list 验证（2C）。

**验证门**：`pnpm run check` —— typecheck 0 错误 + 12 份 JSON Schema + **145 个测试（28 文件）**全绿。

## 后续打磨（Phase 2 之外）

- **传输加固**：TLS + cert-pin / 服务端身份验证（当前 client→server 单向鉴权，依赖 Tailscale/WireGuard 隧道加密）；WS 满载 `-32001` + 指数退避；token 静默轮换。
- **MCP**：破坏性工具经 MCP elicitation 二次确认（替代 autoApprove）；`run` 进度经 MCP progress notification 流式。
- **resume**：`gitRef` 纳入会话行；gap 溢出降级"当前快照"接 checkpoint；turn 进行中更细粒度持久化。
