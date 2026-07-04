/**
 * @yo-agent/kernel/core —— 浏览器安全核心入口（Phase 5A）。
 * 只含纯逻辑/环境无关模块；排除 subagent / self-knowledge（node:worker_threads / node:fs）。
 * 5.2a：context-files / skills / recipes 经 EnvAdapter（FileSystem 注入）纯逻辑化收入 core
 * ——浏览器面（MemoryFileSystem / 宿主自实现）解锁 skills 与约定文件能力；NodeFileSystem 仅主入口导出。
 * 类型经 type-only 转发（打包期整体擦除，不把 barrel 的运行时模块图牵进浏览器 bundle）。Node 侧与主入口同物。
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
export * from './env';
export * from './context-files';
export * from './skills';
export * from './recipes';
