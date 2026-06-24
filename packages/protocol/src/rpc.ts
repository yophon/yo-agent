import { z } from 'zod';
import { CursorSchema, IdSchema } from './ids';
import { PermissionModeSchema, ApprovalDecisionSchema, EffortSchema, RiskLevelSchema } from './enums';
import { ApprovalSuggestionSchema, EventEnvelopeSchema } from './events';

/**
 * JSON-RPC 2.0 方法表（DESIGN §6.2），以 codex app-server 为蓝本，作通用远端驱动协议。
 * 客户端 → 服务端(yo-agent) 的请求方法。
 */
export const RpcMethod = {
  SessionNew: 'session/new',
  SessionList: 'session/list',
  SessionResume: 'session/resume',
  SessionReconnect: 'session/reconnect',
  SessionFork: 'session/fork',
  TurnStart: 'turn/start',
  TurnSteer: 'turn/steer',
  TurnInterrupt: 'turn/interrupt',
  ApprovalDecide: 'approval/decide',
  ModelList: 'model/list',
  FsReadFile: 'fs/readFile',
  FsWriteFile: 'fs/writeFile',
  FsWatch: 'fs/watch',
  Ping: 'ping',
} as const;
export type RpcMethod = (typeof RpcMethod)[keyof typeof RpcMethod];

/** 服务端(yo-agent) → 客户端 的 notification / 反向请求。 */
export const RpcServerMethod = {
  Event: 'event',
  ApprovalRequest: 'approval/request',
  Pong: 'pong',
} as const;
export type RpcServerMethod = (typeof RpcServerMethod)[keyof typeof RpcServerMethod];

// ───────────────────────── C→S 参数 / 结果 ─────────────────────────

export const SessionNewParamsSchema = z.object({
  project: z.string(), // workspace / worktree 路径
  agentProfile: z.string().optional(),
  model: z.string().optional(),
  permissionMode: PermissionModeSchema,
  allowedTools: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  surfaceKind: z.string(),
});
export type SessionNewParams = z.infer<typeof SessionNewParamsSchema>;

export const SessionNewResultSchema = z.object({
  sessionId: IdSchema,
  workspacePath: z.string(),
});
export type SessionNewResult = z.infer<typeof SessionNewResultSchema>;

/** 带历史重放恢复（默认）。"last" 续接最近会话。 */
export const SessionResumeParamsSchema = z.object({
  sessionId: z.union([IdSchema, z.literal('last')]),
  fromCursor: CursorSchema.optional(),
});
export type SessionResumeParams = z.infer<typeof SessionResumeParamsSchema>;

/** 无历史重连，只续实时流（IM 长会话省带宽）。 */
export const SessionReconnectParamsSchema = z.object({
  sessionId: IdSchema,
  fromCursor: CursorSchema,
});
export type SessionReconnectParams = z.infer<typeof SessionReconnectParamsSchema>;

export const SessionForkParamsSchema = z.object({
  sessionId: IdSchema,
  atCursor: CursorSchema,
});
export type SessionForkParams = z.infer<typeof SessionForkParamsSchema>;

export const TurnStartParamsSchema = z.object({
  sessionId: IdSchema,
  prompt: z.string(),
  idemKey: z.string(), // 幂等：resumed/retried turn 不双执行（防双计费）
  attachments: z.array(z.unknown()).optional(),
  effort: EffortSchema.optional(),
});
export type TurnStartParams = z.infer<typeof TurnStartParamsSchema>;

export const TurnStartResultSchema = z.object({ turnId: IdSchema });
export type TurnStartResult = z.infer<typeof TurnStartResultSchema>;

export const TurnSteerParamsSchema = z.object({ sessionId: IdSchema, text: z.string() });
export type TurnSteerParams = z.infer<typeof TurnSteerParamsSchema>;

export const TurnInterruptParamsSchema = z.object({ sessionId: IdSchema });
export type TurnInterruptParams = z.infer<typeof TurnInterruptParamsSchema>;

export const ApprovalDecideParamsSchema = z.object({
  requestId: IdSchema,
  decision: ApprovalDecisionSchema,
  updatedInput: z.unknown().optional(),
});
export type ApprovalDecideParams = z.infer<typeof ApprovalDecideParamsSchema>;

// ───────────────────────── S→C 参数 ─────────────────────────

/** event notification：流式事件推送（§2.2 的 EventEnvelope）。 */
export const EventNotificationParamsSchema = EventEnvelopeSchema;
export type EventNotificationParams = z.infer<typeof EventNotificationParamsSchema>;

/** approval/request：server→client 主动请求审批，阻塞 agent 直到应答/超时（默认 deny）。 */
export const ApprovalRequestParamsSchema = z.object({
  requestId: IdSchema,
  sessionId: IdSchema,
  tool: z.string(),
  input: z.unknown(),
  risk: RiskLevelSchema,
  suggestions: z.array(ApprovalSuggestionSchema),
});
export type ApprovalRequestParams = z.infer<typeof ApprovalRequestParamsSchema>;

/** 给 schema 生成器：方法 → 参数 schema 映射。 */
export const RPC_PARAM_SCHEMAS = {
  'session/new': SessionNewParamsSchema,
  'session/resume': SessionResumeParamsSchema,
  'session/reconnect': SessionReconnectParamsSchema,
  'session/fork': SessionForkParamsSchema,
  'turn/start': TurnStartParamsSchema,
  'turn/steer': TurnSteerParamsSchema,
  'turn/interrupt': TurnInterruptParamsSchema,
  'approval/decide': ApprovalDecideParamsSchema,
  'event': EventNotificationParamsSchema,
  'approval/request': ApprovalRequestParamsSchema,
} as const;
