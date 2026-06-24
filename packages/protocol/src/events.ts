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
} from './enums';

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

// ───────────────────────── AgentEvent sealed union（DESIGN §2.2，20 变体）─────────────────────────

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
