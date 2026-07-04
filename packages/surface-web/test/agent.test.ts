import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@yo-agent/protocol';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { createWebAgent, defineHttpTool } from '@yo-agent/surface-web';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWebAgent（浏览器组合根）', () => {
  it('零工具纯对话（模式 B 形态）：一轮流式回答跑通', async () => {
    const provider = new FakeProvider().script(textTurn('你好，有什么可以帮你？'));
    const agent = createWebAgent({
      connection: { provider: 'openai', model: 'fake-model', baseUrl: 'https://relay.example/v1', apiKey: 'k' },
      providerOverride: provider,
    });
    const sid = await agent.startSession();
    const kinds: string[] = [];
    agent.kernel.subscribe(sid, null, (env: EventEnvelope) => kinds.push(env.event.kind));
    await agent.kernel.submitInput(sid, '在吗', 'idem-1');
    expect(kinds).toContain('AssistantText');
    expect(kinds).toContain('TurnCompleted');
  });

  it('HTTP 工具全链路：LLM 调工具 → fetch 后端 → 结果回填 → 二轮作答；risk-based 工具经缺省 auto 审批放行', async () => {
    const fetchMock = vi.fn(async () => new Response('{"orderId":"42","status":"已发货"}'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FakeProvider()
      .script(toolCallTurn('order_query', 't1', { orderId: '42' }))
      .script(textTurn('您的订单 42 已发货'));
    const agent = createWebAgent({
      connection: { provider: 'anthropic', model: 'fake-model', baseUrl: 'https://api.example.com/llm' },
      providerOverride: provider,
      system: '你是客服',
      tools: [
        defineHttpTool({
          name: 'order_query',
          description: '查订单',
          inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
          url: 'https://api.example.com/tools/order_query',
          approval: 'risk-based', // 走 PolicyEngine 'ask' → 缺省 autoApproveGate 放行
        }),
      ],
    });
    const sid = await agent.startSession();
    const events: EventEnvelope[] = [];
    agent.kernel.subscribe(sid, null, (env) => events.push(env));
    await agent.kernel.submitInput(sid, '订单 42 到哪了', 'idem-1');

    const kinds = events.map((e) => e.event.kind);
    expect(kinds).toContain('ToolCallStarted');
    expect(kinds).toContain('ToolCallCompleted');
    expect(kinds).toContain('TurnCompleted');
    expect(kinds).not.toContain('TurnFailed');
    // fetch 打到了后端工具端点，入参来自 LLM 的 tool_call
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe('{"orderId":"42"}');
    // 工具结果进了第二轮请求的消息窗口（provider 收到两次请求）
    expect(provider.seen.length).toBe(2);
    // system 注入生效
    expect(JSON.stringify(provider.seen[0]?.messages?.[0] ?? '')).toContain('你是客服');
  });

  it('parallel 批量工具：有工具时自动注册并可内联展开（两个子调用并发 fetch）；零工具时不注册', async () => {
    const fetchMock = vi.fn(
      async (url: string, init?: RequestInit) =>
        new Response(JSON.stringify({ echo: JSON.parse((init?.body as string) ?? '{}') })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FakeProvider()
      .script(
        toolCallTurn('parallel', 't1', {
          calls: [
            { tool: 'order_query', input: { orderId: '42' } },
            { tool: 'order_query', input: { orderId: '7' } },
          ],
        }),
      )
      .script(textTurn('42 已发货，7 已签收'));
    const agent = createWebAgent({
      connection: { provider: 'anthropic', model: 'fake-model', baseUrl: 'https://api.example.com/llm' },
      providerOverride: provider,
      tools: [
        defineHttpTool({
          name: 'order_query',
          description: '查订单',
          inputSchema: { type: 'object' },
          url: 'https://api.example.com/tools/order_query',
        }),
      ],
    });
    const sid = await agent.startSession();
    const events: EventEnvelope[] = [];
    agent.kernel.subscribe(sid, null, (env) => events.push(env));
    await agent.kernel.submitInput(sid, '同时查订单 42 和 7', 'idem-1');
    // parallel 对 LLM 可见
    expect(provider.seen[0]?.tools?.some((t) => t.name === 'parallel')).toBe(true);
    // 两个子调用都真的打到了后端
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) => c[1]?.body);
    expect(bodies).toContain('{"orderId":"42"}');
    expect(bodies).toContain('{"orderId":"7"}');
    expect(events.map((e) => e.event.kind)).toContain('TurnCompleted');
    expect(events.map((e) => e.event.kind)).not.toContain('TurnFailed');

    // 零工具：parallel 不注册（纯对话无对象）
    const bare = createWebAgent({
      connection: { provider: 'openai', model: 'fake-model', baseUrl: 'https://relay.example/v1', apiKey: 'k' },
      providerOverride: new FakeProvider().script(textTurn('好')),
    });
    const sid2 = await bare.startSession();
    const reg = bare.tools.resolveAvailable({ sessionId: sid2, cwd: '/' });
    expect(reg.some((d) => d.name === 'parallel')).toBe(false);
  });

  it('工具执行抛错 → isError tool_result，turn 不失败（LLM 可继续应对）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('内部错误', { status: 500 })));
    const provider = new FakeProvider()
      .script(toolCallTurn('order_query', 't1', { orderId: 'x' }))
      .script(textTurn('后端暂时不可用，请稍后再试'));
    const agent = createWebAgent({
      connection: { provider: 'anthropic', model: 'fake-model', baseUrl: 'https://api.example.com/llm' },
      providerOverride: provider,
      tools: [
        defineHttpTool({ name: 'order_query', description: '查订单', inputSchema: { type: 'object' }, url: 'https://api.example.com/t' }),
      ],
    });
    const sid = await agent.startSession();
    const events: EventEnvelope[] = [];
    agent.kernel.subscribe(sid, null, (env) => events.push(env));
    await agent.kernel.submitInput(sid, '查一下', 'idem-1');
    const completed = events.find((e) => e.event.kind === 'ToolCallCompleted') as
      | { event: { kind: 'ToolCallCompleted'; status: 'ok' | 'error' } }
      | undefined;
    expect(completed?.event.status).toBe('error');
    expect(events.map((e) => e.event.kind)).toContain('TurnCompleted');
  });
});
