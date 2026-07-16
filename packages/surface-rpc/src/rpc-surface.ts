/**
 * RpcSurface（DESIGN §6 / §7.2）：把内核事件流暴露为 JSON-RPC 2.0 通用远端驱动协议。
 * 只消费内核（startSession / beginTurn / steer / interrupt / decideApproval / 事件订阅），永不按内核内部分支。
 *
 * 方法：session/new · session/list · session/resume · session/fork · turn/start · turn/steer
 *      · turn/interrupt · approval/decide · model/list · ping。事件经 `event` 推送；ApprovalRequested 另发 `approval/request`。
 */
import type { Kernel, Surface, SurfaceKind } from '@yo-agent/kernel';
import type { EventEnvelope, Id } from '@yo-agent/protocol';
import {
  ApprovalDecideParamsSchema,
  RpcMethod,
  RpcServerMethod,
  SessionForkParamsSchema,
  SessionNewParamsSchema,
  SessionReconnectParamsSchema,
  SessionResumeParamsSchema,
  TurnInterruptParamsSchema,
  TurnSteerParamsSchema,
  TurnStartParamsSchema,
} from '@yo-agent/protocol';
import { gapOverflowSummary } from '@yo-agent/store';
import { JsonRpcPeer } from './jsonrpc';
import type { MessageChannel } from './transport';

export class RpcSurface implements Surface {
  readonly kind: SurfaceKind = 'rpc';
  private kernel!: Kernel;
  private peer!: JsonRpcPeer;
  private readonly unsubs = new Map<Id, () => void>();
  /** 已推送给客户端的最大 cursor（按 session）；push 据此去重，使 gap 填充与实时订阅可叠加不重发。 */
  private readonly lastCursor = new Map<Id, number>();

  constructor(private readonly channel: MessageChannel) {}

  async start(kernel: Kernel): Promise<void> {
    this.kernel = kernel;
    this.peer = new JsonRpcPeer(this.channel);

    this.peer.on(RpcMethod.SessionNew, (p) => this.sessionNew(p));
    this.peer.on(RpcMethod.SessionList, () => ({ sessions: kernel.listSessions() }));
    this.peer.on(RpcMethod.SessionResume, (p) => this.sessionResume(p));
    this.peer.on(RpcMethod.SessionReconnect, (p) => this.sessionReconnect(p));
    this.peer.on(RpcMethod.SessionFork, (p) => this.sessionFork(p));
    this.peer.on(RpcMethod.TurnStart, (p) => this.turnStart(p));
    this.peer.on(RpcMethod.TurnSteer, async (p) => {
      const x = TurnSteerParamsSchema.parse(p);
      await kernel.steer(x.sessionId, x.text);
      return null;
    });
    this.peer.on(RpcMethod.TurnInterrupt, async (p) => {
      const x = TurnInterruptParamsSchema.parse(p);
      await kernel.interrupt(x.sessionId);
      return null;
    });
    this.peer.on(RpcMethod.ApprovalDecide, (p) => {
      const x = ApprovalDecideParamsSchema.parse(p);
      kernel.decideApproval(x.requestId, x.decision, x.updatedInput);
      return null;
    });
    this.peer.on(RpcMethod.ModelList, () => kernel.listModels());
    this.peer.on(RpcMethod.Ping, () => 'pong');
  }

  // ───────────────────────── 方法实现 ─────────────────────────

  private async sessionNew(params: unknown): Promise<{ sessionId: Id; workspacePath: string }> {
    const p = SessionNewParamsSchema.parse(params);
    const sessionId = await this.kernel.startSession({
      cwd: p.project,
      model: p.model,
      permissionMode: p.permissionMode,
    });
    // attach 在返回 response 前完成 → 订阅在客户端能发 turn/start 之前就位，无事件窗口丢失。
    await this.attachFrom(sessionId, -1, async () => {
      for await (const env of this.kernel.events.read(sessionId)) this.push(env);
    });
    return { sessionId, workspacePath: p.project };
  }

  private async turnStart(params: unknown): Promise<{ turnId: Id }> {
    const p = TurnStartParamsSchema.parse(params);
    // 非阻塞：立即返回 turnId，事件经订阅推送；turn 挂起等审批时本 handler 已返回、不阻塞读循环。
    return this.kernel.beginTurn(p.sessionId, p.prompt, p.idemKey);
  }

