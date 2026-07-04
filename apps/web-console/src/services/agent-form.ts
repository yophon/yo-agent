/**
 * agent 配置表单校验（Phase 5.1d，纯函数可单测）。
 * 规则对齐 surface-web 的 resolveWebAgentConfig：错误全可行动。
 */
import type { AgentConfigRecord, DeclarativeHttpTool } from './types';

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export function validateTool(t: DeclarativeHttpTool, index: number): string[] {
  const errs: string[] = [];
  const label = t.name || `#${index + 1}`;
  if (!TOOL_NAME_RE.test(t.name)) errs.push(`工具 ${label}：名称须为字母开头的 [a-zA-Z0-9_]，≤64 字符`);
  if (!t.description.trim()) errs.push(`工具 ${label}：description 必填（LLM 靠它决定何时调用）`);
  if (!/^https?:\/\//.test(t.url)) errs.push(`工具 ${label}：url 须以 http(s):// 开头`);
  try {
    const parsed = JSON.parse(t.inputSchemaJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errs.push(`工具 ${label}：inputSchema 须是 JSON 对象（JSON Schema 7）`);
    }
  } catch {
    errs.push(`工具 ${label}：inputSchema 不是合法 JSON`);
  }
  return errs;
}

export function validateAgent(rec: AgentConfigRecord): string[] {
  const errs: string[] = [];
  if (!rec.name.trim()) errs.push('名称必填');
  if (!rec.connection.model.trim()) errs.push('模型必填（如 gpt-5.5 / claude-sonnet-5）');
  if (!rec.connection.baseUrl?.trim() && !rec.connection.apiKey?.trim()) {
    errs.push('直连官方端点必须填 API Key；接自建代理/中转站请填 baseUrl（key 可由代理侧注入）');
  }
  if (rec.connection.baseUrl && !/^https?:\/\//.test(rec.connection.baseUrl)) {
    errs.push('baseUrl 须以 http(s):// 开头');
  }
  const names = new Set<string>();
  rec.tools.forEach((t, i) => {
    errs.push(...validateTool(t, i));
    if (names.has(t.name)) errs.push(`工具名重复：${t.name}`);
    names.add(t.name);
  });
  return errs;
}

/** headers 编辑态（textarea 每行 `Name: value`）⇆ 记录态往返。 */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

export function stringifyHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/** 「测试连接」：openai 系走 GET /models；anthropic/gemini 无通用只读端点，提示直接发消息验证。 */
export async function testConnection(rec: AgentConfigRecord): Promise<{ ok: boolean; message: string }> {
  const c = rec.connection;
  if (c.provider === 'openai' || c.provider === 'openai-responses') {
    const base = (c.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    try {
      const headers: Record<string, string> = { ...c.headers };
      if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
      const res = await fetch(`${base}/models`, { headers });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const n = body.data?.length ?? 0;
      return { ok: true, message: `连接成功${n ? `，端点提供 ${n} 个模型` : ''}` };
    } catch (e) {
      return { ok: false, message: `连接失败：${e instanceof Error ? e.message : String(e)}（跨域？检查端点 CORS）` };
    }
  }
  return { ok: true, message: '该协议无通用只读探测端点——保存后直接发一条消息验证' };
}
