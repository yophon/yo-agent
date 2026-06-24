import type {
  AvailabilityExpr,
  RegisteredTool,
  ToolContext,
  ToolDescriptor,
  ToolExecutorRef,
  ToolRegistry,
} from './index';

/** 多源统一注册表（DESIGN §3.1）：内置/MCP/插件走同一接口。 */
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.descriptor.name, tool);
  }

  resolveAvailable(ctx: ToolContext): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const t of this.tools.values()) {
      if (evalAvailability(t.descriptor.availability, ctx)) out.push(t.descriptor);
    }
    // 稳定排序（按名字典序）以保 prompt cache 前缀稳定（§15.4）。
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  executor(name: string): ToolExecutorRef | undefined {
    return this.tools.get(name)?.executor;
  }
}

/** 声明式 availability 求值（DESIGN §3.1）。surface/profile/config 谓词在后续阶段接 ctx，Slice A 默认放行。 */
export function evalAvailability(expr: AvailabilityExpr, ctx: ToolContext): boolean {
  if ('always' in expr) return expr.always;
  if ('allOf' in expr) return expr.allOf.every((e) => evalAvailability(e, ctx));
  if ('anyOf' in expr) return expr.anyOf.some((e) => evalAvailability(e, ctx));
  return true;
}
