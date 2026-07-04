import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolEvent } from '@yo-agent/tools/core';
import { defineHttpTool } from '@yo-agent/surface-web';

const ctx: ToolContext = { sessionId: 's1', cwd: '/' };

async function run(tool: ReturnType<typeof defineHttpTool>, input: unknown, c: ToolContext = ctx): Promise<ToolEvent[]> {
  const out: ToolEvent[] = [];
  for await (const e of tool.executor.execute(input, c)) out.push(e);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('defineHttpTool', () => {
  it('POST 简单式：JSON body + content-type + ctx.signal 透传', async () => {
    const fetchMock = vi.fn(async () => new Response('{"status":"shipped"}'));
    vi.stubGlobal('fetch', fetchMock);
    const tool = defineHttpTool({
      name: 'order_query',
      description: '查订单',
      inputSchema: { type: 'object' },
      url: 'https://api.example.com/tools/order_query',
      headers: { authorization: 'Bearer t' },
    });
    const abort = new AbortController();
    const out = await run(tool, { orderId: '42' }, { ...ctx, signal: abort.signal });
    expect(out).toEqual([{ kind: 'output', chunk: '{"status":"shipped"}' }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/tools/order_query');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"orderId":"42"}');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer t' });
    expect(init.signal).toBe(abort.signal);
  });

  it('GET：input 平铺进 query，无 body', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const tool = defineHttpTool({
      name: 'faq_search',
      description: '搜 FAQ',
      inputSchema: { type: 'object' },
      url: 'https://api.example.com/faq?lang=zh',
      method: 'GET',
    });
    await run(tool, { q: '退货 政策', page: 2, skip: undefined });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.example.com/faq?lang=zh&${new URLSearchParams({ q: '退货 政策', page: '2' })}`);
    expect(init.body).toBeUndefined();
  });

  it('headers 函数式：每次调用重新求值（宿主令牌轮换）', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    let token = 'a';
    const tool = defineHttpTool({
      name: 't',
      description: 'd',
      inputSchema: {},
      url: 'https://x.example/t',
      headers: () => ({ authorization: `Bearer ${token}` }),
    });
    await run(tool, {});
    token = 'b';
    await run(tool, {});
    const hdr = (i: number) => (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(hdr(0).authorization).toBe('Bearer a');
    expect(hdr(1).authorization).toBe('Bearer b');
  });

  it('!res.ok → 抛错（内核转 isError tool_result），带状态码与响应摘要', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('订单不存在', { status: 404 })));
    const tool = defineHttpTool({ name: 't', description: 'd', inputSchema: {}, url: 'https://x.example/t' });
    await expect(run(tool, {})).rejects.toThrow(/HTTP 404: 订单不存在/);
  });

  it('mapResponse 自定义响应映射', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[1,2]}')));
    const tool = defineHttpTool({
      name: 't',
      description: 'd',
      inputSchema: {},
      url: 'https://x.example/t',
      mapResponse: async (res) => `共 ${((await res.json()) as { items: number[] }).items.length} 条`,
    });
    expect(await run(tool, {})).toEqual([{ kind: 'output', chunk: '共 2 条' }]);
  });

  it('request 自定义式优先于 url/method', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const tool = defineHttpTool({
      name: 't',
      description: 'd',
      inputSchema: {},
      url: 'https://ignored.example',
      request: (input) => ({ url: `https://x.example/items/${(input as { id: string }).id}`, init: { method: 'PUT' } }),
    });
    await run(tool, { id: '7' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.example/items/7');
    expect(init.method).toBe('PUT');
  });

  it('url 与 request 都缺 → 声明期即抛', () => {
    expect(() => defineHttpTool({ name: 't', description: 'd', inputSchema: {} })).toThrow(/url 与 request 至少给一个/);
  });

  it('descriptor 缺省：kind=fetch / approval=never / availability always', () => {
    const tool = defineHttpTool({ name: 't', description: 'd', inputSchema: {}, url: 'https://x.example' });
    expect(tool.descriptor).toMatchObject({ kind: 'fetch', approval: 'never', owner: 'core', availability: { always: true } });
  });
});
