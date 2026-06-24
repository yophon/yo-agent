import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalSuggestion,
  EventEnvelope,
  Id,
  PermissionMode,
  Usage,
} from '@yo-agent/protocol';
import type { CanonMessage, ChatRequest, ContentBlock, Provider, ToolSpec } from '@yo-agent/provider';
import type { ToolContext, ToolRegistry } from '@yo-agent/tools';
import type { EventStore, SessionRow } from '@yo-agent/store';
import { ResumeBuffer } from '@yo-agent/store';
import type { ApprovalGate, Checkpointer, Condenser, Kernel, LoopBreaker } from './index';
import { estimateMessagesTokens } from './tokens';

const MUTATION_KINDS = new Set(['edit', 'delete', 'move']);

export interface AgentKernelDeps {
  store: EventStore;
  provider: Provider;
  tools: ToolRegistry;
  loopBreaker: LoopBreaker;
  condenser: Condenser;
  approvalGate?: ApprovalGate;
  /** L3 checkpoint：edit 类工具成功后快照工作区（§3.4），快照引用落 EventStore。 */
  checkpointer?: Checkpointer;
  model?: string;
  cwd?: string;
  maxStepsPerTurn?: number;
  /** 压缩触发用的可用上下文窗口（token）；app 从模型目录 contextWindow 注入。默认 200k。 */
  usableContextTokens?: number;
  /** 两次压缩之间最少间隔步数（§15.5 防频繁 compact 叠加 cache-miss）。默认 1。 */
  minStepsBetweenCompact?: number;
  /** 协议化交互审批：无 approvalGate 时挂起等外部 decideApproval（TUI/RPC）；false 则 headless 默认拒绝。 */
  interactiveApproval?: boolean;
  /** 交互审批超时（ms），到时默认 deny（§6.3）。0/缺省=不超时。 */
  approvalTimeoutMs?: number;
  /** ResumeBuffer 容量（最近 N 帧，服务实时重连缺口）。默认 512。 */
  resumeBufferCapacity?: number;
}

export interface StartSessionOpts {
  sessionId?: Id;
  model?: string;
  cwd?: string;
  system?: string;
  permissionMode?: PermissionMode;
}

interface SessionState {
  id: Id;
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  messages: CanonMessage[];
  headCursor: number;
  interrupted: boolean;
  subscribers: Set<(env: EventEnvelope) => void>;
  /** 上次压缩后保留窗口对应的最早 cursor（ContextCompacted.fromCursor 起点）。 */
  lastCompactCursor: number;
  /** 距上次压缩的步数（min-rounds guard）。 */
  stepsSinceCompact: number;
  /** allow_always/reject_always 的会话级缓存（按工具名）。 */
  approvalCache: Map<string, 'allow' | 'reject'>;
  /** 本会话挂起中的审批 requestId（interrupt 时需逐一以 deny 解除，防永久挂起 + 泄漏）。 */
  pendingApprovalIds: Set<Id>;
}

interface ToolCallAccum {
  id: string;
  name: string;
}

/**
 * AgentKernel —— 唯一会写 AgentEvent 流的人（DESIGN §0.3 / §2）。
 * 单循环 ReAct：组装上下文 → 调 provider → 执行工具 → 审批 → 注入 observation → 熔断/续传。
 * 每个 emit 分配单调 cursor、append 进 EventStore、fan-out 给订阅者（事件溯源，§2.1）。
 */
export class AgentKernel implements Kernel {
  readonly events: EventStore;
  private readonly d: AgentKernelDeps;
  private readonly sessions = new Map<Id, SessionState>();
  /** 内存 ring：服务实时重连缺口（§6.3 / §10.1）；跨进程（新内核）为空 → 走 EventLog gap 溢出降级。 */
  private readonly resumeBuffer: ResumeBuffer;
  private readonly pendingApprovals = new Map<
    Id,
    (decision: { decision: ApprovalDecision; updatedInput?: unknown }) => void
  >();

  constructor(deps: AgentKernelDeps) {
    this.events = deps.store;
    this.d = deps;
    this.resumeBuffer = new ResumeBuffer(deps.resumeBufferCapacity ?? 512);
  }

