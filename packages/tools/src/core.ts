/**
 * @yo-agent/tools/core —— 浏览器安全核心入口（Phase 5A）。
 * 只含 registry / parallel-tool / mcp 护栏纯函数 / skill-tool（5.2a：浏览器面 skills 需要）；
 * 排除 builtins / bash / exec-local（node:fs / node:child_process）。exec / subagent-tool /
 * memory-tool 虽纯逻辑但浏览器面暂不需要，未收——要用时在此补 export（包 exports 无文件级子路径，
 * barrel 进不了）。类型经 type-only 转发（打包期整体擦除）。
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
export * from './skill-tool';
