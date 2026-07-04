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
  StopReason,
  Usage,
} from '@yo-agent/protocol';
import type { CanonMessage, ChatRequest, ContentBlock, ErrorCategory, Provider, ToolSpec } from '@yo-agent/provider';
import { decideFallback } from './fallback';
import type { ProviderRoute } from './fallback';
import type { ToolContext, ToolDescriptor, ToolExecutorRef, ToolRegistry } from '@yo-agent/tools/core';
import { MAX_PARALLEL_CALLS, PARALLEL_TOOL, sanitizeMcpServerName } from '@yo-agent/tools/core';
import type { EventStore, SessionRow } from '@yo-agent/store/core';
import { ResumeBuffer } from '@yo-agent/store/core';
import type { ApprovalGate, ApprovalOutcome, Checkpointer, Condenser, Kernel, LoopBreaker } from './index';
import { assessRisk } from './risk';
import { DefaultPolicyEngine } from './policy';
import type { PolicyEngine } from './policy';
import { HookBus } from './hooks';
import type { HookContext, HookErrorSink, Hooks } from './hooks';
import type { SubagentHost } from './subagent';
import type { SessionSelfInfo } from './self-knowledge';
import { estimateMessagesTokens } from './tokens';

/** 环境无关 UUID（Node ≥20 / 浏览器全局 crypto 均可用）——core 路径不 import node:*（5A）。 */
const randomUUID = (): string => globalThis.crypto.randomUUID();

const MUTATION_KINDS = new Set(['edit', 'delete', 'move']);
/** 4.10b 批内并发资格：无副作用的工具类别,同批连续出现时并发执行。 */
const CONCURRENT_KINDS = new Set(['read', 'search', 'fetch', 'think']);
/** 4.10b 默认可并发工具名单：spawn 天然并行(真机反馈 feedback/4.9 并行探索意图),kind='other' 靠名单放行。 */
const DEFAULT_CONCURRENT_TOOLS: readonly string[] = ['subagent_spawn'];

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
  /** 权限闸门（4A / ADR-16）：assessRisk 后、requestApproval 前按 permissionMode 决策 allow/ask/deny。缺省 DefaultPolicyEngine。 */
  policyEngine?: PolicyEngine;
  /** 生命周期 Hook 总线（4A / §11）：app 也可经 kernel.registerHook 注册。缺省空总线（无 hook）。 */
  hookBus?: HookBus;
  /**
   * 追加进每个新会话 system 消息的后缀（4D 技能摘要 / 4.9a 自知注入，跨 surface 统一）。
   * 函数形态在 startSession 时求值并喂入会话事实（model/cwd/permissionMode）——
   * 使 env 块反映会话真实起点、MCP 摘要反映 bootstrap 后实况（构造期字符串做不到）。
   */
  systemSuffix?: string | ((info: SessionSelfInfo) => string);
  /** 成本估算（4F）：emit UsageUpdate/TurnCompleted 前填 costUsd（含 cache 读写分价）。缺省不填。 */
  costEstimator?: (model: string, usage: Usage) => number | undefined;
  /**
   * Provider fallback 链 / auth rotation（4F / DESIGN §4.4）：主路由（provider+model）的备选链。
   * 主路由 = {provider, model}（本 deps 的 provider + model）；本字段是其后的备选（换 key / 换 provider）。
   * 缺省空——行为同既有（provider 错误 → TurnFailed，无 fallback）。
   */
  fallbacks?: ProviderRoute[];
  /** 会话驱逐回收钩子（审查 gap#2）：endSession 时调用，app 接 SubagentManager.abortInflight(sessionId) 回收背景子 agent。 */
  sessionReaper?: (sessionId: Id) => void;
  /** 会话行的 agent 归属标识（5.1b）：多 agent 共享一个 store 时供列表区分归属。缺省 'default'（行为不变）。 */
  agentProfile?: string;
  /**
   * 批内并发工具名单（4.10b）：CONCURRENT_KINDS 之外额外允许并发执行的工具名
   * （kind='other' 但无本地副作用者，如 subagent_spawn）。缺省 ['subagent_spawn']。
   */
  concurrentTools?: readonly string[];
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
  /**
   * 每会话 emit 串行链（4C）：把所有 emit 排成单链，使**后台子 agent 完成回调**对父会话的 emit
   * 与正在跑的 turn 自身 emit 不交错——否则两路并发 emit 抢 headCursor → append 单调校验抛错（审查 high）。
   */
  emitChain: Promise<void>;
  /** 异步 steering 队列（4C）：后台子 agent 结果待在 parent 下一 step 注入消息窗口（§2.5），不在回调中直改 messages。 */
  pendingSteering: string[];
  /** 当前在跑 turn 的 id（4C）：供后台子 agent 的离带 emit（SubagentResult）打 turn 标签；turn 外为 undefined。 */
  currentTurnId?: Id;
  /** 当前 provider 路由下标（4F fallback 链）：0=主路由；fallback switch 后递增并**粘滞**（跨 turn 不回探死掉的主路由）。 */
  routeIdx: number;
  /**
   * 动态状态提醒队列（4.9d）：toolset 漂移/MCP 状态变化/权限切档/上下文满度的一句话提醒，
   * 入队去重、step 顶并入消息窗口——工具不再无声蒸发、切档对 LLM 可见（替代 system 行过期问题）。
   */
  pendingStatusNotes: string[];
  /** 上一 turn 的可见工具名单（toolset diff 基准）；首 turn 无基准不注入。 */
  lastToolsetNames?: string[];
  /** 上下文满度已提醒标志（降回阈下自动重置，再次跨阈重报，不逐 step 刷屏）。 */
  ctxHighNoted: boolean;
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
export class AgentKernel implements Kernel, SubagentHost {
  readonly events: EventStore;
  private readonly d: AgentKernelDeps;
  private readonly sessions = new Map<Id, SessionState>();
  /** 内存 ring：服务实时重连缺口（§6.3 / §10.1）；跨进程（新内核）为空 → 走 EventLog gap 溢出降级。 */
  private readonly resumeBuffer: ResumeBuffer;
  private readonly pendingApprovals = new Map<Id, (outcome: ApprovalOutcome) => void>();
  /** 权限闸门（4A）：缺省 DefaultPolicyEngine —— supervised 档对非 never 工具恒 'ask'，等价既有行为。 */
  private readonly policy: PolicyEngine;
  /** 生命周期 Hook 总线（4A）：缺省空 → 无 hook 注册时全部触发为 no-op，运行时行为不变。 */
  private readonly hooks: HookBus;

