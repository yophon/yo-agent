/**
 * @yo-agent/tools/core —— 浏览器安全核心入口（Phase 5A）。
 * 只含 registry / parallel-tool / mcp 护栏纯函数；排除 builtins / bash / exec-local
 * / subagent-tool / skill-tool / memory-tool（node:fs / node:child_process 或按需另引）。
 * 类型经 type-only 转发（打包期整体擦除）。
 */
export type {
  ToolApproval,
  AvailabilityExpr,
  ToolDescriptor,
  ToolContext,
  ToolEvent,
  ToolExecutorRef,
  RegisteredTool,
  ToolRegistry,
} from './index';
export * from './registry';
export * from './mcp';
export * from './parallel-tool';
