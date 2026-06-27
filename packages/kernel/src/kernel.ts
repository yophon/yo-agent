import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalSuggestion,
  EventEnvelope,
  HandoffSummary,
  Id,
  McpServerStatus,
  McpServerStatusInfo,
  PermissionMode,
  RiskLevel,
  Usage,
} from '@yo-agent/protocol';
import type { CanonMessage, ChatRequest, ContentBlock, Provider, ToolSpec } from '@yo-agent/provider';
import type { ToolContext, ToolExecutorRef, ToolRegistry } from '@yo-agent/tools';
import { sanitizeMcpServerName } from '@yo-agent/tools';
import type { EventStore, SessionRow } from '@yo-agent/store';
import { ResumeBuffer } from '@yo-agent/store';
import type { ApprovalGate, Checkpointer, Condenser, Kernel, LoopBreaker } from './index';
import { assessRisk } from './risk';
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
  /** 单次工具调用超时（ms），到时 abort signal（§3.4，挂死的远端 MCP 调用不阻塞整 turn）。0/缺省=不超时。 */
  toolTimeoutMs?: number;
  /** availability configFlag 谓词数据源（如 MCP 连接健康标志，3C 熔断 → 工具显隐）；每次 toolCtx 求值。 */
  toolFlags?: () => Iterable<string>;
  /** MCP 连接状态快照源（3C 可观测）：startSession + 每 turn 起点/tool 循环后 diff 后 emit McpServerStatus 落 EventLog。 */
  mcpStatusSource?: () => McpServerStatusInfo[];
  /** MCP 按需重连（3C 会话级懒加载）：每 turn 起点 await，使空闲 TTL 断连的工具在下一 turn 透明恢复。 */
  mcpEnsureConnected?: () => Promise<void>;
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
  /** 当前 turn 的取消控制器（interrupt → abort，取消 in-flight 工具调用）；turn 外为 undefined。 */
  turnAbort?: AbortController;
  /** 上次已落库的 MCP 连接状态 + 世代号（按 server），用于 diff 出连接/断连/熔断变化 + 重建（3C 可观测 + rug-pull 防护）。 */
  lastMcpStatus: Map<string, { status: McpServerStatus; epoch: number }>;
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
      lastMcpStatus: new Map(),
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
    await this.syncMcpStatus(s); // 已连接的 MCP server 状态落 EventLog（3C 可观测）
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
    // 与 EventLog 实际 head 对账：在飞 turn 崩溃残留的 cursor 已落库，headCursor 取较大值，
    // 否则恢复后新 emit 的 cursor 与历史区间重叠 → append 单调校验抛错、会话写不进（审查 high）。
    const logHead = await this.events.head(sessionId);
    const headCursor = Math.max(row.headCursor, logHead ?? row.headCursor);
    const s: SessionState = {
      id: sessionId,
      model: row.model,
      cwd: row.workspacePath,
      permissionMode: (row.permissionMode as PermissionMode) ?? 'supervised',
      messages: (row.messages as CanonMessage[]) ?? [],
      headCursor,
      interrupted: false,
      subscribers: new Set(),
      // 恢复点之后才是新压缩区间合法起点；置 0 会让下次 ContextCompacted.fromCursor 回退跨越历史边界（审查 low）。
      lastCompactCursor: headCursor,
      stepsSinceCompact: 0,
      approvalCache: new Map(),
      pendingApprovalIds: new Set(),
      lastMcpStatus: new Map(),
    };
    this.sessions.set(sessionId, s);
    return true;
  }

  /** 驱逐一次性会话（MCP run 等常驻进程防内存无界泄漏）。 */
  endSession(sessionId: Id): void {
    this.sessions.delete(sessionId);
  }

  /** 审批是否仍挂起（surface 重放历史 ApprovalRequested 时据此跳过已决审批的 approval/request 重投）。 */
  isApprovalPending(requestId: Id): boolean {
    return this.pendingApprovals.has(requestId);
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
      // 兜底 emit 自身也可能抛（cursor 冲突 / 落库失败）；务必吞掉，否则后台 turn（beginTurn 丢弃 done）
      // 会成为 unhandledRejection 击垮常驻进程、连带所有会话（审查 high）。
      try {
        await this.emit(s, { kind: 'TurnFailed', error: { message: e instanceof Error ? e.message : String(e) } }, turnId);
      } catch {
        /* 落库失败也不得崩进程 */
      }
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
    // 取消 in-flight 工具调用（响应 signal 者，如 MCP callTool）；不响应 signal 的内置工具在 step 间被拦。
    s.turnAbort?.abort(new Error('turn interrupted'));
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
    // turn 级取消控制器：interrupt() → abort 取消 in-flight 工具调用（响应 signal 的 MCP callTool 等）。
    s.turnAbort = new AbortController();
    try {
      await this.runTurnInner(s, turnId);
    } finally {
      s.turnAbort = undefined;
    }
  }

  private async runTurnInner(s: SessionState, turnId: Id): Promise<void> {
    // turn 起点：先按需重连空闲 TTL 断连的 MCP server（懒加载收口），使其工具在本 turn snapshot 前恢复；
    // 失败不阻断 turn（外部 server 不可信）。再 diff 连接状态变化（含重连/熔断/断连）落 EventLog（3C 可观测）。
    try {
      await this.d.mcpEnsureConnected?.();
    } catch {
      /* 重连异常不得阻断 turn */
    }
    await this.syncMcpStatus(s, turnId);
    const maxSteps = this.d.maxStepsPerTurn ?? 64;
    // turn 内工具集 snapshot（§15.4）：起点求值一次、整个 turn 固定——
    // MCP 工具中途增删（3C TTL/熔断）不漂移本 turn 的 prompt 工具前缀、不破 prompt cache。
    const toolset = this.d.tools.resolveAvailable(this.toolCtx(s));
    const toolSpecs: ToolSpec[] = toolset.map((d) => ({
      name: d.name,
      description: d.description,
      jsonSchema: d.inputSchema,
    }));
    // executor 与 desc 同源同时刻 snapshot（审查 SNAP-1/2）：mid-turn registry 增删（3C TTL/熔断）对本 turn 不可见——
    // snapshot 内工具即便被 unregister 仍可执行（execMap 持引用）；snapshot 外工具不在 execMap → 拒绝执行，不绕审批。
    const execMap = new Map<string, ToolExecutorRef>();
    for (const d of toolset) {
      const ex = this.d.tools.executor(d.name);
      if (ex) execMap.set(d.name, ex);
    }
    for (let step = 0; step < maxSteps; step++) {
      if (s.interrupted) {
        await this.emit(s, { kind: 'TurnCompleted', stopReason: 'interrupted', usage: zeroUsage() }, turnId);
        return;
      }

      const req: ChatRequest = { modelId: s.model, messages: s.messages, tools: toolSpecs };
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

      // 有工具调用：执行 0..N 个，结果合并为单条 user 消息回填（§15.1）。用 turn 内 snapshot（不重新求值，§15.4）。
      const available = toolset;
      const assistantBlocks: ContentBlock[] = [];
      if (text) assistantBlocks.push({ type: 'text', text });
      const toolResults: ContentBlock[] = [];

      for (const tc of toolCalls) {
        if (s.interrupted) break; // 中断：停止处理后续工具，不回填本轮 observation、不 compact（审查 CONC-2）
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
            const r = await this.requestApproval(s, tc.id, tc.name, input, assessRisk(desc, input), turnId);
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

        const exec = execMap.get(tc.name);
        if (!exec) {
          await this.emit(s, { kind: 'ToolCallCompleted', id: tc.id, status: 'error' }, turnId);
          toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: `工具不在本 turn 可见集：${tc.name}`, isError: true, name: tc.name });
          continue;
        }

        let out = '';
        let isError = false;
        const call = this.callSignal(s); // turn 取消 + per-call 超时组合 signal
        try {
          for await (const te of exec.execute(input, this.toolCtx(s, call.signal))) {
            if (te.kind === 'output') {
              out += te.chunk;
              await this.emit(s, { kind: 'ToolCallOutput', id: tc.id, chunk: te.chunk, exitCode: te.exitCode }, turnId);
            }
          }
        } catch (e) {
          isError = true;
          out = e instanceof Error ? e.message : String(e);
        } finally {
          call.dispose();
        }
        await this.emit(s, { kind: 'ToolCallCompleted', id: tc.id, status: isError ? 'error' : 'ok' }, turnId);
        toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: out, isError: isError || undefined, name: tc.name });

        // edit 类工具成功 → 发 FileChanged + L3 checkpoint 快照（§2.2 / §3.4）。
        if (!isError && desc && MUTATION_KINDS.has(desc.kind)) {
          await this.afterMutation(s, desc.kind, input, turnId);
        }
      }

      // 中断：不回填本轮 observation（含被中断工具的 error）、不 compact，直接收尾（审查 CONC-2，防污染 resume 上下文 + 多余压缩）。
      if (s.interrupted) {
        await this.emit(s, { kind: 'TurnCompleted', stopReason: 'interrupted', usage: usage ?? zeroUsage() }, turnId);
        return;
      }
      s.messages.push({ role: 'assistant', content: assistantBlocks });
      s.messages.push({ role: 'user', content: toolResults });
      // ContextManager.maybeCompact()：注入 observation 后按 token 阈值触发压缩（§2.1 / §5.1）。
      await this.maybeCompact(s, turnId);
      // 本步工具调用可能触发熔断（turn 中途）：补 diff 落库，否则若冷却在下一 turn 前自愈则失败态系统性漏记（审查 CRIT-1）。
      await this.syncMcpStatus(s, turnId);
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
    // min-rounds guard：刚 compact 完（stepsSinceCompact 已归 0）不立即再压。每次 compact 重写消息窗口前缀 →
    // 击穿 prompt cache（整窗 re-prefill 成本高，§15.4），故两次 compact 至少间隔 minSteps 步，摊薄失效成本。
    if (s.stepsSinceCompact < minSteps) return;
    const usableTokens = this.d.usableContextTokens ?? 200_000;
    const before = estimateMessagesTokens(s.messages);
    if (!this.d.condenser.shouldCompact({ usedTokens: before, usableTokens })) return;

    // 结构化交接（3D）：condense 实际压缩时经 onHandoff 回传四节交接 + 保真标识符集，落 ContextCompacted。
    let handoffSummary: HandoffSummary | undefined;
    let preservedIdentifiers: string[] | undefined;
    const condensed = await this.d.condenser.condense(s.messages, {
      onHandoff: (h, ids) => {
        handoffSummary = h;
        preservedIdentifiers = ids.length > 0 ? ids : undefined;
      },
    });
    if (condensed === s.messages || condensed.length >= s.messages.length) return; // 没压成，不发事件
    s.messages = condensed;
    const after = estimateMessagesTokens(condensed);
    const toCursor = s.headCursor; // ContextCompacted 自身分配的 cursor 在 toCursor 之后
    await this.emit(
      s,
      {
        kind: 'ContextCompacted',
        fromCursor: s.lastCompactCursor,
        toCursor,
        tokensSaved: Math.max(0, before - after),
        ...(handoffSummary ? { handoffSummary } : {}),
        ...(preservedIdentifiers ? { preservedIdentifiers } : {}),
      },
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
    toolCallId: string,
    tool: string,
    input: unknown,
    risk: RiskLevel,
    turnId: Id,
  ): Promise<{ decision: ApprovalDecision; updatedInput?: unknown }> {
    const requestId = randomUUID();
    const suggestions: ApprovalSuggestion[] = [
      { decision: 'allow_once', label: '允许一次' },
      { decision: 'allow_always', label: '总是允许' },
      { decision: 'reject_once', label: '拒绝一次' },
      { decision: 'reject_always', label: '总是拒绝' },
    ];
    // 协议化交互审批（§3.4 / §6.2）：**先登记 pending 再 emit**，使 surface 在 ApprovalRequested 推送时
    // 即可判定该审批仍挂起、触发 approval/request（否则 emit 早于登记 → isApprovalPending 误判为否）。
    if (this.d.interactiveApproval && !this.d.approvalGate) {
      s.pendingApprovalIds.add(requestId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const decided = new Promise<{ decision: ApprovalDecision; updatedInput?: unknown }>((resolve) => {
        this.pendingApprovals.set(requestId, ({ decision, updatedInput }) => resolve({ decision, updatedInput }));
        const ms = this.d.approvalTimeoutMs;
        if (ms && ms > 0) {
          timer = setTimeout(() => {
            if (this.pendingApprovals.delete(requestId)) resolve({ decision: 'reject_once' });
          }, ms);
        }
      });
      await this.emit(s, { kind: 'ApprovalRequested', requestId, toolCallId, tool, input, risk, suggestions }, turnId);
      try {
        return await decided;
      } finally {
        if (timer) clearTimeout(timer);
        this.pendingApprovals.delete(requestId);
        s.pendingApprovalIds.delete(requestId);
      }
    }
    // gate / 非交互：emit 后由 gate 决定 / headless 默认拒绝。
    await this.emit(s, { kind: 'ApprovalRequested', requestId, toolCallId, tool, input, risk, suggestions }, turnId);
    if (this.d.approvalGate) {
      return await this.d.approvalGate.request({ sessionId: s.id, tool, input, risk });
    }
    return { decision: 'reject_once' };
  }

  /**
   * diff MCP 连接状态快照 vs 上次落库值，对每个变化 emit McpServerStatus（3C 可观测，§3.3）。
   * 在 startSession（turnId 缺省）、每 turn 起点、每步 tool 循环后调用——连接/断连/熔断/重建作为离散状态变更进 EventLog + resume 白名单。
   * 世代号（epoch）变化 → 同名工具身份可能已变（list_changed rug-pull）→ 失效该 server 会话审批缓存（SEC-8）。
   * 状态源（host.statusSnapshot）异常不得阻断主流程：吞错返回。
   */
  private async syncMcpStatus(s: SessionState, turnId?: Id): Promise<void> {
    if (!this.d.mcpStatusSource) return;
    let snap: McpServerStatusInfo[];
    try {
      snap = this.d.mcpStatusSource();
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const info of snap) {
      seen.add(info.server);
      const epoch = info.epoch ?? 0;
      const prev = s.lastMcpStatus.get(info.server);
      if (!prev || prev.status !== info.status || prev.epoch !== epoch) {
        // 世代号变化（连接/重连/list_changed 重建）→ 同名工具身份可能已变（rug-pull）：
        // 失效该 server 的会话审批缓存，强制变更后的同名工具重新走 ApprovalGate（审查 SEC-8）。
        if (!prev || prev.epoch !== epoch) this.invalidateMcpApprovals(s, info.server);
        s.lastMcpStatus.set(info.server, { status: info.status, epoch });
        await this.emit(
          s,
          { kind: 'McpServerStatus', server: info.server, status: info.status, toolCount: info.toolCount },
          turnId,
        );
      }
    }
    // 快照中消失的 server（已断连）→ 补发 disconnected（仅当上次非 disconnected，防重复）。
    for (const [server, prev] of s.lastMcpStatus) {
      if (!seen.has(server) && prev.status !== 'disconnected') {
        this.invalidateMcpApprovals(s, server); // 断连后再连可能换实现 → 同样失效审批缓存
        s.lastMcpStatus.set(server, { status: 'disconnected', epoch: prev.epoch });
        await this.emit(s, { kind: 'McpServerStatus', server, status: 'disconnected' }, turnId);
      }
    }
  }

  /** 失效某 MCP server 全部工具的会话审批缓存（前缀 mcp__{sanitize(server)}__）：rug-pull / 重连后强制重新审批。 */
  private invalidateMcpApprovals(s: SessionState, server: string): void {
    const prefix = `mcp__${sanitizeMcpServerName(server)}__`;
    for (const tool of [...s.approvalCache.keys()]) {
      if (tool.startsWith(prefix)) s.approvalCache.delete(tool);
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

  private toolCtx(s: SessionState, signal?: AbortSignal): ToolContext {
    // 注：flags 每次现取 toolFlags()，execute 时与 turn 起点 snapshot 时可能不同源（审查 SNAP-4）——
    // 当前 flags 仅参与 resolveAvailable 的工具显隐（turn 内只在起点求值），execute 时仅透传给 executor，不破 prompt 前缀。
    const flags = this.d.toolFlags ? new Set(this.d.toolFlags()) : undefined;
    return { sessionId: s.id, cwd: s.cwd, signal: signal ?? s.turnAbort?.signal, flags };
  }

  /** 组合 turn 取消 signal 与 per-call 超时；dispose 清 timer + 解监听防泄漏（不依赖 AbortSignal.any，兼容 Node 20.0）。 */
  private callSignal(s: SessionState): { signal: AbortSignal | undefined; dispose: () => void } {
    const turnSignal = s.turnAbort?.signal;
    const ms = this.d.toolTimeoutMs;
    if (!ms || ms <= 0) return { signal: turnSignal, dispose: () => {} };
    const ctrl = new AbortController();
    // 超时 abort 用 name='TimeoutError' 的可识别 reason：MCP executor 据此把「kernel 超时」与「用户中断」区分，
    // 前者计入熔断、后者中性（审查 ATTR-3：双层超时叠加时挂死 server 不得被误判为中断）。
    const timer = setTimeout(() => ctrl.abort(makeTimeoutReason(`工具调用超时（${ms}ms）`)), ms);
    const onTurnAbort = () => ctrl.abort(turnSignal?.reason);
    if (turnSignal) {
      if (turnSignal.aborted) ctrl.abort(turnSignal.reason);
      else turnSignal.addEventListener('abort', onTurnAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      dispose: () => {
        clearTimeout(timer);
        turnSignal?.removeEventListener('abort', onTurnAbort);
      },
    };
  }

  private toolNames(s: SessionState): string[] {
    return this.d.tools.resolveAvailable(this.toolCtx(s)).map((d) => d.name);
  }
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

/** 可识别的超时 abort reason（name='TimeoutError'）：下游据 name 区分「超时」与「用户中断」（审查 ATTR-3）。 */
function makeTimeoutReason(message: string): Error {
  const e = new Error(message);
  e.name = 'TimeoutError';
  return e;
}

function parseJsonObject(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
