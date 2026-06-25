/**
 * MCP host 工具注入护栏（DESIGN §15.3）—— 纯函数，3A 落地、3B 调用。
 * 外部 MCP server 是不可信输入源：命名须隔离命名空间、schema 须限大小、审批不可绕过。
 */
import type { ToolApproval } from './index';

/** server 名规范化：仅保留 [a-z0-9_-]，使 mcp__{server}__{tool} 命名空间稳定且与内置隔离。 */
export function sanitizeMcpServerName(server: string): string {
  const s = server
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) throw new Error(`非法 MCP server 名（规范化后为空）：「${server}」`);
  return s;
}

/** 生成强制命名 mcp__{server}__{tool}（§15.3，撑权限通配 mcp__github__* + 防与内置/跨 server 撞名）。 */
export function mcpToolName(server: string, tool: string): string {
  if (!tool) throw new Error(`非法 MCP 工具名（空）：server=${server}`);
  return `mcp__${sanitizeMcpServerName(server)}__${tool}`;
}

/** 判定是否 MCP 工具名（kernel 路由 / 权限通配用）。 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__');
}

/** 外部工具审批 clamp：副作用未知，永不 'never'（防绕过 ApprovalGate，§15.3）。 */
export function clampMcpApproval(approval?: ToolApproval): ToolApproval {
  return approval && approval !== 'never' ? approval : 'risk-based';
}

export interface SanitizeSchemaOpts {
  /** 最大嵌套深度，超出子树降级为 {type:'object'}。 */
  maxDepth?: number;
  /** 单层最大属性数 / 数组元素数，超出截断。 */
  maxProps?: number;
  /** 字符串值（含 description）最大长度，超出截断。 */
  maxStringLen?: number;
}

/**
 * 清洗外部 MCP server 返回的 JSON Schema（防供应链：超深嵌套 / 超大 schema / 注入式超长 description）。
 * 顶层非对象 → {type:'object'}；递归限深度/属性数/字符串长度；循环引用 → {}。
 * 注：$ref/oneOf/format 等关键字的 Gemini 降级仍由 provider 层 downgradeSchemaForGemini 负责（§4.2），此处只限大小。
 */
export function sanitizeMcpInputSchema(
  schema: unknown,
  opts: SanitizeSchemaOpts = {},
): Record<string, unknown> {
  const maxDepth = opts.maxDepth ?? 8;
  const maxProps = opts.maxProps ?? 64;
  const maxStringLen = opts.maxStringLen ?? 8192;
  const seen = new WeakSet<object>();

  function walk(v: unknown, depth: number): unknown {
    if (typeof v === 'string') return v.length > maxStringLen ? v.slice(0, maxStringLen) : v;
    if (Array.isArray(v)) {
      if (depth >= maxDepth) return [];
      return v.slice(0, maxProps).map((x) => walk(x, depth + 1));
    }
    if (v && typeof v === 'object') {
      if (seen.has(v)) return {}; // 仅祖先链上的真循环兜底（审查 RISK-02）
      if (depth >= maxDepth) return { type: 'object' };
      seen.add(v); // 路径栈：仅标记当前祖先路径
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, val] of Object.entries(v)) {
        if (n++ >= maxProps) break;
        out[k] = walk(val, depth + 1);
      }
      seen.delete(v); // 离开子树 → 兄弟/DAG 共享引用（共享 $defs）各自正常展开，不误判为循环
      return out;
    }
    return v; // number / boolean / null
  }

  const result = walk(schema, 0);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { type: 'object' };
  }
  return result as Record<string, unknown>;
}
