import { z } from 'zod';
import { CursorSchema, IdSchema } from './ids';
import {
  StopReasonSchema,
  ToolKindSchema,
  RiskLevelSchema,
  PermissionModeSchema,
  ApprovalDecisionSchema,
  FileChangeKindSchema,
  ToolCompletionStatusSchema,
  McpServerStatusSchema,
} from './enums';
import type { McpServerStatus } from './enums';

// ───────────────────────── 子类型 ─────────────────────────

const ItemStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

export const TodoItemSchema = z.object({
  text: z.string(),
  status: ItemStatusSchema,
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const PlanStepSchema = z.object({
  text: z.string(),
  status: ItemStatusSchema,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * 结构化交接摘要（3D / DESIGN §5.1）：把上下文压缩的中段历史压成四节可机读交接，
 * 随 ContextCompacted 落库——resume 后可读回结构化交接、可审计。便宜模型产出四节文本，
 * Condenser 确定性解析为本结构。标识符保真（preservedIdentifiers）由机制 diff 校验另行承载。
 */
export const HandoffSummarySchema = z.object({
  /** ## 目标 */
  goal: z.string(),
  /** ## 已发生 */
  whatHappened: z.string(),
  /** ## 当前状态 */
  currentState: z.string(),
  /** ## 下一步 */
  nextSteps: z.string(),
});
export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

export const ApprovalSuggestionSchema = z.object({
  decision: ApprovalDecisionSchema,
  label: z.string().optional(),
});
export type ApprovalSuggestion = z.infer<typeof ApprovalSuggestionSchema>;

/** 用量（DESIGN §4.4 + §15.4：必须含 cacheCreation/thinking，否则成本低估 25%~100%）。 */
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  thinkingTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ErrorInfoSchema = z.object({
  message: z.string(),
  type: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

/**
 * MCP host 连接状态快照单项（DESIGN §3.3，3C）。host 暴露 `statusSnapshot()` 供 kernel diff 落 EventLog；
 * 与 `McpServerStatus` 事件解耦于此结构类型，避免 surface-mcp ↔ kernel 反向依赖。
 */
export interface McpServerStatusInfo {
  server: string;
  status: McpServerStatus;
  toolCount?: number;
  error?: string;
  /**
   * 工具集世代号（host 维护，按 server 名单调递增；每次连接/重连/list_changed 重建 +1）。
   * kernel 据此检测「同名 server 工具身份变化」（list_changed rug-pull）→ 失效该 server 的会话审批缓存，
   * 强制变更后的同名工具重新走 ApprovalGate（审查 SEC-8 修复）。不入持久事件，仅用于内存 diff。
   */
  epoch?: number;
}

// ───────────────────────── AgentEvent sealed union（DESIGN §2.2，21 变体）─────────────────────────

export const AgentEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('SessionStarted'),
    externalId: IdSchema,
    model: z.string(),
    tools: z.array(z.string()),
    workspacePath: z.string(),
    permissionMode: PermissionModeSchema,
    profile: z.string(),
    gitRef: z.string().optional(), // resume 四要素之一（§6.3）
  }),
  z.object({
    kind: z.literal('TurnStarted'),
    turnId: IdSchema,
    promptIdemKey: z.string(),
  }),
  z.object({
    kind: z.literal('AssistantText'),
    delta: z.string().optional(),
    full: z.string().optional(),
  }),
  z.object({
    kind: z.literal('Reasoning'),
    delta: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({
    kind: z.literal('ToolCallStarted'),
    id: IdSchema,
    name: z.string(),
    toolKind: ToolKindSchema,
    summary: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal('ToolCallOutput'),
    id: IdSchema,
    chunk: z.string(),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('ToolCallCompleted'),
    id: IdSchema,
    status: ToolCompletionStatusSchema,
    truncatedToPath: z.string().optional(), // 大输出写盘只回路径（§2.2）
  }),
  z.object({
    kind: z.literal('FileChanged'),
    path: z.string(),
    changeKind: FileChangeKindSchema,
  }),
  z.object({
    kind: z.literal('Todo'),
    items: z.array(TodoItemSchema),
  }),
  z.object({
    kind: z.literal('Plan'),
    steps: z.array(PlanStepSchema),
  }),
  z.object({
    kind: z.literal('ApprovalRequested'),
    requestId: IdSchema,
    tool: z.string(),
    input: z.unknown(),
    risk: RiskLevelSchema,
    suggestions: z.array(ApprovalSuggestionSchema),
  }),
  z.object({
    kind: z.literal('SubagentStarted'),
    childSessionId: IdSchema,
    label: z.string(),
    model: z.string(),
  }),
  z.object({
    kind: z.literal('SubagentResult'),
    childSessionId: IdSchema,
    summary: z.string(), // 只回摘要，防主上下文污染（§2.5）
  }),
  z.object({
    kind: z.literal('ContextCompacted'),
    fromCursor: CursorSchema,
    toCursor: CursorSchema,
    tokensSaved: z.number().int().nonnegative(),
    /** 结构化交接摘要（3D）：四节可机读交接，resume 后可读回。可选——NoopCondenser/旧事件无此字段。 */
    handoffSummary: HandoffSummarySchema.optional(),
    /** 机制 diff 校验后逐字保真的不透明标识符集合（3D）：UUID/path/hash/URL/error-code。 */
    preservedIdentifiers: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('ApiRetry'),
    attempt: z.number().int(),
    maxRetries: z.number().int(),
    delayMs: z.number().int().optional(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal('BackgroundProcess'),
    procId: IdSchema,
    label: z.string(),
    status: z.enum(['running', 'exited']),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('McpServerStatus'), // MCP host 连接状态（3C 韧性：连接/空闲断连/熔断）
    server: z.string(),
    status: McpServerStatusSchema,
    toolCount: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal('UsageUpdate'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative().optional(),
    thinkingTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('TurnCompleted'),
    stopReason: StopReasonSchema,
    usage: UsageSchema,
    costUsd: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('TurnFailed'),
    error: ErrorInfoSchema,
  }),
  z.object({
    kind: z.literal('Error'),
    message: z.string(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventKind = AgentEvent['kind'];

/** 运行时可枚举的全部 kind（测试 / 同构 review / Go schema gen 用）。 */
export const AGENT_EVENT_KINDS: AgentEventKind[] = AgentEventSchema.options.map(
  (o) => o.shape.kind.value,
);

/**
 * 事件信封（DESIGN §2.2）：append-only EventLog 的单元，是 resume/重放/审计三件套的根。
 * `cursor` 单调递增；`parentId` 形成 DAG（聊天 reply / fork 映射到此）。
 */
export const EventEnvelopeSchema = z.object({
  sessionId: IdSchema,
  cursor: CursorSchema,
  parentId: CursorSchema.nullable(),
  turnId: IdSchema.nullable(),
  ts: z.number(), // server-time 基准
  event: AgentEventSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