  async startSession(opts: StartSessionOpts = {}): Promise<Id> {
    const id = opts.sessionId ?? randomUUID();
    const s: SessionState = {
      id,
      model: opts.model ?? this.d.model ?? 'fake-model',
      cwd: opts.cwd ?? this.d.cwd ?? process.cwd(),
      permissionMode: opts.permissionMode ?? 'supervised',
      messages: opts.system ? [{ role: 'system', content: opts.system }] : [],
      headCursor: -1,
      interrupted: false,
      subscribers: new Set(),
      lastCompactCursor: 0,
      stepsSinceCompact: 0,
      approvalCache: new Map(),
      pendingApprovalIds: new Set(),
    };
    this.sessions.set(id, s);
    await this.emit(s, {
      kind: 'SessionStarted',
      externalId: id,
      model: s.model,
      tools: this.toolNames(s),
      workspacePath: s.cwd,
      permissionMode: s.permissionMode,
      profile: 'default',
    });
    await this.persistState(s); // 持久会话行（含 messages 快照），跨进程 resume 重建用
    return id;
  }

  /**
   * 跨进程 resume：会话不在内存（进程重启）则从持久态重建 SessionState（messages 快照 + headCursor），
   * 使其后续 turn 带完整上下文续接。已在内存则直接返回 true；store 无此会话返回 false。
   */
  async resumeSession(sessionId: Id): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;
    const row = await this.events.getSession(sessionId);
    if (!row) return false;
    const s: SessionState = {
      id: sessionId,
      model: row.model,
      cwd: row.workspacePath,
      permissionMode: (row.permissionMode as PermissionMode) ?? 'supervised',
      messages: (row.messages as CanonMessage[]) ?? [],
      headCursor: row.headCursor,
      interrupted: false,
      subscribers: new Set(),
      lastCompactCursor: 0,
      stepsSinceCompact: 0,
      approvalCache: new Map(),
      pendingApprovalIds: new Set(),
    };
    this.sessions.set(sessionId, s);
    return true;
  }

  /** 内存 ring 取 fromCursor 之后的缺口（实时重连）；返回 null 表示 gap 溢出，调用方走 EventLog 降级。 */
  bufferedSince(sessionId: Id, fromCursor: number): EventEnvelope[] | null {
    return this.resumeBuffer.since(sessionId, fromCursor);
  }

  subscribe(sessionId: Id, _fromCursor: number | null, handler: (env: EventEnvelope) => void): () => void {
    const s = this.require(sessionId);
    s.subscribers.add(handler);
    return () => s.subscribers.delete(handler);
  }

  decideApproval(requestId: Id, decision: ApprovalDecision, updatedInput?: unknown): void {
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve) {
      this.pendingApprovals.delete(requestId);
      resolve({ decision, updatedInput });
    }
  }

  /** 阻塞版（CLI 用）：跑完整 turn 才 resolve。 */
  async submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<{ turnId: Id }> {
    const { turnId, done } = await this.launchTurn(this.require(sessionId), prompt, idemKey);
    await done;
    return { turnId };
  }

  /** 非阻塞版（RpcSurface 用）：发出 TurnStarted 后立即返回 turnId，turn 在后台跑、事件经订阅推送。 */
  async beginTurn(sessionId: Id, prompt: string, idemKey: string): Promise<{ turnId: Id }> {
    const { turnId } = await this.launchTurn(this.require(sessionId), prompt, idemKey);
    return { turnId };
  }

  /** 公共起 turn 逻辑：emit TurnStarted → 后台跑 runTurn（异常兜底 TurnFailed）。返回 turnId 与完成 Promise。 */
  private async launchTurn(s: SessionState, prompt: string, idemKey: string): Promise<{ turnId: Id; done: Promise<void> }> {
    s.interrupted = false;
    const turnId = randomUUID();
    await this.emit(s, { kind: 'TurnStarted', turnId, promptIdemKey: idemKey }, turnId);
    s.messages.push({ role: 'user', content: prompt });
    const done = this.runTurn(s, turnId).catch(async (e) => {
      await this.emit(s, { kind: 'TurnFailed', error: { message: e instanceof Error ? e.message : String(e) } }, turnId);
    });
    return { turnId, done };
  }

  /** 列活动会话摘要（RpcSurface session/list）。 */
  listSessions(): Array<{ sessionId: Id; model: string; workspacePath: string; permissionMode: PermissionMode; headCursor: number }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      model: s.model,
      workspacePath: s.cwd,
      permissionMode: s.permissionMode,
      headCursor: s.headCursor,
    }));
  }

  /** 模型目录（RpcSurface model/list），委派 provider。 */
  listModels(): ReturnType<Provider['listModels']> {
    return this.d.provider.listModels();
  }

  async steer(sessionId: Id, text: string): Promise<void> {
    this.require(sessionId).messages.push({ role: 'user', content: text });
  }

  async interrupt(sessionId: Id): Promise<void> {
    const s = this.require(sessionId);
    s.interrupted = true;
    // 若当前卡在等待交互审批，逐一以 deny 解除挂起，否则 turn 永不返回 + pending 泄漏。
    for (const requestId of s.pendingApprovalIds) {
      const resolve = this.pendingApprovals.get(requestId);
      if (resolve) {
        this.pendingApprovals.delete(requestId);
        resolve({ decision: 'reject_once' });
      }
    }
    s.pendingApprovalIds.clear();
  }

  // ───────────────────────── turn 循环 ─────────────────────────

  private async runTurn(s: SessionState, turnId: Id): Promise<void> {
    const maxSteps = this.d.maxStepsPerTurn ?? 64;
    for (let step = 0; step < maxSteps; step++) {
      if (s.interrupted) {
        await this.emit(s, { kind: 'TurnCompleted', stopReason: 'interrupted', usage: zeroUsage() }, turnId);
        return;
      }

      const req: ChatRequest = { modelId: s.model, messages: s.messages, tools: this.toolSpecs(s) };
      let text = '';
      const toolCalls: ToolCallAccum[] = [];
      const argsById = new Map<string, string>();
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' = 'end_turn';
      let usage: Usage | undefined;

      for await (const ev of this.d.provider.streamChat(req)) {
        switch (ev.kind) {
          case 'TextDelta':
            text += ev.text;
            await this.emit(s, { kind: 'AssistantText', delta: ev.text }, turnId);
            break;
          case 'ThinkingDelta':
            await this.emit(s, { kind: 'Reasoning', delta: ev.text }, turnId);
            break;
          case 'ToolCallStart':
            toolCalls.push({ id: ev.id, name: ev.name });
            argsById.set(ev.id, '');
            break;
          case 'ToolCallArgsDelta':
            argsById.set(ev.id, (argsById.get(ev.id) ?? '') + ev.delta);
            break;
          case 'ToolCallEnd':
            break;
          case 'UsageUpdate':
            usage = ev.usage;
            await this.emit(s, { kind: 'UsageUpdate', ...ev.usage }, turnId);
            break;
          case 'Stop':
            stopReason = ev.reason;
            break;
          case 'Error':
            await this.emit(s, { kind: 'Error', message: ev.error.message }, turnId);
            await this.emit(
              s,
              { kind: 'TurnFailed', error: { message: ev.error.message, retryable: ev.error.retryable } },
              turnId,
            );
            return;
        }
      }

      // max_tokens：话未说完，追加"请继续"续传，不算错误（§15.1）。
      if (stopReason === 'max_tokens') {
        s.messages.push({ role: 'assistant', content: text ? [{ type: 'text', text }] : [] });
        s.messages.push({ role: 'user', content: '请继续' });
        continue;
      }
      if (stopReason === 'pause_turn') continue;

      // 无工具调用 → 收尾。
      if (toolCalls.length === 0) {
        s.messages.push({ role: 'assistant', content: text });
        await this.emit(s, { kind: 'TurnCompleted', stopReason: 'end_turn', usage: usage ?? zeroUsage() }, turnId);
        return;
      }

      // 有工具调用：执行 0..N 个，结果合并为单条 user 消息回填（§15.1）。
      const available = this.d.tools.resolveAvailable(this.toolCtx(s));
      const assistantBlocks: ContentBlock[] = [];
      if (text) assistantBlocks.push({ type: 'text', text });
      const toolResults: ContentBlock[] = [];

      for (const tc of toolCalls) {
        let input = parseJsonObject(argsById.get(tc.id) ?? '');
        const desc = available.find((d) => d.name === tc.name);

        // 熔断（引擎层强制）。
        const verdict = this.d.loopBreaker.check({ name: tc.name, input });
        if (verdict === 'break') {
          await this.emit(s, { kind: 'Error', message: `检测到死循环：反复调用 ${tc.name}` }, turnId);
          await this.emit(s, { kind: 'TurnCompleted', stopReason: 'loop_detected', usage: usage ?? zeroUsage() }, turnId);
          return;
        }

        assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });

        // 审批（never 放行；always / risk-based 走 ApprovalGate，无 gate 默认 deny）。
        if (desc && desc.approval !== 'never') {
          // allow_always/reject_always 落 session 级缓存，同名工具后续不再重复弹审批（§9.2 会话内升级）。
          const cached = s.approvalCache.get(tc.name);
          let decision: ApprovalDecision;
          let updatedInput: unknown;
          if (cached) {
            decision = cached === 'allow' ? 'allow_always' : 'reject_always';
          } else {
            const r = await this.requestApproval(s, tc.id, tc.name, input, turnId);
            decision = r.decision;
            updatedInput = r.updatedInput;
            if (decision === 'allow_always') s.approvalCache.set(tc.name, 'allow');
            else if (decision === 'reject_always') s.approvalCache.set(tc.name, 'reject');
          }
          if (decision === 'reject_once' || decision === 'reject_always') {
            toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: '用户拒绝了该工具调用', isError: true, name: tc.name });
            continue;
          }
          // modify：用户改参数后放行 → 用 updatedInput 覆盖（同步回传给 LLM 的 tool_use.input）。
          if (updatedInput !== undefined) {
            input = updatedInput;
            const block = assistantBlocks[assistantBlocks.length - 1];
            if (block && block.type === 'tool_use') block.input = updatedInput;
          }
        }

        await this.emit(
          s,
          { kind: 'ToolCallStarted', id: tc.id, name: tc.name, toolKind: desc?.kind ?? 'other', summary: tc.name, input },
          turnId,
        );

        const exec = this.d.tools.executor(tc.name);
        if (!exec) {
          await this.emit(s, { kind: 'ToolCallCompleted', id: tc.id, status: 'error' }, turnId);
          toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: `未知工具：${tc.name}`, isError: true, name: tc.name });
          continue;
        }

        let out = '';
        let isError = false;
        try {
          for await (const te of exec.execute(input, this.toolCtx(s))) {
            if (te.kind === 'output') {
              out += te.chunk;
              await this.emit(s, { kind: 'ToolCallOutput', id: tc.id, chunk: te.chunk, exitCode: te.exitCode }, turnId);
            }
          }
        } catch (e) {
          isError = true;
          out = e instanceof Error ? e.message : String(e);
        }
        await this.emit(s, { kind: 'ToolCallCompleted', id: tc.id, status: isError ? 'error' : 'ok' }, turnId);
        toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: out, isError: isError || undefined, name: tc.name });

        // edit 类工具成功 → 发 FileChanged + L3 checkpoint 快照（§2.2 / §3.4）。
        if (!isError && desc && MUTATION_KINDS.has(desc.kind)) {
          await this.afterMutation(s, desc.kind, input, turnId);
        }
      }

      s.messages.push({ role: 'assistant', content: assistantBlocks });
      s.messages.push({ role: 'user', content: toolResults });
      // ContextManager.maybeCompact()：注入 observation 后按 token 阈值触发压缩（§2.1 / §5.1）。
      await this.maybeCompact(s, turnId);
    }

    await this.emit(s, { kind: 'TurnCompleted', stopReason: 'max_turn_steps', usage: zeroUsage() }, turnId);
  }

  /**
   * 超阈值压缩消息窗口（§5.1）：condense 只改送 LLM 的窗口，原始 EventLog 不删；
   * 另发 ContextCompacted{fromCursor,toCursor,tokensSaved} 落库（可审计、可逆）。min-rounds guard 防频繁压缩。
   */
  private async maybeCompact(s: SessionState, turnId: Id): Promise<void> {
    s.stepsSinceCompact++;
    const minSteps = this.d.minStepsBetweenCompact ?? 1;
    if (s.stepsSinceCompact < minSteps) return;
    const usableTokens = this.d.usableContextTokens ?? 200_000;
    const before = estimateMessagesTokens(s.messages);
    if (!this.d.condenser.shouldCompact({ usedTokens: before, usableTokens })) return;

    const condensed = await this.d.condenser.condense(s.messages);
    if (condensed === s.messages || condensed.length >= s.messages.length) return; // 没压成，不发事件
    s.messages = condensed;
    const after = estimateMessagesTokens(condensed);
    const toCursor = s.headCursor; // ContextCompacted 自身分配的 cursor 在 toCursor 之后
    await this.emit(
      s,
      { kind: 'ContextCompacted', fromCursor: s.lastCompactCursor, toCursor, tokensSaved: Math.max(0, before - after) },
      turnId,
    );
    s.lastCompactCursor = s.headCursor;
    s.stepsSinceCompact = 0;
  }

  /** edit 类工具成功后：发 FileChanged（best-effort，取 input.path）+ L3 checkpoint 快照。 */
  private async afterMutation(s: SessionState, kind: string, input: unknown, turnId: Id): Promise<void> {
    const path = typeof (input as { path?: unknown })?.path === 'string' ? (input as { path: string }).path : undefined;
    if (path) {
      const changeKind = kind === 'delete' ? 'delete' : kind === 'move' ? 'rename' : 'edit';
      await this.emit(s, { kind: 'FileChanged', path, changeKind }, turnId);
    }
    if (!this.d.checkpointer) return;
    try {
      const cp = await this.d.checkpointer.snapshot(`turn ${turnId}`);
      await this.events.saveCheckpoint({
        checkpointId: cp.checkpointId,
        sessionId: s.id,
        cursor: s.headCursor,
        shadowGitRef: cp.ref,
        createdAt: cp.createdAt,
      });
    } catch {
      // checkpoint 失败不阻断 turn（兜底安全网，非关键路径）。
    }
  }

  private async requestApproval(
    s: SessionState,
    _toolCallId: string,
    tool: string,
    input: unknown,
    turnId: Id,
  ): Promise<{ decision: ApprovalDecision; updatedInput?: unknown }> {
    const requestId = randomUUID();
    const suggestions: ApprovalSuggestion[] = [
      { decision: 'allow_once', label: '允许一次' },
      { decision: 'allow_always', label: '总是允许' },
      { decision: 'reject_once', label: '拒绝一次' },
      { decision: 'reject_always', label: '总是拒绝' },
    ];
    await this.emit(s, { kind: 'ApprovalRequested', requestId, tool, input, risk: 'unknown', suggestions }, turnId);
    if (this.d.approvalGate) {
      return await this.d.approvalGate.request({ sessionId: s.id, tool, input, risk: 'unknown' });
    }
    // 非交互（headless 无人应答）默认拒绝，保持安全下限。
    if (!this.d.interactiveApproval) return { decision: 'reject_once' };
    // 协议化审批（§3.4 / §6.2）：挂起注册 pending，等外部 decideApproval(requestId,...) 唤醒，可选超时默认 deny。
    // interrupt() 也能解除该挂起（见 interrupt）。
    s.pendingApprovalIds.add(requestId);
    try {
      return await new Promise<{ decision: ApprovalDecision; updatedInput?: unknown }>((resolve) => {
        this.pendingApprovals.set(requestId, ({ decision, updatedInput }) => resolve({ decision, updatedInput }));
        const ms = this.d.approvalTimeoutMs;
        if (ms && ms > 0) {
          setTimeout(() => {
            if (this.pendingApprovals.delete(requestId)) resolve({ decision: 'reject_once' });
          }, ms);
        }
      });
    } finally {
      s.pendingApprovalIds.delete(requestId);
    }
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  private async emit(s: SessionState, event: AgentEvent, turnId?: Id): Promise<void> {
    const cursor = ++s.headCursor;
    const env: EventEnvelope = {
      sessionId: s.id,
      cursor,
      parentId: null,
      turnId: turnId ?? null,
      ts: Date.now(),
      event,
    };
    await this.events.append(env);
    this.resumeBuffer.add(env); // 服务实时重连缺口
    for (const h of s.subscribers) h(env);
    // 在 turn 完成态把会话状态（含 messages 快照）落库，供跨进程 resume 重建。
    if (event.kind === 'TurnCompleted' || event.kind === 'TurnFailed') await this.persistState(s);
  }

  /** upsert 会话行（含 messages 窗口快照 + headCursor），跨进程 resume 重建用（§6.3 / §10.1）。 */
  private async persistState(s: SessionState): Promise<void> {
    const now = Date.now();
    const row: SessionRow = {
      sessionId: s.id,
      owner: 'self',
      surfaceKind: 'kernel',
      agentProfile: 'default',
      workspacePath: s.cwd,
      model: s.model,
      permissionMode: s.permissionMode,
      state: 'active',
      headCursor: s.headCursor,
      createdAt: now,
      lastActiveAt: now,
      messages: s.messages,
    };
    await this.events.createSession(row);
  }

  private require(id: Id): SessionState {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`未知会话：${id}`);
    return s;
  }

  private toolCtx(s: SessionState): ToolContext {
    return { sessionId: s.id, cwd: s.cwd };
  }

  private toolSpecs(s: SessionState): ToolSpec[] {
    return this.d.tools
      .resolveAvailable(this.toolCtx(s))
      .map((d) => ({ name: d.name, description: d.description, jsonSchema: d.inputSchema }));
  }

  private toolNames(s: SessionState): string[] {
    return this.d.tools.resolveAvailable(this.toolCtx(s)).map((d) => d.name);
  }
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

function parseJsonObject(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
