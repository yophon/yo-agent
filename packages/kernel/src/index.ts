/**
 * @yo-agent/kernel —— 内核与接入层契约（冻结接口，DESIGN §2 / §5 / §7）。
 * Phase 0 只冻结接口；turn 循环实现是 Phase 1。
 */
import type {
  AgentEvent,
  ApprovalDecision,
  EventEnvelope,
  HandoffSummary,
  Id,
  PermissionMode,
  RiskLevel,
} from '@yo-agent/protocol';
import type { CanonMessage, ModelInfo, Provider } from '@yo-agent/provider';
import type { ToolRegistry } from '@yo-agent/tools';
import type { EventStore } from '@yo-agent/store';
import type { StartSessionOpts } from './kernel';

export type SurfaceKind = 'cli' | 'rpc' | 'chat' | 'acp' | 'mcp-server';

export interface SessionSummary {
  sessionId: Id;
  model: string;
  workspacePath: string;
  permissionMode: PermissionMode;
  headCursor: number;
}

/** 内核：唯一会写 AgentEvent 流的人（§0.3 脊柱）。 */
export interface Kernel {
  readonly events: EventStore;
  startSession(opts?: StartSessionOpts): Promise<Id>;
  /** 阻塞版：跑完整 turn 才 resolve（CLI）。 */
  submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<{ turnId: Id }>;
  /** 非阻塞版：发出 TurnStarted 即返回 turnId，turn 后台跑（RpcSurface）。 */
  beginTurn(sessionId: Id, prompt: string, idemKey: string): Promise<{ turnId: Id }>;
  steer(sessionId: Id, text: string): Promise<void>;
  interrupt(sessionId: Id): Promise<void>;
  subscribe(
    sessionId: Id,
    fromCursor: number | null,
    handler: (env: EventEnvelope) => void,
  ): () => void;
  decideApproval(requestId: Id, decision: ApprovalDecision, updatedInput?: unknown): void;
  listSessions(): SessionSummary[];
  listModels(): Promise<ModelInfo[]>;
  /** 跨进程 resume：会话不在内存则从持久态重建；store 无此会话返回 false。 */
  resumeSession(sessionId: Id): Promise<boolean>;
  /** 实时重连缺口（内存 ring）；null=gap 溢出，调用方走 EventLog 降级。 */
  bufferedSince(sessionId: Id, fromCursor: number): EventEnvelope[] | null;
  /** 驱逐一次性会话（常驻进程防泄漏）。 */
  endSession(sessionId: Id): void;
  /** 审批是否仍挂起（surface 跳过已决审批的 approval/request 重投）。 */
  isApprovalPending(requestId: Id): boolean;
}

export interface ContextState {
  usedTokens: number;
  usableTokens: number;
}

export interface CondenseOpts {
  /** /compact 手动指令，注入摘要 prompt（§15.5）。 */
  hint?: string;
  keepFirst?: number;
  keepTail?: number;
  /**
   * 结构化交接回调（3D）：condense 实际压缩时回传四节交接 + diff 校验后逐字保真的标识符集合。
   * 内核据此填 ContextCompacted.handoffSummary / preservedIdentifiers 落库。向后兼容——不传则忽略。
   */
  onHandoff?: (handoff: HandoffSummary, preservedIdentifiers: string[]) => void;
}

/**
 * 独立可替换的压缩组件（§5.1 / ADR-6）：默认 used>=80% usable 触发。
 * 作用于"送 LLM 的消息窗口"（CanonMessage[]）——原始 EventLog 不删，内核另发 ContextCompacted 落库。
 */
export interface Condenser {
  shouldCompact(ctx: ContextState): boolean;
  condense(messages: CanonMessage[], opts?: CondenseOpts): Promise<CanonMessage[]>;
}

export interface ToolCallRef {
  name: string;
  input: unknown;
}

/** 死循环熔断（§2.3，OpenClaw 四模式 + 历史窗）。 */
export interface LoopBreaker {
  check(call: ToolCallRef): 'ok' | 'warn' | 'break';
}

export interface ApprovalGate {
  request(req: {
    sessionId: Id;
    tool: string;
    input: unknown;
    risk: RiskLevel;
  }): Promise<{ decision: ApprovalDecision; updatedInput?: unknown }>;
}

/** L3 checkpoint（§3.4，ShadowGitCheckpointer 结构化满足）：edit 类工具成功后快照工作区。 */
export interface Checkpointer {
  snapshot(label?: string): Promise<{ checkpointId: Id; ref: string; createdAt: number }>;
}

export interface SubagentSpawnOpts {
  parentSessionId: Id;
  profile: string;
  task: string;
  mode: 'foreground' | 'background';
  model?: string;
  maxTurns?: number;
  isolation?: 'none' | 'worktree' | 'container';
  memory?: boolean;
  skipContextFiles?: boolean;
  outputMaxTokens?: number;
}

export interface SubagentManager {
  spawn(opts: SubagentSpawnOpts): Promise<{ childSessionId: Id }>;
}

// ───────────── 接入层（Transport + Adapter 二层，§7.1）─────────────

export interface ContentPart {
  type: 'text' | 'image' | 'file' | 'mention';
  value: string;
}

export interface UnifiedMessage {
  platform: string;
  chatId: string;
  senderId: string;
  /** 映射到 EventLog parentId —— 聊天线程 = agent 分支统一存储（§7.1）。 */
  replyToId?: string;
  parts: ContentPart[];
}

export interface ChatContext {
  target: Record<string, unknown>;
}

export interface PlatformAdapter {
  readonly platform: string;
  parseInbound(raw: unknown): UnifiedMessage | null;
  formatOutbound(ev: AgentEvent, ctx: ChatContext): unknown[];
}

export interface Surface {
  readonly kind: SurfaceKind;
  start(kernel: Kernel): Promise<void>;
}

/** 组合根依赖（Phase 1 注入实现）。 */
export interface KernelDeps {
  store: EventStore;
  provider: Provider;
  tools: ToolRegistry;
  condenser: Condenser;
  loopBreaker: LoopBreaker;
}

export * from './kernel';
export * from './loop-breaker';
export * from './condenser';
export * from './context-files';
export * from './tokens';
export * from './risk';
