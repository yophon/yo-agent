/**
 * @yo-agent/tools —— 工具系统（冻结接口，DESIGN §3 / §15.2）。
 * ToolDescriptor(声明) + ToolExecutorRef(执行) 分离；内置/MCP/插件三源统一注册。
 */
import type { Id, ToolKind } from '@yo-agent/protocol';

export type ToolApproval = 'always' | 'risk-based' | 'never';

/** 声明式动态显隐表达式（DESIGN §3.1，OpenClaw ToolAvailabilityExpression）。 */
export type AvailabilityExpr =
  | { allOf: AvailabilityExpr[] }
  | { anyOf: AvailabilityExpr[] }
  | { surface: string }
  | { profileHasTool: string }
  | { configFlag: string }
  | { always: true };

export interface ToolDescriptor {
  /** MCP 工具强制 mcp__{server}__{tool} 命名（§15.3）。 */
  name: string;
  kind: ToolKind;
  description: string;
  /** JSON Schema 7；面向 Gemini 由 provider 层降级（§4.2）。 */
  inputSchema: Record<string, unknown>;
  owner: 'core' | 'plugin' | 'mcp';
  availability: AvailabilityExpr;
  approval: ToolApproval;
}

export interface ToolContext {
  sessionId: Id;
  cwd: string;
  /** 多租户 RBAC / audit / 路径限制基座（§15.2）。 */
  userId?: string;
  transcriptPath?: string;
  signal?: AbortSignal;
}

export type ToolEvent =
  | { kind: 'output'; chunk: string; exitCode?: number }
  | { kind: 'progress'; ratio?: number; note?: string };

export interface ToolExecutorRef {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;
}

export interface RegisteredTool {
  descriptor: ToolDescriptor;
  executor: ToolExecutorRef;
}

export interface ToolRegistry {
  register(tool: RegisteredTool): void;
  /** evaluate availability 后返回当前可见工具集；顺序须稳定以保 prompt cache（§15.4）。 */
  resolveAvailable(ctx: ToolContext): ToolDescriptor[];
  executor(name: string): ToolExecutorRef | undefined;
}
