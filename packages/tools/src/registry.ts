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
  private version = 0;

  register(tool: RegisteredTool): void {
    const name = tool.descriptor.name;
    const existing = this.tools.get(name);
    // 撞名静默覆盖 = 静默丢工具 + executor(name) 错路由（§15.3）；显式抛错，替换走 unregister 再 register。
    if (existing) {
      throw new Error(
        `工具名冲突：「${name}」已注册（owner=${existing.descriptor.owner}），拒绝覆盖（owner=${tool.descriptor.owner}）。如需替换请先 unregister。`,
      );
    }
    this.tools.set(name, tool);
    this.version++;
  }

  unregister(name: string): void {
    if (this.tools.delete(name)) this.version++;
  }

  resolveAvailable(ctx: ToolContext): ToolDescriptor[] {
    // 两段稳定排序（§15.4）：内置（owner:'core'）按注册序（Map 迭代序）在前，
    // 外部（mcp/plugin）按名字典序在后——使 MCP 工具动态增删永不挤动内置工具的 prompt 前缀位置。
    const core: ToolDescriptor[] = [];
    const ext: ToolDescriptor[] = [];
    for (const t of this.tools.values()) {
      if (!evalAvailability(t.descriptor.availability, ctx)) continue;
      (t.descriptor.owner === 'core' ? core : ext).push(t.descriptor);
    }
    ext.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return [...core, ...ext];
  }

  executor(name: string): ToolExecutorRef | undefined {
    return this.tools.get(name)?.executor;
  }

  toolsetVersion(): number {
    return this.version;
  }
}

/**
 * 子 agent 工具收紧包装（4C / DESIGN §2.5）：只读视图，把内层注册表收紧到 allowlist。
 * deriveSubagentPolicy「只收紧」的落点——子 agent 的内核拿到的可见工具集 ⊆ allowlist：
 *   - resolveAvailable 过滤掉非 allowlist 工具（prompt 前缀不含它们）；
 *   - executor(name) 对非 allowlist 工具返回 undefined（即便 LLM 越界点名也会被内核「不在可见集」拒，不绕审批）。
 * register/unregister 禁用（子 agent 不得改父注册表）。toolsetVersion 透传内层（snapshot 边界判定）。
 */
export class AllowlistToolRegistry implements ToolRegistry {
  private readonly allow: ReadonlySet<string>;
  constructor(
    private readonly inner: ToolRegistry,
    allow: Iterable<string>,
  ) {
    this.allow = new Set(allow);
  }

  register(): void {
    throw new Error('AllowlistToolRegistry 只读：子 agent 不得修改父注册表');
  }

  unregister(): void {
    /* 只读：no-op（不抛，便于复用调用路径） */
  }

  resolveAvailable(ctx: ToolContext): ToolDescriptor[] {
    return this.inner.resolveAvailable(ctx).filter((d) => this.allow.has(d.name));
  }

  executor(name: string): ToolExecutorRef | undefined {
    return this.allow.has(name) ? this.inner.executor(name) : undefined;
  }

  toolsetVersion(): number {
    return this.inner.toolsetVersion();
  }
}

/**
 * 声明式 availability 求值（DESIGN §3.1）。
 * configFlag 读 ctx.flags（如 MCP 连接健康标志，3C 熔断时移除 → 该工具从 resolveAvailable 消失）；
 * surface/profileHasTool 谓词留后续阶段接 ctx，当前默认放行。
 */
export function evalAvailability(expr: AvailabilityExpr, ctx: ToolContext): boolean {
  if ('always' in expr) return expr.always;
  if ('allOf' in expr) return expr.allOf.every((e) => evalAvailability(e, ctx));
  if ('anyOf' in expr) return expr.anyOf.some((e) => evalAvailability(e, ctx));
  if ('configFlag' in expr) return ctx.flags?.has(expr.configFlag) ?? false;
  return true;
}
