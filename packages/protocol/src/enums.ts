import { z } from 'zod';

/**
 * 停止原因（DESIGN §2.2，借鉴 ACP StopReason）。
 * 对外只暴露 TurnCompleted/TurnFailed 两个完成态，内部多种停止原因收敛到此枚举。
 * `pause_turn`：extended-thinking / server-tool 暂停，循环遇到时 continue（§15.1）。
 */
export const StopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_steps',
  'tool_budget_exceeded',
  'loop_detected',
  'interrupted',
  'refusal',
  'pause_turn',
  'error',
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/**
 * ACP 对齐的 9 种工具语义标签（DESIGN §2.2），便于 IDE / IM 统一渲染。
 */
export const ToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'unknown']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/**
 * 权限模式（DESIGN §9.2 三档下限 + §15.7 扩展）。
 * 核心三档：read-only / supervised / autonomous；其余为部署便利档。
 */
export const PermissionModeSchema = z.enum([
  'read-only',
  'supervised',
  'accept-edits',
  'autonomous',
  'ci',
  'bypass',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * 推理力度归一轴（DESIGN §4.1 + §15.4 权威核查）。
 * 翻译到 Anthropic 时映射为 `output_config.effort`（GA 原生字段，非 budget_tokens）。
 * `xhigh` 为 Opus 4.7+ 新增、编程/agentic 最佳、Claude Code 默认。
 */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

/** 审批裁决四选项（DESIGN §3.4 / §6.2，ACP request_permission）。 */
export const ApprovalDecisionSchema = z.enum([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** 文件变更类型（DESIGN §2.2 FileChanged.changeKind）。 */
export const FileChangeKindSchema = z.enum(['create', 'edit', 'delete', 'rename']);
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;

/** 工具完成状态（DESIGN §3.2：出错必须 error，不可包在 ok）。 */
export const ToolCompletionStatusSchema = z.enum(['ok', 'error']);
export type ToolCompletionStatus = z.infer<typeof ToolCompletionStatusSchema>;

/**
 * MCP host 连接状态（DESIGN §3.3 / §15.3，Phase 3C 韧性可观测）。
 * connected：已连接并注册工具；disconnected：空闲 TTL 断连 / 主动关闭；failed：熔断打开（连续失败超阈值）。
 */
export const McpServerStatusSchema = z.enum(['connected', 'disconnected', 'failed']);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
