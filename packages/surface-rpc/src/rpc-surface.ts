/**
 * RpcSurface（DESIGN §6 / §7.2）：把内核事件流暴露为 JSON-RPC 2.0 通用远端驱动协议。
 * 只消费内核（startSession / beginTurn / steer / interrupt / decideApproval / 事件订阅），永不按内核内部分支。
 *
 * 方法：session/new · session/list · session/resume · turn/start · turn/steer · turn/interrupt
 *      · approval/decide · model/list · ping。事件经 `event` 推送；ApprovalRequested 另发 `approval/request`。
 */
import type { Kernel, Surface, SurfaceKind } from '@yo-agent/kernel';
import type { EventEnvelope, Id } from '@yo-agent/protocol';
import {
  ApprovalDecideParamsSchema,
  RpcMethod,
  RpcServerMethod,
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
    await this.attach(sessionId, -1);
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
    await this.attach(sessionId, p.fromCursor ?? -1);
    return { sessionId };
  }

  /**
   * 无历史重连（§6.3）：只填 fromCursor 之后的缺口 + 续实时，不全量重放（省带宽）。
   * 内存 ring 覆盖缺口 → 推缺口；gap 溢出 → 从 EventLog 取"状态变更/审批/FileChanged"摘要。
   */
  private async sessionReconnect(params: unknown): Promise<{ sessionId: Id }> {
    const p = SessionReconnectParamsSchema.parse(params);
    const ok = await this.kernel.resumeSession(p.sessionId);
    if (!ok) throw new Error(`未知会话：${p.sessionId}`);
    this.detach(p.sessionId);
    this.lastCursor.set(p.sessionId, p.fromCursor);
    // 先取缺口快照 + 订阅（同步、无 await 间隙 → 缺口与实时无重叠丢失）；push 按 cursor 去重叠加。
    const gap = this.kernel.bufferedSince(p.sessionId, p.fromCursor);
    const unsub = this.kernel.subscribe(p.sessionId, null, (env) => this.push(env));
    this.unsubs.set(p.sessionId, unsub);
    if (gap !== null) {
      for (const env of gap) this.push(env);
    } else {
      // gap 溢出：全量 EventLog 取显著事件摘要（折叠流式噪声，§6.3）。
      const all: EventEnvelope[] = [];
      for await (const env of this.kernel.events.read(p.sessionId, p.fromCursor)) all.push(env);
      for (const env of gapOverflowSummary(all)) this.push(env);
    }
    return { sessionId: p.sessionId };
  }

  // ───────────────────────── 事件推送 ─────────────────────────

  private async attach(sessionId: Id, fromCursor: number): Promise<void> {
    this.detach(sessionId);
    this.lastCursor.set(sessionId, fromCursor);
    // 先重放已落库历史（fromCursor 之后），再订阅实时。attach 在 turn 启动前完成，二者无重叠窗口。
    for await (const env of this.kernel.events.read(sessionId, fromCursor < 0 ? undefined : fromCursor)) {
      this.push(env);
    }
    const unsub = this.kernel.subscribe(sessionId, null, (env) => this.push(env));
    this.unsubs.set(sessionId, unsub);
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
    if (env.event.kind === 'ApprovalRequested') {
      // 专用反向请求通道（客户端阻塞应答的 actionable 审批）。
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
