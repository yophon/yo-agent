import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ApprovalDecision,
  EventEnvelope,
  Id,
  PermissionMode,
  Usage,
} from '@yo-agent/protocol';
import type { CanonMessage, ChatRequest, ContentBlock, Provider, ToolSpec } from '@yo-agent/provider';
import type { ToolContext, ToolRegistry } from '@yo-agent/tools';
import type { EventStore } from '@yo-agent/store';
import type { ApprovalGate, Condenser, Kernel, LoopBreaker } from './index';

export interface AgentKernelDeps {
  store: EventStore;
  provider: Provider;
  tools: ToolRegistry;
  loopBreaker: LoopBreaker;
  condenser: Condenser;
  approvalGate?: ApprovalGate;
  model?: string;
  cwd?: string;
  maxStepsPerTurn?: number;
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
  private readonly pendingApprovals = new Map<
    Id,
    (decision: { decision: ApprovalDecision; updatedInput?: unknown }) => void
  >();

  constructor(deps: AgentKernelDeps) {
    this.events = deps.store;
    this.d = deps;
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
    return id;
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

  async submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<{ turnId: Id }> {
    const s = this.require(sessionId);
    s.interrupted = false;
    const turnId = randomUUID();
    await this.emit(s, { kind: 'TurnStarted', turnId, promptIdemKey: idemKey }, turnId);
    s.messages.push({ role: 'user', content: prompt });
    await this.runTurn(s, turnId);
    return { turnId };
  }

  async steer(sessionId: Id, text: string): Promise<void> {
    this.require(sessionId).messages.push({ role: 'user', content: text });
  }

  async interrupt(sessionId: Id): Promise<void> {
    this.require(sessionId).interrupted = true;
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
        const input = parseJsonObject(argsById.get(tc.id) ?? '');
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
          const decision = await this.requestApproval(s, tc.id, tc.name, input, turnId);
          if (decision === 'reject_once' || decision === 'reject_always') {
            toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: '用户拒绝了该工具调用', isError: true });
            continue;
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
          toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: `未知工具：${tc.name}`, isError: true });
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
        toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: out, isError: isError || undefined });
      }

      s.messages.push({ role: 'assistant', content: assistantBlocks });
      s.messages.push({ role: 'user', content: toolResults });
      // ContextManager.maybeCompact() —— Slice A 用 NoopCondenser，恒不压缩。
    }

    await this.emit(s, { kind: 'TurnCompleted', stopReason: 'max_turn_steps', usage: zeroUsage() }, turnId);
  }

  private async requestApproval(
    s: SessionState,
    requestIdForTool: string,
    tool: string,
    input: unknown,
    turnId: Id,
  ): Promise<ApprovalDecision> {
    const requestId = randomUUID();
    await this.emit(
      s,
      { kind: 'ApprovalRequested', requestId, tool, input, risk: 'unknown', suggestions: [] },
      turnId,
    );
    if (this.d.approvalGate) {
      const r = await this.d.approvalGate.request({ sessionId: s.id, tool, input, risk: 'unknown' });
      return r.decision;
    }
    // 协议化审批：无进程内 gate 时，等待外部 decideApproval(requestId,...)；headless 默认拒绝。
    void requestIdForTool;
    return 'reject_once';
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
    for (const h of s.subscribers) h(env);
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
