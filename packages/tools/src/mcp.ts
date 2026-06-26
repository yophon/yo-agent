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

/** 工具名上限（对齐 Anthropic/OpenAI tool name ≤64；超长会被 provider 拒）。 */
const MAX_TOOL_NAME_LEN = 64;

/** tool 段清洗：仅留 [a-zA-Z0-9_-]，其余→_，折叠重复 _、去首尾 _（外部 server 返回不可信，防投毒）。 */
export function sanitizeMcpToolName(tool: string): string {
  return tool
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** 确定性短哈希（djb2，8 位 hex）——超长 tool 名截断时保唯一与稳定，不引入随机性。 */
function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

/**
 * 生成强制命名 mcp__{server}__{tool}（§15.3，撑权限通配 mcp__github__* + 防与内置/跨 server 撞名）。
 * server/tool 两段均清洗（外部不可信）；超长附稳定哈希后缀，避免击穿 provider 工具名长度限制。
 * 清洗后为空 → 抛错（调用方 per-tool 跳过，不污染整个工具集）。
 */
export function mcpToolName(server: string, tool: string): string {
  if (!tool) throw new Error(`非法 MCP 工具名（空）：server=${server}`);
  const srv = sanitizeMcpServerName(server);
  const t = sanitizeMcpToolName(tool);
  if (!t) throw new Error(`非法 MCP 工具名（清洗后为空）：server=${server} tool=「${tool}」`);
  const prefix = `mcp__${srv}__`;
  const name = `${prefix}${t}`;
  if (name.length <= MAX_TOOL_NAME_LEN) return name;
  // 超长：截断 tool 段 + 稳定哈希后缀（_xxxxxxxx），保确定性与唯一性。
  const budget = Math.max(8, MAX_TOOL_NAME_LEN - prefix.length - 9);
  return `${prefix}${t.slice(0, budget)}_${djb2Hex(t)}`;
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
