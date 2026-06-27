/**
 * AcpSurface（3F / DESIGN §6 / ADR-11）：被 ACP client（Zed/JetBrains）接管为编程 agent 后端。
 *
 * 决策（ADR-11 细化）：直接用 `@zed-industries/agent-client-protocol` 的 `AgentSideConnection`（实现 `Agent`
 * 接口），而非在自研 JsonRpcPeer 上重搓方法表——该包连接类是 spec 合规的、且 Stream 为对象级 AnyMessage 流，
 * 可用内存 TransformStream 对驱离线 CI（退出标准②由真实 `ClientSideConnection` 离线对驱达成）。
 *
 * 语义要点：
 * - session/prompt 阻塞：beginTurn 后挂 promise，等 TurnCompleted/TurnFailed 才 resolve（映射 stopReason）。
 * - 事件 → session/update 经 sendChain 串行化（高频 chunk 不乱序）；完成态在所有 update 发完后才 resolve prompt。
 * - ApprovalRequested → 反向阻塞 requestPermission（仅对仍 pending 且未发过的，复用 isApprovalPending 去重）。
 * - cursor 去重：history 重放（loadSession）与 live 订阅幂等叠加。
 * - fs/* 反向能力经 Protected Paths + 路径逃逸守卫。
 */
import type { Kernel, Surface, SurfaceKind } from '@yo-agent/kernel';
import type { AgentEvent, ApprovalDecision, EventEnvelope, Id } from '@yo-agent/protocol';
import { AgentSideConnection, PROTOCOL_VERSION, RequestError } from '@zed-industries/agent-client-protocol';
import type {
  Agent,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  Stream,
  ToolCallUpdate,
} from '@zed-industries/agent-client-protocol';
import { ensureFsPathAllowed, FsGuardError } from './fs-guard';
import { type AcpSessionUpdate, type AcpStopReason, blocksToText, eventToSessionUpdate, mapStopReason } from './translate';

type ApprovalRequestedEvent = Extract<AgentEvent, { kind: 'ApprovalRequested' }>;
const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

export class AcpSurface implements Surface {
  readonly kind: SurfaceKind = 'acp';
  private kernel!: Kernel;
  private conn!: AgentSideConnection;
  private clientCaps: ClientCapabilities = {};
  private promptSeq = 0;
  /** 串行化 session/update + prompt 完成态（保证顺序、不乱序）。 */
  private sendChain: Promise<void> = Promise.resolve();
  private readonly subs = new Map<Id, () => void>();
  private readonly pending = new Map<Id, { resolve: (r: AcpStopReason) => void; reject: (e: unknown) => void }>();
  private readonly lastCursor = new Map<Id, number>();
  private readonly sentApprovals = new Set<Id>();
  private readonly cwds = new Map<Id, string>();

  constructor(private readonly stream: Stream) {}

  async start(kernel: Kernel): Promise<void> {
    this.kernel = kernel;
    this.conn = new AgentSideConnection(() => this.agent(), this.stream);
  }

  /** Agent 接口实现（交给 AgentSideConnection 路由 ACP 请求/通知）。 */
  private agent(): Agent {
    return {
      initialize: (p) => this.initialize(p),
      authenticate: async () => ({}), // 无 ACP 层鉴权（远端鉴权走 WS 设备鉴权，Phase 2D）
      newSession: (p) => this.newSession(p),
      loadSession: (p) => this.loadSession(p),
      prompt: (p) => this.prompt(p),
      cancel: (p) => this.cancel(p),
    };
  }

  // ───────────────────────── ACP 方法 ─────────────────────────

