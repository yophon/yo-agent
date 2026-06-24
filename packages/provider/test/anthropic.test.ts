import { describe, it, expect } from 'vitest';
import { AnthropicSseDecoder, buildAnthropicBody, type ProviderEvent } from '@yo-agent/provider';

describe('AnthropicSseDecoder', () => {
  it('解码文本 + 工具调用 + 停止/用量', () => {
    const d = new AnthropicSseDecoder();
    const out: ProviderEvent[] = [
      ...d.push({ type: 'message_start' }),
      ...d.push({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      ...d.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
      ...d.push({ type: 'content_block_stop', index: 0 }),
      ...d.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read' } }),
      ...d.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      ...d.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }),
      ...d.push({ type: 'content_block_stop', index: 1 }),
      ...d.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 5 } }),
      ...d.push({ type: 'message_stop' }),
    ];
    expect(out).toContainEqual({ kind: 'TextDelta', text: '你好' });
    expect(out).toContainEqual({ kind: 'ToolCallStart', id: 'tu_1', name: 'read' });
    const args = out
      .filter((e): e is Extract<ProviderEvent, { kind: 'ToolCallArgsDelta' }> => e.kind === 'ToolCallArgsDelta')
      .map((e) => e.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.ts' });
    expect(out).toContainEqual({ kind: 'ToolCallEnd', id: 'tu_1' });
    expect(out.find((e) => e.kind === 'Stop')).toEqual({ kind: 'Stop', reason: 'tool_use' });
    expect(out.find((e) => e.kind === 'UsageUpdate')).toBeDefined();
  });
});

describe('buildAnthropicBody', () => {
  it('effort 译为 output_config.effort，不发 budget_tokens / temperature', () => {
    const body = buildAnthropicBody(
      { modelId: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }], tools: [], effort: 'xhigh' },
      16_000,
    );
    expect(body.output_config).toEqual({ effort: 'xhigh' });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it('system 消息抽到顶层 system；tool 消息映射为 user + tool_result', () => {
    const body = buildAnthropicBody(
      {
        modelId: 'm',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: 'hi' },
          { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'ok' }] },
        ],
        tools: [],
      },
      16_000,
    );
    expect(body.system).toBe('你是助手');
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(2);
    const toolMsg = messages[1]!;
    expect(toolMsg.role).toBe('user');
    expect((toolMsg.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
    });
  });
});