  /** 带历史重放恢复（§6.3）：重放 fromCursor 之后全部事件 + 续实时。跨进程会话先从持久态重建。 */
  private async sessionResume(params: unknown): Promise<{ sessionId: Id }> {
    const p = SessionResumeParamsSchema.parse(params);
    let sessionId = p.sessionId;
    if (sessionId === 'last') {
      const rows = await this.kernel.events.listSessions();
      if (rows.length === 0) throw new Error('无可恢复的会话');
      sessionId = rows.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]!.sessionId;
    }
    const ok = await this.kernel.resumeSession(sessionId);
    if (!ok) throw new Error(`未知会话：${sessionId}`);
    // 带历史全量重放（fromCursor 之后）；readThread 跨 fork 链——fork 会话的历史存在源会话日志（5.3b），
    // 无谱系时与 events.read 逐事件等价。
    await this.attachFrom(sessionId, p.fromCursor ?? -1, async () => {
      for await (const env of this.kernel.readThread(sessionId, p.fromCursor === undefined || p.fromCursor < 0 ? undefined : p.fromCursor)) {
        this.push(env);
      }
    });
    return { sessionId };
  }

  /** fork（5.3b）：源会话 turn 边界分支出新会话，随后订阅接实时（新会话历史经 session/resume 的 readThread 取）。 */
  private async sessionFork(params: unknown): Promise<{ sessionId: Id }> {
    const p = SessionForkParamsSchema.parse(params);
    const newId = await this.kernel.forkSession(p.sessionId, p.atCursor);
    await this.attachFrom(newId, -1, async () => {
      for await (const env of this.kernel.readThread(newId)) this.push(env);
    });
    return { sessionId: newId };
  }

  /**
   * 无历史重连（§6.3）：只填 fromCursor 之后的缺口 + 续实时，不全量重放（省带宽）。
   * 内存 ring 覆盖缺口 → 推缺口；gap 溢出 → 从 EventLog 取"状态变更/审批/FileChanged"摘要。
   */
  private async sessionReconnect(params: unknown): Promise<{ sessionId: Id }> {
    const p = SessionReconnectParamsSchema.parse(params);
    const ok = await this.kernel.resumeSession(p.sessionId);
    if (!ok) throw new Error(`未知会话：${p.sessionId}`);
    await this.attachFrom(p.sessionId, p.fromCursor, async () => {
      const gap = this.kernel.bufferedSince(p.sessionId, p.fromCursor);
      if (gap !== null) {
        for (const env of gap) this.push(env);
      } else {
        // gap 溢出：全量 EventLog 取显著事件摘要（折叠流式噪声，§6.3）。
        const all: EventEnvelope[] = [];
        for await (const env of this.kernel.events.read(p.sessionId, p.fromCursor)) all.push(env);
        for (const env of gapOverflowSummary(all)) this.push(env);
      }
    });
    return { sessionId: p.sessionId };
  }

  // ───────────────────────── 事件推送 ─────────────────────────

  /**
   * 统一 attach：**先订阅**（实时事件入临时缓冲）→ 填历史/缺口（fill）→ flush 缓冲。
   * 关键：避免「回放/缺口读的 await 间隙里并发 turn 的实时事件抢先推进 lastCursor、把更早的历史/摘要去重吞掉」
   * 的丢事件竞态（审查 critical/high；不依赖具体 EventStore.read 是否反映并发 append）。
   */
  private async attachFrom(sessionId: Id, fromCursor: number, fill: () => Promise<void>): Promise<void> {
    this.detach(sessionId);
    this.lastCursor.set(sessionId, fromCursor);
    const queue: EventEnvelope[] = [];
    let flushing = false;
    const unsub = this.kernel.subscribe(sessionId, null, (env) => {
      if (flushing) this.push(env);
      else queue.push(env); // 填充期间缓冲实时事件
    });
    this.unsubs.set(sessionId, unsub);
    await fill(); // 推历史/缺口（升序，push 去重）
    flushing = true;
    for (const env of queue) this.push(env); // 补放实时缓冲（cursor 去重跳过与历史重叠的）
  }

  private detach(sessionId: Id): void {
    const u = this.unsubs.get(sessionId);
    if (u) {
      u();
      this.unsubs.delete(sessionId);
    }
  }

  private push(env: EventEnvelope): void {
    // 按 cursor 单调去重：gap 填充（升序）与实时订阅叠加时不重发、不丢序。
    const last = this.lastCursor.get(env.sessionId) ?? -1;
    if (env.cursor <= last) return;
    this.lastCursor.set(env.sessionId, env.cursor);
    this.peer.notify(RpcServerMethod.Event, env);
    // 专用反向审批通道：仅对**仍挂起**的审批重投（重放历史里已决审批不再误弹，审查 medium）。
    if (env.event.kind === 'ApprovalRequested' && this.kernel.isApprovalPending(env.event.requestId)) {
      this.peer.notify(RpcServerMethod.ApprovalRequest, {
        requestId: env.event.requestId,
        sessionId: env.sessionId,
        tool: env.event.tool,
        input: env.event.input,
        risk: env.event.risk,
        suggestions: env.event.suggestions,
      });
    }
  }
}
