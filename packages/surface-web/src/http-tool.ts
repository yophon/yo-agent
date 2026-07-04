/**
 * defineHttpTool —— 把「后端业务 API」降到一个声明（PHASE-5 5B）。
 * 执行体：fetch + ctx.signal 透传（中断/超时可取消）；!res.ok 抛错 → 内核统一转 isError tool_result。
 * 安全边界提醒：agent loop 在客户端可被篡改，这里发出的每个请求对后端都等价于用户直接调用
 * ——工具端点必须按公开 API 标准做服务端鉴权与校验。
 */
import type { ToolKind } from '@yo-agent/protocol';
import type { RegisteredTool, ToolApproval, ToolContext, ToolEvent } from '@yo-agent/tools/core';

export interface HttpToolSpec {
  name: string;
  /** 给 LLM 看的用途描述。 */
  description: string;
  /** JSON Schema 7 入参约束。 */
  inputSchema: Record<string, unknown>;
  /** 缺省 'fetch'（read/search/fetch/think 可批内并发执行）。 */
  kind?: ToolKind;
  /** 缺省 'never'（配 createWebAgent 缺省 auto 审批——防线在后端，见文件头）。 */
  approval?: ToolApproval;
  /** 简单式：固定端点。POST 系默认 JSON body=input；GET/DELETE 把 input 平铺进 query。 */
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 静态头，或按调用求值（宿主令牌轮换）。 */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** 跨域 cookie 场景透传 fetch credentials（如 'include'）。lib 无 DOM，用字面量联合。 */
  credentials?: 'omit' | 'same-origin' | 'include';
  /** 自定义式：完全接管请求构造（优先于 url/method/headers/credentials）。 */
  request?: (input: unknown) => { url: string; init?: RequestInit };
  /** 响应 → 工具输出文本，缺省 res.text()。 */
  mapResponse?: (res: Response) => string | Promise<string>;
}

export function defineHttpTool(spec: HttpToolSpec): RegisteredTool {
  if (!spec.request && !spec.url) {
    throw new Error(`defineHttpTool(${spec.name})：url 与 request 至少给一个`);
  }
  return {
    descriptor: {
      name: spec.name,
      kind: spec.kind ?? 'fetch',
      description: spec.description,
      inputSchema: spec.inputSchema,
      owner: 'core',
      availability: { always: true },
      approval: spec.approval ?? 'never',
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const { url, init } = buildRequest(spec, input);
        // ctx.signal 优先（内核的 turn 取消 + per-call 超时组合 signal）。
        const res = await fetch(url, { ...init, signal: ctx.signal ?? init.signal ?? null });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}${text ? `: ${truncate(text, 500)}` : ''}`);
        }
        const chunk = spec.mapResponse ? await spec.mapResponse(res) : await res.text();
        yield { kind: 'output', chunk };
      },
    },
  };
}

function buildRequest(spec: HttpToolSpec, input: unknown): { url: string; init: RequestInit } {
  if (spec.request) {
    const r = spec.request(input);
    return { url: r.url, init: r.init ?? {} };
  }
  const method = spec.method ?? 'POST';
  const headers: Record<string, string> = typeof spec.headers === 'function' ? spec.headers() : { ...(spec.headers ?? {}) };
  const init: RequestInit = { method, ...(spec.credentials ? { credentials: spec.credentials } : {}) };
  let url = spec.url as string;
  if (method === 'GET' || method === 'DELETE') {
    const params = new URLSearchParams();
    if (input && typeof input === 'object') {
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        // 嵌套对象/数组 JSON 序列化，防 String() 静默产出 "[object Object]"（审查 C3）。
        params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    init.headers = headers;
  } else {
    init.body = JSON.stringify(input ?? {});
    init.headers = { 'content-type': 'application/json', ...headers };
  }
  return { url, init };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