  constructor(deps: AgentKernelDeps) {
    this.events = deps.store;
    this.d = deps;
    this.resumeBuffer = new ResumeBuffer(deps.resumeBufferCapacity ?? 512);
    this.policy = deps.policyEngine ?? new DefaultPolicyEngine();
    this.hooks = deps.hookBus ?? new HookBus();
  }

  /** 注册生命周期 hook（4A / §11）；返回反注册函数。app/插件经此挂 PreToolUse 等。 */
  registerHook(h: Hooks): () => void {
    return this.hooks.register(h);
  }

  async startSession(opts: StartSessionOpts = {}): Promise<Id> {
    const id = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.d.model ?? 'fake-model';
    const cwd = opts.cwd ?? this.d.cwd ?? globalThis.process?.cwd() ?? '/';
    const permissionMode = opts.permissionMode ?? 'supervised';
    // system = 传入 system + 后缀（4D 技能摘要 / 4.9a 自知注入）；二者任一存在即落 system 消息。
    // 函数形态此刻求值（会话真实起点事实；suffix 求值抛错不阻断开会话——自知是增强，非关键路径）。
    let suffix: string | undefined;
    try {
      suffix = typeof this.d.systemSuffix === 'function' ? this.d.systemSuffix({ model, cwd, permissionMode }) : this.d.systemSuffix;
    } catch {
      suffix = undefined;
    }
    const systemText = [opts.system, suffix].filter((x): x is string => !!x).join('\n\n');
    const s: SessionState = {
      id,
      model,
      cwd,
      permissionMode,
      messages: systemText ? [{ role: 'system', content: systemText }] : [],
      headCursor: -1,
      interrupted: false,
      subscribers: new Set(),
      lastCompactCursor: 0,
      stepsSinceCompact: 0,
      approvalCache: new Map(),
      pendingApprovalIds: new Set(),
      lastMcpStatus: new Map(),
      emitChain: Promise.resolve(),
      pendingSteering: [],
      routeIdx: 0,
      pendingStatusNotes: [],
      ctxHighNoted: false,
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
    await this.hooks.fireSessionStart(this.hookCtx(s), this.hookErr(s)); // SessionStart hook（4A）
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
      emitChain: Promise.resolve(),
      pendingSteering: [],
      routeIdx: 0,
      pendingStatusNotes: [],
      ctxHighNoted: false,
    };
    this.sessions.set(sessionId, s);
    return true;
  }

