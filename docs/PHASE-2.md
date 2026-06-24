# Phase 2 —— 协议化暴露（泛化 RpcSurface + MCP server）

> 对应 [`DESIGN.md`](DESIGN.md) §6 / §13 Phase 2。yo-aichat 废弃后路线重排：先"被集成"（协议暴露，复用最大、零开放渠道风险、Claude Code 即消费者）。延续"零网络风险"分片，每片离线可验证。
> **Slice 2A**：RpcSurface 核心（JSON-RPC over JSONL/in-memory，通用远端驱动）—— **已交付**。
> **Slice 2B（后续）**：resume/reconnect 完整化（ResumeBuffer 接入 + gap 溢出 + 跨进程会话重建）。
> **Slice 2C（后续）**：McpServerSurface（`--mcp-server`，被 Claude Code 调用）。
> **Slice 2D（后续）**：鉴权（ed25519 + 配对码 + nonce）给 socket/WS 传输。

## Slice 2A 已交付

| 包 | 实现 | 说明 |
|---|---|---|
| `@yo-agent/surface-rpc` | **`JsonRpcPeer`** | 自研薄层 JSON-RPC 2.0；**请求并发分发**（不阻塞读循环）——turn/start 挂起等审批时 approval/decide 仍能并发处理，否则死锁 |
| | **`MessageChannel` + `InMemoryChannelPair` + `JsonlStreamChannel`** | 传输抽象：内存对（JSON round-trip 模拟序列化，测试用）+ LF 分隔 JSONL（stdin/stdout/socket，对标 codex exec --json / pi --mode rpc） |
| | **`RpcSurface`** | 把内核事件流暴露为通用远端驱动协议：`session/new · session/list · session/resume · turn/start · turn/steer · turn/interrupt · approval/decide · model/list · ping`；事件经 `event` 推送，ApprovalRequested 另发 `approval/request`（专用反向审批通道）；attach 在返回前重放历史后订阅（无事件窗口丢失） |
| `@yo-agent/kernel` | **`beginTurn`**（非阻塞起 turn）+ **`listSessions`** + **`listModels`** | 抽出 `launchTurn` 公共逻辑：阻塞版 `submitInput`（CLI）/ 非阻塞版 `beginTurn`（RPC，立即回 turnId、turn 后台跑、异常兜底 TurnFailed）；Kernel 接口补 startSession/beginTurn/listSessions/listModels |
| `apps/yo-agent` | **`rpc` 模式** | `yo-agent rpc`：JSON-RPC over stdin/stdout（stdout 是协议通道，日志走 stderr），常驻；客户端经 session/new 驱动。抽出 `buildKernel` 复用 |

**验证门全绿**：`pnpm run check` —— typecheck 0 错误 + 12 份 JSON Schema + **119 个测试（23 文件）**。
surface-rpc 8 测试覆盖：ping/pong、model/list、session/new + SessionStarted 推送、session/list、文本 turn 流式、**工具 turn + 协议化审批（approval/request → approval/decide(allow/reject)，并发不死锁）**、turn/interrupt 解除挂起、session/resume 历史重放、未知方法 -32601。

**真进程冒烟**：`yo-agent rpc` 经 stdin 喂 JSON-RPC → stdout 正确回 `pong` / 模型目录 / session/new(SessionStarted 事件 + sessionId) / session/list；并发分发可见（session/list 先于 await 了异步 attach 的 session/new 返回）。

## 运行

```bash
# RPC 模式（FakeProvider 演示，无需 key）；客户端经 session/new → turn/start 驱动
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"ping"}' \
 '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"project":"/tmp/ws","permissionMode":"supervised","surfaceKind":"rpc"}}' \
 | pnpm exec tsx apps/yo-agent/src/main.ts rpc
```

## 剩余（Phase 2 后续分片）

- **Slice 2B**：`session/reconnect`（无重放，ResumeBuffer 续实时）+ gap 溢出降级接入 + `session/resume "last"` + 跨进程会话状态从 EventLog 重建（resume 四要素精确续接）；审批跨重连存活（pending 进 ResumeBuffer）。
- **Slice 2C**：McpServerSurface（`@modelcontextprotocol/sdk`，`--mcp-server`）——把 yo-agent 暴露为 MCP server 被 Claude Code/Cursor 调用，复用内置工具。
- **Slice 2D**：鉴权（`@noble/ed25519` + 配对码 + 每连接 nonce 挑战）给 socket/WS 传输；WS 传输（TCP）。
- **退出标准**：① 任意远端客户端经隧道 resume 驱动 yo-agent，断网/重启不丢 token/不丢审批；② yo-agent 作 MCP server 被 Claude Code 调用、内置工具可用。
