# Phase 2 —— 协议化暴露（泛化 RpcSurface + MCP server）

> 对应 [`DESIGN.md`](DESIGN.md) §6 / §13 Phase 2。yo-aichat 废弃后路线重排：先"被集成"（协议暴露，复用最大、零开放渠道风险、Claude Code 即消费者）。延续"零网络风险"分片，每片离线可验证。
> **Slice 2A**：RpcSurface 核心（JSON-RPC over JSONL/in-memory，通用远端驱动）—— **已交付**。
> **Slice 2C**：McpServerSurface（`mcp-server`，被 Claude Code/Cursor 调用）—— **已交付**。
> **Slice 2B**：resume/reconnect 完整化（ResumeBuffer 接入 + gap 溢出 + 跨进程会话重建 + 审批跨重连存活）—— **已交付**。
> **Slice 2D（后续）**：鉴权（ed25519 + 配对码 + nonce）给 socket/WS 传输。

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

**新增覆盖**（共 **128 测试 / 25 文件**）：surface-rpc resume 4 测试（reconnect 缺口填充只推 fromCursor 之后、gap 溢出走 EventLog 摘要折叠流式、**跨进程重建：新内核共享 store → resume 重放 + 续 turn 且 provider 收到的 messages 含上一轮上下文**、审批跨重连存活）；store sqlite 会话行（含 messages）落盘重开往返。

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

## 剩余（Phase 2 后续分片）

- **Slice 2D**：鉴权（`@noble/ed25519` + 配对码 + 每连接 nonce 挑战）给 socket/WS 传输；WS 传输（TCP）。这是把 RPC 暴露到网络（隧道外）前的安全闸。
- **MCP server 打磨**：破坏性工具经 MCP elicitation 二次确认（替代 autoApprove）；`run` 进度经 MCP progress notification 流式。
- **resume 打磨**：`gitRef` 纳入会话行（resume 四要素之一）；gap 溢出降级里"当前快照"接 checkpoint；turn 进行中（非完成态）的更细粒度持久化。

## 退出标准

- ① **任意远端客户端经 resume 驱动 yo-agent，断网/重启不丢 token / 不丢审批 —— ✅ 核心达成**：session/reconnect 缺口填充 + gap 溢出降级 + 跨进程会话从持久态重建续 turn + 审批跨重连存活，均离线测试覆盖（rpc/mcp stdio 真进程冒烟 + memory/sqlite 持久化往返）。网络传输鉴权（2D）后即可隧道外端到端。
- ② **yo-agent 作 MCP server 被 Claude Code 调用、内置工具可用 —— ✅ 已达成**：`run` 工具委派整个内核，真 stdio MCP 握手 + tools/list 验证。
