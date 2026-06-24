import { describe, it, expect } from 'vitest';
import { OpenAiSseDecoder, buildOpenAiBody, type ProviderEvent } from '@yo-agent/provider';

describe('OpenAiSseDecoder', () => {
  it('解码文本 + 流式工具调用 + finish + usage', () => {
    const d = new OpenAiSseDecoder();
    const out: ProviderEvent[] = [
      ...d.push({ choices: [{ delta: { content: '你好' } }] }),
      ...d.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":' } }] } }] }),
      ...d.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] }),
      ...d.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...d.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ];
    expect(out).toContainEqual({ kind: 'TextDelta', text: '你好' });
    expect(out).toContainEqual({ kind: 'ToolCallStart', id: 'call_1', name: 'read' });
    const args = out
      .filter((e): e is Extract<ProviderEvent, { kind: 'ToolCallArgsDelta' }> => e.kind === 'ToolCallArgsDelta')
      .map((e) => e.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.ts' });
    expect(out).toContainEqual({ kind: 'ToolCallEnd', id: 'call_1' });
    expect(out.find((e) => e.kind === 'Stop')).toEqual({ kind: 'Stop', reason: 'tool_use' });
    expect(out.find((e) => e.kind === 'UsageUpdate')).toBeDefined();
  });
});

describe('buildOpenAiBody', () => {
  it('tools → function 包装；system 合并；stream_options', () => {
    const body = buildOpenAiBody(
      { modelId: 'gpt-4o', system: '你是助手', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read', description: '读', jsonSchema: { type: 'object' } }] },
      16_000,
    );
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'function', function: { name: 'read' } });
  });

  it('assistant tool_use + tool 消息 → tool_calls / role:tool', () => {
    const body = buildOpenAiBody(
      {
        modelId: 'm',
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }] },
          { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'ok' }] },
        ],
        tools: [],
      },
      16_000,
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    const asst = messages.find((m) => m.role === 'assistant') as { tool_calls: Array<Record<string, unknown>> };
    expect(asst.tool_calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'read' } });
    expect(messages.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'call_1', content: 'ok' });
  });

  it('内核风格 role:user + tool_result 块 → 独立 role:tool 消息（不被丢弃、不发空 user）', () => {
    // 内核 observation 以 { role:'user', content:[tool_result...] } 回填（Anthropic 风格）。
    const body = buildOpenAiBody(
      {
        modelId: 'm',
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'ls', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'a.ts\nb.ts', name: 'ls' }] },
        ],
        tools: [],
      },
      16_000,
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ tool_call_id: 'call_1', content: 'a.ts\nb.ts' }); // 未丢弃
    // 不应产生承载该 tool_result 的空 user 消息。
    expect(messages.filter((m) => m.role === 'user' && m.content === null)).toHaveLength(0);
  });
});
