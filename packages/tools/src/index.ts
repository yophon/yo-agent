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
  /** 声明式 availability 的 configFlag 谓词数据源（§3.1）；如 MCP 连接健康标志（3C 熔断 → 工具显隐）。 */
  flags?: ReadonlySet<string>;
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
  /** 注册工具；撞名默认抛错（禁静默覆盖 → 防错路由，§15.3）。需替换走 unregister 再 register。 */
  register(tool: RegisteredTool): void;
  /** 移除工具（MCP server 断连/熔断时反注册，3C）；不存在为 no-op。 */
  unregister(name: string): void;
  /** evaluate availability 后返回当前可见工具集；顺序须稳定以保 prompt cache（内置按注册序 + 外部按名字典序，§15.4）。 */
  resolveAvailable(ctx: ToolContext): ToolDescriptor[];
  executor(name: string): ToolExecutorRef | undefined;
  /** 工具集版本（注册/反注册自增）；turn 内 snapshot 与 prompt-cache 失效边界判定用（§15.4）。 */
  toolsetVersion(): number;
}

export * from './registry';
export * from './builtins';
export * from './mcp';
export * from './exec';
export * from './exec-local';
export * from './bash';
export * from './subagent-tool';