  /** 驱逐一次性会话（MCP run 等常驻进程防内存无界泄漏）。 */
  endSession(sessionId: Id): void {
    const s = this.sessions.get(sessionId);
    // 审查 gap#3：mid-turn 驱逐须 abort 在跑 turn，否则 turn 循环持已移除的 SessionState 引用继续 append/mutate（孤儿 turn）。
    s?.turnAbort?.abort(new Error('session ended'));
    this.sessions.delete(sessionId);
    // 审查 gap#2：通知外部回收该会话派生的背景子 agent（abortInflight 死代码的下游危害——背景子 agent 不随会话回收）。
    this.d.sessionReaper?.(sessionId);
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
    // 用户输入落事件流（5.1b）：回放可重建用户气泡（此前只进 messages 快照）。
    await this.emit(s, { kind: 'UserMessage', text: prompt, source: 'prompt' }, turnId);
    s.messages.push({ role: 'user', content: prompt });
    await this.hooks.fireUserPromptSubmit(this.hookCtx(s), prompt, this.hookErr(s, turnId)); // UserPromptSubmit hook（4A）
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

  // ───────────────────────── 4.6e TUI 接缝（K1-K5）─────────────────────────

  /** K1：切换会话模型，下一轮生效（主路由随 s.model；fallback 链不变）。 */
  setModel(sessionId: Id, model: string): void {
    this.require(sessionId).model = model;
  }

  /**
   * K2：切换权限模式（交互式本人操作，允许任意档；子 agent 派生仍走 deriveSubagentPolicy 只收紧）。
   * 收紧时清空会话级 allow_always 缓存 —— 宽松档下的「总是允许」不得跨档存活。
   */
  setPermissionMode(sessionId: Id, mode: PermissionMode): void {
    const s = this.require(sessionId);
    const order: PermissionMode[] = ['read-only', 'supervised', 'accept-edits', 'autonomous', 'ci', 'bypass'];
    if (order.indexOf(mode) < order.indexOf(s.permissionMode)) s.approvalCache.clear();
    // 4.9d：切档对 LLM 可见（下一 step 注入），替代 system 行起点值过期问题。
    if (mode !== s.permissionMode) {
      this.pushStatusNote(s, `[系统状态] 权限模式已切换：${s.permissionMode} → ${mode}（system 提示中的起点值已过期，以本行为准）`);
    }
    s.permissionMode = mode;
  }

  /** K3：手动压缩（/compact，跳过阈值与 min-rounds 闸门）；返回是否压成。 */
  async compactNow(sessionId: Id): Promise<boolean> {
    return this.doCondense(this.require(sessionId));
  }

  /** K4：上下文占用估算（状态栏 ctx%）。 */
  contextState(sessionId: Id): { usedTokens: number; usableTokens: number } {
    const s = this.require(sessionId);
    return {
      usedTokens: estimateMessagesTokens(s.messages),
      usableTokens: this.d.usableContextTokens ?? 200_000,
    };
  }

  /** K5：持久会话列表（/resume 选择器），委派 store。 */
  listPersistedSessions(): Promise<SessionRow[]> {
    return this.events.listSessions();
  }

  async steer(sessionId: Id, text: string): Promise<void> {
    // 审查 cross-seam-MED：经统一 appendUserText 并入（末条为 user 则合并，否则新增）——直接 push 会在「末条已是 user
    // （注入 tool_result 那条 / 连续 steer）」时产生连续两条 user，破坏 provider 严格交替契约（400）。
    const s = this.require(sessionId);
    this.appendUserText(s, text);
    // 插话同样落事件流（5.1b），回放可见；打当前 turn 标签（turn 外 steer 罕见，落 null）。
    await this.emit(s, { kind: 'UserMessage', text, source: 'steer' }, s.currentTurnId);
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
    s.currentTurnId = turnId; // 后台子 agent 离带 emit 打 turn 标签用
    try {
      await this.runTurnInner(s, turnId);
    } finally {
      s.turnAbort = undefined;
      s.currentTurnId = undefined;
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
    // 4.9d toolset diff：相对上 turn 消失/新增的工具注入一句解释（MCP 熔断、插件崩溃、信任变化统一收口）。
    // diff 基准随 turn 滚动 → 同一变化只报一次（自去重）；首 turn 无基准不注入。
    this.noteToolsetDiff(s, toolset.map((d) => d.name));
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
    // 4F fallback：本 turn 是否已 commit 成功模型（已产出）。一旦 commit，后续 step 不得换模型（防跨模型漂移）。
    const chain = this.routeChain(s);
    // 审查 4F-MED：每 turn 起点回探主路由（routeIdx 归 0）——否则一次瞬时 rate_limit/network 会让会话永久弃用主路由
    //（即便主路由早已恢复）。turn 内 switch 仍递增（防本 turn 内反复打死路由）；持久错误（auth/billing）的跨 turn
    // 粘滞优化（避免每 turn 白试一次死主路由）留作后续（见 docs/PHASE-4.md 已知限制）。
    s.routeIdx = 0;
    let turnCommitted = false;
    for (let step = 0; step < maxSteps; step++) {
      if (s.interrupted) {
        await this.completeTurn(s, 'interrupted', zeroUsage(), turnId);
        return;
      }
      // 异步 steering 注入（4C）：把已完成的后台子 agent 结果并入下一次推理的消息窗口（§2.5），不阻塞主 turn。
      this.drainSteering(s);
      // 4.9d 状态提醒注入接缝：上下文满度评估 + 抽干状态队列（toolset diff/MCP 变化/切档），并入下一次推理窗口。
      this.noteContextFullness(s);
      this.drainStatusNotes(s);

      let text = '';
      let toolCalls: ToolCallAccum[] = [];
      let argsById = new Map<string, string>();
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' = 'end_turn';
      let usage: Usage | undefined;

      // 4F：provider 调用 + fallback/auth rotation。错误经 category 决策——context_overflow→压缩重试（同模型）、
      // rate_limit/network/billing/auth→换路由（仅未 commit & 有下家）、其余→失败。已产出（流式发过内容）的错误
      // 不重试（避免重复 emit / 跨模型漂移）。attempt 上界 = 链长 + 几次压缩，防病态循环。
      let provErr: { message: string; category?: ErrorCategory } | undefined;
      const maxAttempts = chain.length + 3;
      let attempt = 0;
      while (true) {
        if (++attempt > maxAttempts) {
          provErr = provErr ?? { message: 'fallback 尝试超上限' };
          break;
        }
        const route = chain[Math.min(s.routeIdx, chain.length - 1)]!;
        text = '';
        toolCalls = [];
        argsById = new Map<string, string>();
        stopReason = 'end_turn';
        usage = undefined;
        provErr = undefined;
        let produced = false; // 本次尝试是否已流式发出内容（text/thinking/tool）——已发则不可干净重试
        const req: ChatRequest = { modelId: route.model, messages: s.messages, tools: toolSpecs };

        for await (const ev of route.provider.streamChat(req)) {
          switch (ev.kind) {
            case 'TextDelta':
              text += ev.text;
              produced = true;
              await this.emit(s, { kind: 'AssistantText', delta: ev.text }, turnId);
              break;
            case 'ThinkingDelta':
              produced = true;
              await this.emit(s, { kind: 'Reasoning', delta: ev.text }, turnId);
              break;
            case 'ToolCallStart':
              produced = true;
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
              await this.emit(s, { kind: 'UsageUpdate', ...this.withCost(route.model, ev.usage) }, turnId);
              break;
            case 'Stop':
              stopReason = ev.reason;
              break;
            case 'Error':
              provErr = { message: ev.error.message, category: ev.error.category };
              break;
          }
          if (provErr) break; // 收到错误即停止消费本流
        }

        if (!provErr) {
          turnCommitted = true; // 成功产出 → commit 本 turn 的模型，后续 step 不再换
          break;
        }
        if (produced) break; // 已流式发出内容的错误 → 不重试（无法干净回退）
        const action = decideFallback(provErr.category, {
          hasNext: s.routeIdx < chain.length - 1,
          committed: turnCommitted,
        });
        if (action === 'compact') {
          const compacted = await this.forceCompact(s, turnId); // 同模型压缩窗口后重试
          if (!compacted) break; // 压不动 → 放弃
          continue;
        }
        if (action === 'switch') {
          s.routeIdx++; // 换 key / 换 provider（粘滞，跨 turn 不回探）
          continue;
        }
        break; // fail
      }

      if (provErr) {
        await this.emit(s, { kind: 'Error', message: provErr.message }, turnId);
        await this.emit(
          s,
          { kind: 'TurnFailed', error: { message: provErr.message, ...(provErr.category ? { category: provErr.category } : {}) } },
          turnId,
        );
        return;
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
        await this.completeTurn(s, 'end_turn', usage ?? zeroUsage(), turnId);
        return;
      }

      // 有工具调用：执行 0..N 个，结果合并为单条 user 消息回填（§15.1）。用 turn 内 snapshot（不重新求值，§15.4）。
      // 4.10b 两段式：阶段 1 按批次顺序串行做准入判定（熔断/PreToolUse hook/权限闸门/审批——审批本就逐个弹面板，
      // 语义不变）；阶段 2 按「波次」执行——连续的可并发调用（CONCURRENT_KINDS 无副作用类 + concurrentTools 名单，
      // 如 subagent_spawn）并发跑，其余单独成波作屏障（保持与写类工具的相对执行顺序）。
      // 不变量：EventLog 单写者（emit 经 s.emitChain 串行落盘）；tool_result 按原批次位置回填；
      // interrupt 经 turnAbort signal 取消在飞的并发调用。
      const available = toolset;
      const assistantBlocks: ContentBlock[] = [];
      if (text) assistantBlocks.push({ type: 'text', text });
      /** 每个 tool_use 的最终 tool_result，按批次位置存放（阶段 1 拒绝 / 阶段 2 执行都落这里）。 */
      const results: (ContentBlock | undefined)[] = new Array(toolCalls.length);
      /** parallel 展开组（feedback/4.10）：外层 tool_use 一个组，子调用结果按 part 序收敛后合并回填单条 tool_result。 */
      const groups = new Map<number, { parts: ({ name: string; content: string; isError: boolean } | undefined)[] }>();
      /** 阶段 1 准入通过、待执行的调用（key=事件用 id；parallel 子调用为 `外层id#序号`）。 */
      const plans: Array<{
        key: string;
        name: string;
        input: unknown;
        desc: ToolDescriptor | undefined;
        sink: { outerIdx: number; part?: number };
      }> = [];

      /**
       * 单调用准入（4.10b 阶段 1 提炼为闭包，parallel 子调用复用同一条链——熔断/hook/闸门/审批不可绕）。
       * patchInput 把 hook 改写 / 审批 modify 后的入参同步回 provider 可见的 tool_use 块
       * （外层调用改块本体；parallel 子调用改外层 input.calls[i].input，二者共享引用）。
       */
      type Admit =
        | { verdict: 'ok'; input: unknown; desc: ToolDescriptor | undefined }
        | { verdict: 'reject'; content: string }
        | { verdict: 'loop' };
      const admitOne = async (id: string, name: string, input0: unknown, patchInput: (v: unknown) => void): Promise<Admit> => {
        let input = input0;
        const desc = available.find((d) => d.name === name);

        // 熔断（引擎层强制）。batchId=本 step：同批多 tool_use 是并行语义，批内同参不互相计重（4.10a）。
        const verdict = this.d.loopBreaker.check({ name, input, kind: desc?.kind, batchId: `${turnId}:${step}` });
        if (verdict === 'break') return { verdict: 'loop' };
        if (verdict === 'warn') {
          // 4.10a warn 现役化（DESIGN §2.3「注入提醒」）：经 4.9d 状态提醒接缝给 LLM 自纠机会，不中止执行。
          // 文案不含次数 → pushStatusNote 同文去重，批内多次 warn 只提醒一次。
          this.pushStatusNote(
            s,
            `[系统状态] 检测到你在反复以相同参数调用工具 ${name}。若非刻意重试，请调整参数或换用其他方式；继续同参重复将触发死循环熔断中止本轮`,
          );
        }

        // PreToolUse hook（4A / §11）：确定性强制——拦截 / 改写 input / 放行三态，先于权限闸门与审批。
        // fail-closed：hook 抛错视为 deny（reason 可见）。无 hook 注册 → 恒 allow + input 不变（行为不变）。
        if (desc) {
          const pre = await this.hooks.firePreToolUse(this.hookCtx(s), { tool: name, kind: desc.kind, input });
          if (pre.decision === 'deny') {
            return { verdict: 'reject', content: `策略 hook 拒绝该工具调用${pre.reason ? `：${pre.reason}` : ''}` };
          }
          if (pre.input !== input) {
            input = pre.input;
            patchInput(input);
          }
        }

        // 权限闸门（4A / ADR-16）+ 审批（never 放行；ask 且非 never 走 ApprovalGate）。
        // 不变量：supervised 档对非 never 工具 → gate='ask' → 等价既有审批行为。
        if (desc) {
          const risk = assessRisk(desc, input);
          const gate = this.policy.decide({
            permissionMode: s.permissionMode,
            kind: desc.kind,
            risk,
            approval: desc.approval,
            toolName: name,
          });
          if (gate === 'deny') {
            // 4.9c 文案富化：带当前档位 + 引导，LLM 不再自由脑补拒因。
            return {
              verdict: 'reject',
              content: `权限模式（${s.permissionMode}）拒绝该工具调用。该工具在当前档位不可用；用户可用 /mode 切换更宽档位后重试，或改用当前档位允许的工具。`,
            };
          }
          if (gate === 'ask' && desc.approval !== 'never') {
            // allow_always/reject_always 落 session 级缓存，同名工具后续不再重复弹审批（§9.2 会话内升级）。
            const cached = s.approvalCache.get(name);
            let decision: ApprovalDecision;
            let updatedInput: unknown;
            let autoReason: ApprovalOutcome['autoReason'];
            if (cached) {
              decision = cached === 'allow' ? 'allow_always' : 'reject_always';
            } else {
              const r = await this.requestApproval(s, id, name, input, risk, turnId);
              decision = r.decision;
              updatedInput = r.updatedInput;
              autoReason = r.autoReason;
              if (decision === 'allow_always') s.approvalCache.set(name, 'allow');
              else if (decision === 'reject_always') s.approvalCache.set(name, 'reject');
            }
            await this.hooks.fireApproval(this.hookCtx(s), { tool: name, risk, decision }, this.hookErr(s, turnId)); // OnApproval hook（4A）
            if (decision === 'reject_once' || decision === 'reject_always') {
              // 4.9c 审批语义修正：超时/非交互自动拒与用户真拒文案分流——不再谎称「用户拒绝了」（kernel.ts:817 病根）。
              const content =
                autoReason === 'timeout'
                  ? `审批超时（${Math.round((this.d.approvalTimeoutMs ?? 0) / 1000)} 秒无人响应）自动拒绝该工具调用——这不是用户的明确拒绝。可先做无需审批的部分，稍后再试或等用户回应。`
                  : autoReason === 'noninteractive'
                    ? `非交互环境自动拒绝该工具调用（无人可批；当前权限模式：${s.permissionMode}）。请改用无需审批的工具完成任务，并在结果中说明该步骤被跳过。`
                    : `用户拒绝了该工具调用（当前权限模式：${s.permissionMode}）。未经用户要求不要原样重试；用户可用 /mode 切换档位或重新发起。`;
              if (autoReason === 'timeout') {
                await this.emit(s, { kind: 'Error', message: `审批超时，已自动拒绝工具 ${name}` }, turnId); // surface 同步提示
              }
              return { verdict: 'reject', content };
            }
            // modify：用户改参数后放行 → 用 updatedInput 覆盖（同步回传给 LLM 的 tool_use.input）。
            if (updatedInput !== undefined) {
              input = updatedInput;
              patchInput(input);
            }
          }
        }
        return { verdict: 'ok', input, desc };
      };

      let loopToolName: string | null = null;
      for (let tcIdx = 0; tcIdx < toolCalls.length && loopToolName === null; tcIdx++) {
        const tc = toolCalls[tcIdx]!;
        if (s.interrupted) break; // 中断：停止处理后续工具，不回填本轮 observation、不 compact（审查 CONC-2）
        const input = parseJsonObject(argsById.get(tc.id) ?? '');
        const block: ContentBlock = { type: 'tool_use', id: tc.id, name: tc.name, input };
        assistantBlocks.push(block);

        // parallel 批量调用展开（feedback/4.10「一劳永逸」）：模型端每响应只发 1 个 tool_call 的上游限制下，
        // 一个 parallel 调用装下一批子调用——每个子调用逐一走 admitOne 完整准入链（不可绕），再进波次并发执行。
        // 仅当 parallel 在本 turn 可见集时展开（profile 收窄可整体禁用）；包装器自身不做准入（纯控制流，
        // approval:'never'，安全语义全部落在子调用上）。包装器不发自身事件，事件面只有子调用（key=外层id#序号）。
        if (tc.name === PARALLEL_TOOL && available.some((d) => d.name === PARALLEL_TOOL)) {
          const rawCalls = (input as { calls?: unknown } | null)?.calls;
          const calls = Array.isArray(rawCalls) ? rawCalls : null;
          if (!calls || calls.length === 0) {
            results[tcIdx] = { type: 'tool_result', toolUseId: tc.id, content: 'parallel：calls 必须是非空数组，每项 {tool, input}', isError: true, name: tc.name };
            continue;
          }
          if (calls.length > MAX_PARALLEL_CALLS) {
            results[tcIdx] = { type: 'tool_result', toolUseId: tc.id, content: `parallel：calls 至多 ${MAX_PARALLEL_CALLS} 个（收到 ${calls.length}）；请分批调用`, isError: true, name: tc.name };
            continue;
          }
          const parts: ({ name: string; content: string; isError: boolean } | undefined)[] = new Array(calls.length);
          groups.set(tcIdx, { parts });
          for (let i = 0; i < calls.length && loopToolName === null; i++) {
            if (s.interrupted) break;
            const c = (calls[i] ?? {}) as { tool?: unknown; input?: unknown };
            const cname = typeof c.tool === 'string' ? c.tool : '';
            if (!cname) {
              parts[i] = { name: '?', content: '子调用缺少 tool 字段（每项须为 {tool, input}）', isError: true };
              continue;
            }
            if (cname === PARALLEL_TOOL) {
              parts[i] = { name: cname, content: 'parallel 不可嵌套', isError: true };
              continue;
            }
            const key = `${tc.id}#${i + 1}`;
            const a = await admitOne(key, cname, c.input ?? {}, (v) => {
              c.input = v;
            });
            if (a.verdict === 'loop') {
              loopToolName = cname;
              break;
            }
            if (a.verdict === 'reject') {
              parts[i] = { name: cname, content: a.content, isError: true };
              continue;
            }
            plans.push({ key, name: cname, input: a.input, desc: a.desc, sink: { outerIdx: tcIdx, part: i } });
          }
          continue;
        }

        const a = await admitOne(tc.id, tc.name, input, (v) => {
          block.input = v;
        });
        if (a.verdict === 'loop') {
          loopToolName = tc.name;
          break;
        }
        if (a.verdict === 'reject') {
          results[tcIdx] = { type: 'tool_result', toolUseId: tc.id, content: a.content, isError: true, name: tc.name };
          continue;
        }
        plans.push({ key: tc.id, name: tc.name, input: a.input, desc: a.desc, sink: { outerIdx: tcIdx } });
      }
      if (loopToolName !== null) {
        await this.emit(s, { kind: 'Error', message: `检测到死循环：反复调用 ${loopToolName}` }, turnId);
        await this.completeTurn(s, 'loop_detected', usage ?? zeroUsage(), turnId);
        return;
      }

      // 阶段 2 执行体：每个调用独立收敛事件对（Started→Output*→Completed）与结果位。
      // 执行错误落 isError 结果不外抛（Promise.all 不会因单个工具失败 reject）；emit 抛错（store 故障）仍向外传播，与旧行为一致。
      // deliver：独立调用直接落 results；parallel 子调用落组 parts，波后统一合并回填。
      const deliver = (p: (typeof plans)[number], content: string, isError: boolean): void => {
        if (p.sink.part === undefined) {
          results[p.sink.outerIdx] = {
            type: 'tool_result',
            toolUseId: toolCalls[p.sink.outerIdx]!.id,
            content,
            isError: isError || undefined,
            name: p.name,
          };
        } else {
          const g = groups.get(p.sink.outerIdx);
          if (g) g.parts[p.sink.part] = { name: p.name, content, isError };
        }
      };
      const runOne = async (p: (typeof plans)[number]): Promise<void> => {
        await this.emit(
          s,
          { kind: 'ToolCallStarted', id: p.key, name: p.name, toolKind: p.desc?.kind ?? 'other', summary: p.name, input: p.input },
          turnId,
        );
        const exec = execMap.get(p.name);
        if (!exec) {
          await this.emit(s, { kind: 'ToolCallCompleted', id: p.key, status: 'error' }, turnId);
          deliver(p, `工具不在本 turn 可见集：${p.name}`, true);
          return;
        }

        if (s.interrupted) {
          // 并发波内的中断可能落在任务入列后、执行前（signal 已 abort，对「先注册 abort 监听再跑」的 executor 永不触发）——
          // 不再起新执行，直接以中断态收敛事件对。结果在 interrupted 收尾路径本就被丢弃。
          await this.emit(s, { kind: 'ToolCallCompleted', id: p.key, status: 'error' }, turnId);
          deliver(p, '已中断', true);
          return;
        }

        let out = '';
        let isError = false;
        const call = this.callSignal(s); // turn 取消 + per-call 超时组合 signal
        try {
          for await (const te of exec.execute(p.input, this.toolCtx(s, call.signal))) {
            if (te.kind === 'output') {
              out += te.chunk;
              await this.emit(s, { kind: 'ToolCallOutput', id: p.key, chunk: te.chunk, exitCode: te.exitCode }, turnId);
            }
          }
        } catch (e) {
          isError = true;
          out = e instanceof Error ? e.message : String(e);
        } finally {
          call.dispose();
        }
        await this.emit(s, { kind: 'ToolCallCompleted', id: p.key, status: isError ? 'error' : 'ok' }, turnId);
        deliver(p, out, isError);

        // PostToolUse hook（4A / §11）：观测输出（注入防护 / 审计）；抛错经 onError 上报不拖垮 turn。
        if (p.desc) {
          await this.hooks.firePostToolUse(
            this.hookCtx(s),
            { tool: p.name, kind: p.desc.kind, input: p.input, output: out, isError },
            this.hookErr(s, turnId),
          );
        }

        // edit 类工具成功 → 发 FileChanged + L3 checkpoint 快照（§2.2 / §3.4）。写类只进串行波，checkpoint 不会并发。
        if (!isError && p.desc && MUTATION_KINDS.has(p.desc.kind)) {
          await this.afterMutation(s, p.desc.kind, p.input, turnId);
        }
      };

      // 波次划分（4.10b）：连续可并发的调用并为一波，其余单独成波（屏障——保持与副作用调用的相对顺序）。
      const waves: Array<{ concurrent: boolean; items: typeof plans }> = [];
      for (const p of plans) {
        const c = this.concurrentEligible(p.desc);
        const last = waves[waves.length - 1];
        if (c && last?.concurrent) last.items.push(p);
        else waves.push({ concurrent: c, items: [p] });
      }
      for (const wave of waves) {
        if (s.interrupted) break; // 波间拦截；波内在飞调用由 interrupt() 的 turnAbort signal 取消
        if (wave.concurrent && wave.items.length > 1) {
          await Promise.all(wave.items.map(runOne));
        } else {
          for (const p of wave.items) {
            if (s.interrupted) break;
            await runOne(p);
          }
        }
      }
      // parallel 组收敛：子结果按 calls 顺序编号合并成外层单条 tool_result（一 tool_use 一 result 的 provider 契约）。
      // 整体 isError 仅在全部子调用失败时置位；部分失败靠每段的（出错/被拒）标注传达。
      for (const [outerIdx, g] of groups) {
        const total = g.parts.length;
        const parts = g.parts.map((pt) => pt ?? { name: '?', content: '（未执行：本轮被中断）', isError: true });
        const content = parts
          .map((pt, i) => `[${i + 1}/${total}] ${pt.name}${pt.isError ? '（出错/被拒）' : ''}\n${pt.content}`)
          .join('\n\n');
        results[outerIdx] = {
          type: 'tool_result',
          toolUseId: toolCalls[outerIdx]!.id,
          content,
          isError: parts.every((pt) => pt.isError) || undefined,
          name: PARALLEL_TOOL,
        };
      }
      const toolResults: ContentBlock[] = results.filter((r): r is ContentBlock => r !== undefined);

      // 中断：不回填本轮 observation（含被中断工具的 error）、不 compact，直接收尾（审查 CONC-2，防污染 resume 上下文 + 多余压缩）。
      if (s.interrupted) {
        await this.completeTurn(s, 'interrupted', usage ?? zeroUsage(), turnId);
        return;
      }
      s.messages.push({ role: 'assistant', content: assistantBlocks });
      s.messages.push({ role: 'user', content: toolResults });
      // ContextManager.maybeCompact()：注入 observation 后按 token 阈值触发压缩（§2.1 / §5.1）。
      await this.maybeCompact(s, turnId);
      // 本步工具调用可能触发熔断（turn 中途）：补 diff 落库，否则若冷却在下一 turn 前自愈则失败态系统性漏记（审查 CRIT-1）。
      await this.syncMcpStatus(s, turnId);
    }

    await this.completeTurn(s, 'max_turn_steps', zeroUsage(), turnId);
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
    await this.doCondense(s, turnId);
  }

  /**
   * 强制压缩（4F context_overflow fallback）：跳过阈值/min-rounds 闸门立即压一次（provider 报上下文超限 = 必须现在压）。
   * 返回是否真压成（压不动 → false，调用方放弃重试）。
   */
  private async forceCompact(s: SessionState, turnId: Id): Promise<boolean> {
    return this.doCondense(s, turnId);
  }

  /** 压缩核心（§5.1 / 3D 结构化交接）：condense 只改送 LLM 的窗口，原始 EventLog 不删；压成则发 ContextCompacted。返回是否压成。 */
  private async doCondense(s: SessionState, turnId?: Id): Promise<boolean> {
    const before = estimateMessagesTokens(s.messages);
    await this.hooks.firePreCompact(this.hookCtx(s), this.hookErr(s, turnId)); // PreCompact hook（4A）

    // 结构化交接（3D）：condense 实际压缩时经 onHandoff 回传四节交接 + 保真标识符集，落 ContextCompacted。
    let handoffSummary: HandoffSummary | undefined;
    let preservedIdentifiers: string[] | undefined;
    const condensed = await this.d.condenser.condense(s.messages, {
      onHandoff: (h, ids) => {
        handoffSummary = h;
        preservedIdentifiers = ids.length > 0 ? ids : undefined;
      },
    });
    if (condensed === s.messages || condensed.length >= s.messages.length) return false; // 没压成，不发事件
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
    return true;
  }

  /** 4F：provider fallback 链 = 主路由（deps.provider+model）+ deps.fallbacks。 */
  private routeChain(s: SessionState): ProviderRoute[] {
    // 4.6e K1：主路由模型跟随会话（setModel 下一轮生效）；startSession 缺省即 deps.model，行为等价。
    const primary: ProviderRoute = { provider: this.d.provider, model: s.model };
    return [primary, ...(this.d.fallbacks ?? [])];
  }

  /** 4F：会话当前生效路由的模型 id（committeed/fallback 后），用于成本估算。 */
  private activeModel(s: SessionState): string {
    const chain = this.routeChain(s);
    return chain[Math.min(s.routeIdx, chain.length - 1)]!.model;
  }

  /** 4F：按模型填 costUsd（已含则尊重原值）；无 estimator 或未知模型 → 原样返回。 */
  private withCost(model: string, usage: Usage): Usage {
    if (usage.costUsd != null) return usage;
    const costUsd = this.d.costEstimator?.(model, usage);
    return costUsd != null ? { ...usage, costUsd } : usage;
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
    turnId?: Id,
  ): Promise<ApprovalOutcome> {
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
      const decided = new Promise<ApprovalOutcome>((resolve) => {
        this.pendingApprovals.set(requestId, (outcome) => resolve(outcome));
        const ms = this.d.approvalTimeoutMs;
        if (ms && ms > 0) {
          // 4.9c 审批语义修正：超时 resolve 带独立归因——tool_result/surface 可区分「超时自动拒」与「用户真拒」。
          timer = setTimeout(() => {
            if (this.pendingApprovals.delete(requestId)) resolve({ decision: 'reject_once', autoReason: 'timeout' });
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
    // gate / 非交互：emit 后由 gate 决定 / headless 默认拒绝（带 noninteractive 归因，不再谎称「用户拒绝」）。
    await this.emit(s, { kind: 'ApprovalRequested', requestId, toolCallId, tool, input, risk, suggestions }, turnId);
    if (this.d.approvalGate) {
      return await this.d.approvalGate.request({ sessionId: s.id, tool, input, risk });
    }
    return { decision: 'reject_once', autoReason: 'noninteractive' };
  }

  /**
   * 子代理审批上浮（4.9c）：子内核的代理 ApprovalGate 经此在**父会话**登记 pending + emit ApprovalRequested——
   * 复用 pendingApprovals/decideApproval 全套，TUI/RPC 现有审批面板零改动接管；批完 resolve 回子内核。
   * 父会话非交互（headless）→ 走父 approvalGate 或 noninteractive 默认拒；父会话已驱逐 → 同拒。
   * 超时语义与主循环一致（approvalTimeoutMs → autoReason:'timeout'）。
   */
  async relayApproval(
    parentSessionId: Id,
    req: { tool: string; input: unknown; risk: RiskLevel },
  ): Promise<ApprovalOutcome> {
    const s = this.sessions.get(parentSessionId);
    if (!s) return { decision: 'reject_once', autoReason: 'noninteractive' };
    return this.requestApproval(s, `subagent-${randomUUID()}`, req.tool, req.input, req.risk, s.currentTurnId);
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
        // 4.9d：状态**变化**顺手转 LLM 提醒（仅 turn 内且真变化时——startSession 的基线快照不注入，避免噪声）。
        if (turnId && prev && prev.status !== info.status) {
          this.pushStatusNote(
            s,
            `[系统状态] MCP server「${info.server}」→ ${info.status}${info.status === 'failed' ? '（熔断冷却中，其工具暂不可见，稍后自动恢复）' : ''}`,
          );
        }
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
        if (turnId) this.pushStatusNote(s, `[系统状态] MCP server「${server}」已断开，其工具暂不可见`);
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

  /**
   * emit 串行化（4C）：每会话所有 emit 排成单链，杜绝「正在跑的 turn 自身 emit」与「后台子 agent 完成回调
   * 对父会话的 emit」并发抢 headCursor → append 单调校验抛错。turn 内 emit 本就顺序 await（prev 已 resolve，
   * 零额外开销）；仅后台离带 emit 受此保护。doEmit 抛错仍向调用方传播（行为不变），但不毒化链（chain 自吞）。
   */
  private emit(s: SessionState, event: AgentEvent, turnId?: Id): Promise<void> {
    const prev = s.emitChain;
    const run = (async () => {
      await prev;
      await this.doEmit(s, event, turnId);
    })();
    s.emitChain = run.catch(() => {});
    return run;
  }

  private async doEmit(s: SessionState, event: AgentEvent, turnId?: Id): Promise<void> {
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
      agentProfile: this.d.agentProfile ?? 'default',
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

  /** Hook 上下文（4A）：会话快照三元组。 */
  private hookCtx(s: SessionState): HookContext {
    return { sessionId: s.id, cwd: s.cwd, permissionMode: s.permissionMode };
  }

  /** 观测型 hook 异常去向（4A）：emit Error 落 EventLog —— 不吞掉（可见），不拖垮 turn（仅记录）。 */
  private hookErr(s: SessionState, turnId?: Id): HookErrorSink {
    return async (point, err) => {
      await this.emit(
        s,
        { kind: 'Error', message: `hook ${point} 异常：${err instanceof Error ? err.message : String(err)}` },
        turnId,
      );
    };
  }

  /** 收尾 turn（4A）：先触发 Stop hook，再 emit TurnCompleted（统一各完成态出口）。 */
  private async completeTurn(s: SessionState, stopReason: StopReason, usage: Usage, turnId: Id): Promise<void> {
    await this.hooks.fireStop(this.hookCtx(s), stopReason, this.hookErr(s, turnId));
    const withCost = this.withCost(this.activeModel(s), usage); // 4F：填 costUsd（含 cache 分价）
    await this.emit(
      s,
      { kind: 'TurnCompleted', stopReason, usage: withCost, ...(withCost.costUsd != null ? { costUsd: withCost.costUsd } : {}) },
      turnId,
    );
  }

  // ───────────────────────── 子 agent 接缝（4C / SubagentHost）─────────────────────────

  /** 子 agent 派生：父会话落 SubagentStarted + 触发 SubagentStart hook（内核仍是唯一 AgentEvent 写入者）。 */
  async noteSubagentStarted(parentSessionId: Id, info: { childSessionId: Id; label: string; model: string }): Promise<void> {
    const s = this.sessions.get(parentSessionId);
    if (!s) return; // 父会话已驱逐：静默丢弃（背景子 agent 可能晚于会话生命周期完成）
    await this.hooks.fireSubagentStart(this.hookCtx(s), info.label, this.hookErr(s, s.currentTurnId));
    await this.emit(s, { kind: 'SubagentStarted', childSessionId: info.childSessionId, label: info.label, model: info.model }, s.currentTurnId);
  }

  /**
   * 子 agent 完成：父会话落 SubagentResult（只回摘要，§2.5）+ 触发 SubagentStop hook。
   * injectSteering=true（背景）时摘要排入 steering 队列，于父下一 step 注入消息窗口；前台无需（摘要经 tool_result 回灌）。
   * emit 经串行链保护，背景回调与在跑 turn 的 emit 不交错。
   */
  async noteSubagentResult(
    parentSessionId: Id,
    info: { childSessionId: Id; summary: string },
    opts?: { injectSteering?: boolean },
  ): Promise<void> {
    const s = this.sessions.get(parentSessionId);
    if (!s) return;
    await this.emit(s, { kind: 'SubagentResult', childSessionId: info.childSessionId, summary: info.summary }, s.currentTurnId);
    await this.hooks.fireSubagentStop(this.hookCtx(s), info.summary, this.hookErr(s, s.currentTurnId));
    if (opts?.injectSteering) s.pendingSteering.push(`[子 agent ${info.childSessionId} 结果]\n${info.summary}`);
  }

  /**
   * 抽干 steering 队列（4C，§2.5）：把后台子 agent 结果并入下一次推理的消息窗口。
   * 关键——并入**末条 user 消息**（注入 tool_results 那条或初始 prompt），保持 user/assistant 严格交替，
   * 杜绝「连续两条 user」破坏 provider 消息契约。仅在 step 顶（消息尚未送 provider）调用。
   */
  private drainSteering(s: SessionState): void {
    if (s.pendingSteering.length === 0) return;
    this.appendUserText(s, s.pendingSteering.splice(0).join('\n\n'));
  }

  // ───────────────────────── 动态状态提醒（4.9d）─────────────────────────

  /** 入队一条状态提醒（同文去重——同一状态不重复刷屏）。 */
  private pushStatusNote(s: SessionState, note: string): void {
    if (!s.pendingStatusNotes.includes(note)) s.pendingStatusNotes.push(note);
  }

  /** toolset diff（4.9d）：相对上 turn 消失/新增的工具注入一句解释；基准随 turn 滚动（同一变化只报一次）。 */
  private noteToolsetDiff(s: SessionState, names: string[]): void {
    const prev = s.lastToolsetNames;
    s.lastToolsetNames = names;
    if (!prev) return; // 首 turn 无基准
    const prevSet = new Set(prev);
    const curSet = new Set(names);
    const removed = prev.filter((n) => !curSet.has(n));
    const added = names.filter((n) => !prevSet.has(n));
    if (removed.length === 0 && added.length === 0) return;
    const parts: string[] = [];
    if (removed.length > 0) parts.push(`消失：${removed.join('、')}（可能因 MCP 熔断/断连、插件崩溃或信任变化，勿再调用）`);
    if (added.length > 0) parts.push(`新增：${added.join('、')}`);
    this.pushStatusNote(s, `[系统状态] 本 turn 可用工具集相对上 turn 变化——${parts.join('；')}`);
  }

  /** 上下文满度提醒（4.9d）：跨过 70% 阈值注入一次「已用 X%」，LLM 可主动收敛；降回阈下重置、再跨重报。 */
  private noteContextFullness(s: SessionState): void {
    const usable = this.d.usableContextTokens ?? 200_000;
    const pct = estimateMessagesTokens(s.messages) / usable;
    if (pct >= 0.7 && !s.ctxHighNoted) {
      s.ctxHighNoted = true;
      this.pushStatusNote(s, `[系统状态] 上下文已用 ${Math.round(pct * 100)}%（接近压缩阈值）——请收敛输出、优先完成结论，冗长内容交给子 agent 或落盘`);
    } else if (pct < 0.7 && s.ctxHighNoted) {
      s.ctxHighNoted = false; // 压缩后降回阈下 → 允许下次跨阈重报
    }
  }

  /** 抽干状态提醒队列（4.9d）：并入末条 user（同 drainSteering 的交替保护），仅在 step 顶调用。 */
  private drainStatusNotes(s: SessionState): void {
    if (s.pendingStatusNotes.length === 0) return;
    this.appendUserText(s, s.pendingStatusNotes.splice(0).join('\n'));
  }

  /** 把文本并入消息窗口的**末条 user**（保 user/assistant 严格交替）；末条非 user 则新增一条 user。 */
  private appendUserText(s: SessionState, note: string): void {
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === 'user') {
      if (typeof last.content === 'string') last.content = `${last.content}\n\n${note}`;
      else last.content.push({ type: 'text', text: note });
    } else {
      s.messages.push({ role: 'user', content: note });
    }
  }

  private toolCtx(s: SessionState, signal?: AbortSignal): ToolContext {
    // 注：flags 每次现取 toolFlags()，execute 时与 turn 起点 snapshot 时可能不同源（审查 SNAP-4）——
    // 当前 flags 仅参与 resolveAvailable 的工具显隐（turn 内只在起点求值），execute 时仅透传给 executor，不破 prompt 前缀。
    const flags = this.d.toolFlags ? new Set(this.d.toolFlags()) : undefined;
    return { sessionId: s.id, cwd: s.cwd, signal: signal ?? s.turnAbort?.signal, flags };
  }

  /**
   * 批内并发资格（4.10b）：无副作用类别（read/search/fetch/think）+ deps.concurrentTools 名单
   * （kind='other' 但无本地副作用，如 subagent_spawn）。未知工具（不在可见集）走串行，保持原报错路径顺序。
   */
  private concurrentEligible(desc: ToolDescriptor | undefined): boolean {
    if (!desc) return false;
    if (CONCURRENT_KINDS.has(desc.kind)) return true;
    return (this.d.concurrentTools ?? DEFAULT_CONCURRENT_TOOLS).includes(desc.name);
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
