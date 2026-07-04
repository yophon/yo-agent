/**
 * @yo-agent/kernel/core —— 浏览器安全核心入口（Phase 5A）。
 * 只含纯逻辑/环境无关模块；排除 context-files / subagent / self-knowledge / skills / recipes
 * （node:fs / node:worker_threads）。类型经 type-only 转发（打包期整体擦除，
 * 不把 barrel 的运行时模块图牵进浏览器 bundle）。Node 侧与主入口同物。
 */
export type {
  SurfaceKind,
  SessionSummary,
  Kernel,
  ContextState,
  CondenseOpts,
  Condenser,
  ToolCallRef,
  LoopBreaker,
  ApprovalAutoReason,
  ApprovalOutcome,
  ApprovalGate,
  Checkpointer,
  SubagentSpawnOpts,
  SubagentManager,
  ContentPart,
  UnifiedMessage,
  ChatContext,
  PlatformAdapter,
  Surface,
  KernelDeps,
} from './index';
export * from './kernel';
export * from './loop-breaker';
export * from './condenser';
export * from './tokens';
export * from './risk';
export * from './policy';
export * from './hooks';
export * from './fallback';