  private async initialize(p: InitializeRequest): Promise<InitializeResponse> {
    this.clientCaps = p.clientCapabilities ?? {};
    return {
      // 返回 client 指定版本（若 ≤ 我方支持），否则我方最新——min 正合此语义。
      protocolVersion: Math.min(p.protocolVersion, PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: true,
        // MVP：不声明 image/audio/embeddedContext；MCP http/sse 由 host 侧管（3G），ACP 侧不代理。
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [], // 无 ACP 层鉴权（远端鉴权走 WS 设备鉴权，Phase 2D）
    };
  }

  private async newSession(p: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = await this.kernel.startSession({ cwd: p.cwd });
    this.cwds.set(sessionId, p.cwd);
    this.attach(sessionId);
    return { sessionId };
  }

  private async loadSession(p: LoadSessionRequest): Promise<LoadSessionResponse> {
    const ok = await this.kernel.resumeSession(p.sessionId);
    if (!ok) throw RequestError.resourceNotFound(p.sessionId);
    this.cwds.set(p.sessionId, p.cwd);
    this.attach(p.sessionId);
    // 重放历史 → session/update（cursor 去重，与 live 订阅幂等）。loadSession 期间无并发 turn（client 先 await）。
    for await (const env of this.kernel.events.read(p.sessionId)) this.onEvent(env);
    await this.sendChain; // 历史 update 全部发完再返回
    return {};
  }

  private async prompt(p: PromptRequest): Promise<PromptResponse> {
    const text = blocksToText(p.prompt);
    const idemKey = `acp-${p.sessionId}-${++this.promptSeq}`;
    const result = new Promise<AcpStopReason>((resolve, reject) => {
      this.pending.set(p.sessionId, { resolve, reject });
    });
    try {
      await this.kernel.beginTurn(p.sessionId, text, idemKey); // 非阻塞返回 turnId；事件经订阅推送
    } catch (e) {
      this.pending.delete(p.sessionId);
      throw RequestError.internalError({ message: e instanceof Error ? e.message : String(e) });
    }
    const stopReason = await result; // 阻塞至 TurnCompleted/TurnFailed
    return { stopReason };
  }

  private async cancel(p: CancelNotification): Promise<void> {
    await this.kernel.interrupt(p.sessionId);
  }

  // ───────────────────────── fs/* 反向能力（Protected Paths + 逃逸守卫）─────────────────────────

  /** 经 client 读文件（ACP fs/read_text_file）。越界/保护路径被拦。 */
  async readTextFile(sessionId: Id, path: string, opts?: { line?: number; limit?: number }): Promise<string> {
    this.guardFs(sessionId, path);
    const res = await this.conn.readTextFile({ sessionId, path, line: opts?.line ?? null, limit: opts?.limit ?? null });
    return res.content;
  }

  /** 经 client 写文件（ACP fs/write_text_file）。越界/保护路径被拦。 */
  async writeTextFile(sessionId: Id, path: string, content: string): Promise<void> {
    this.guardFs(sessionId, path);
    await this.conn.writeTextFile({ sessionId, path, content });
  }

  private guardFs(sessionId: Id, path: string): void {
    const cwd = this.cwds.get(sessionId);
    if (!cwd) throw RequestError.invalidParams({ reason: `unknown session: ${sessionId}` });
    try {
      ensureFsPathAllowed(path, cwd);
    } catch (e) {
      if (e instanceof FsGuardError) throw RequestError.invalidParams({ reason: e.reason, message: e.message });
      throw e;
    }
  }

  // ───────────────────────── 事件回路 ─────────────────────────

  private attach(sessionId: Id): void {
    this.detach(sessionId);
    this.lastCursor.set(sessionId, -1);
    const unsub = this.kernel.subscribe(sessionId, null, (env) => this.onEvent(env));
    this.subs.set(sessionId, unsub);
  }

  private detach(sessionId: Id): void {
    const u = this.subs.get(sessionId);
    if (u) {
      u();
      this.subs.delete(sessionId);
    }
  }

  private onEvent(env: EventEnvelope): void {
    const last = this.lastCursor.get(env.sessionId) ?? -1;
    if (env.cursor <= last) return; // cursor 去重：history 重放与 live 订阅幂等叠加
    this.lastCursor.set(env.sessionId, env.cursor);
    const ev = env.event;
    if (ev.kind === 'TurnCompleted') {
      this.resolvePrompt(env.sessionId, mapStopReason(ev.stopReason));
      return;
    }
    if (ev.kind === 'TurnFailed') {
      this.rejectPrompt(env.sessionId, ev.error.message);
      return;
    }
    if (ev.kind === 'ApprovalRequested') {
      void this.handleApproval(env.sessionId, ev);
      return;
    }
    const update = eventToSessionUpdate(ev);
    if (update) this.enqueueUpdate(env.sessionId, update);
  }

  private enqueueUpdate(sessionId: Id, update: AcpSessionUpdate): void {
    this.sendChain = this.sendChain.then(() => this.conn.sessionUpdate({ sessionId, update })).catch(() => {});
  }

  private resolvePrompt(sessionId: Id, stop: AcpStopReason): void {
    // 串到 sendChain 末尾：保证所有 update 先发出，client 收齐后才得 stopReason。
    this.sendChain = this.sendChain.then(() => {
      const p = this.pending.get(sessionId);
      if (p) {
        this.pending.delete(sessionId);
        p.resolve(stop);
      }
    });
  }

  private rejectPrompt(sessionId: Id, message: string): void {
    this.sendChain = this.sendChain.then(() => {
      const p = this.pending.get(sessionId);
      if (p) {
        this.pending.delete(sessionId);
        p.reject(RequestError.internalError({ message }));
      }
    });
  }

  /** ApprovalRequested → 反向阻塞 requestPermission；仅对仍 pending 且未发过的发一次（防重放风暴）。 */
  private async handleApproval(sessionId: Id, ev: ApprovalRequestedEvent): Promise<void> {
    if (!this.kernel.isApprovalPending(ev.requestId)) return;
    if (this.sentApprovals.has(ev.requestId)) return;
    this.sentApprovals.add(ev.requestId);

    const options: PermissionOption[] =
      ev.suggestions.length > 0
        ? ev.suggestions.map((s) => ({ optionId: s.decision, name: s.label ?? s.decision, kind: s.decision }))
        : APPROVAL_DECISIONS.map((d) => ({ optionId: d, name: d, kind: d }));

    const toolCall: ToolCallUpdate = {
      toolCallId: ev.requestId,
      title: ev.tool,
      status: 'pending',
      rawInput: ev.input && typeof ev.input === 'object' && !Array.isArray(ev.input) ? (ev.input as Record<string, unknown>) : { value: ev.input },
    };

    try {
      const res = await this.conn.requestPermission({ sessionId, options, toolCall });
      const decision =
        res.outcome.outcome === 'selected' && isApprovalDecision(res.outcome.optionId)
          ? res.outcome.optionId
          : 'reject_once'; // cancelled / 非法 optionId → 兜底拒
      if (this.kernel.isApprovalPending(ev.requestId)) this.kernel.decideApproval(ev.requestId, decision);
    } catch {
      // 反向请求失败（断连/取消）→ 默认拒，避免 turn 永久挂起。
      if (this.kernel.isApprovalPending(ev.requestId)) this.kernel.decideApproval(ev.requestId, 'reject_once');
    }
  }
}

function isApprovalDecision(s: string): s is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(s);
}
