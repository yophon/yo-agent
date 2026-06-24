import { describe, it, expect } from 'vitest';
import { ResponsesSseDecoder, buildResponsesBody, type ProviderEvent } from '@yo-agent/provider';

describe('buildResponsesBody', () => {
  it('system → instructions；tools 顶层 name；assistant tool_use → function_call item；tool → function_call_output', () => {
    const body = buildResponsesBody(
      {
        modelId: 'gpt-4o',
        system: '你是助手',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }] },
          { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'ok' }] },
        ],
        tools: [{ name: 'read', description: '读', jsonSchema: { type: 'object' } }],
        effort: 'high',
      },
      16_000,
    );
    expect(body.instructions).toBe('你是助手');
    expect(body.stream).toBe(true);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'function', name: 'read' });
    expect(body.reasoning).toEqual({ effort: 'high' });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
    expect(input[1]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'read', arguments: JSON.stringify({ path: 'a' }) });
    expect(input[2]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'ok' });
  });

  it('effort xhigh/max 降到 reasoning.effort=high（Responses 无 xhigh）', () => {
    const body = buildResponsesBody({ modelId: 'o3', messages: [], tools: [], effort: 'xhigh' }, 16_000);
    expect(body.reasoning).toEqual({ effort: 'high' });
  });
});

describe('ResponsesSseDecoder', () => {
  it('output_text.delta → TextDelta；function_call 流式 → Start/ArgsDelta/End；completed → usage + Stop(tool_use)', () => {
    const d = new ResponsesSseDecoder();
    const out: ProviderEvent[] = [
      ...d.push({ type: 'response.output_text.delta', delta: '你好' }),
      ...d.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read' } }),
      ...d.push({ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"path":' }),
      ...d.push({ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '"a.ts"}' }),
      ...d.push({ type: 'response.output_item.done', item: { type: 'function_call', id: 'item_1', call_id: 'call_1' } }),
      ...d.push({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 6 } } }),
    ];
    expect(out).toContainEqual({ kind: 'TextDelta', text: '你好' });
    expect(out).toContainEqual({ kind: 'ToolCallStart', id: 'call_1', name: 'read' });
    const args = out
      .filter((e): e is Extract<ProviderEvent, { kind: 'ToolCallArgsDelta' }> => e.kind === 'ToolCallArgsDelta')
      .map((e) => e.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.ts' });
    expect(out).toContainEqual({ kind: 'ToolCallEnd', id: 'call_1' });
    expect(out.find((e) => e.kind === 'UsageUpdate')).toMatchObject({ usage: { inputTokens: 12, outputTokens: 6 } });
    expect(out.find((e) => e.kind === 'Stop')).toEqual({ kind: 'Stop', reason: 'tool_use' });
  });

  it('incomplete + max_output_tokens → Stop(max_tokens)', () => {
    const d = new ResponsesSseDecoder();
    const out = [
      ...d.push({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
    ];
    expect(out.find((e) => e.kind === 'Stop')).toEqual({ kind: 'Stop', reason: 'max_tokens' });
  });

  it('纯文本 completed → Stop(end_turn)；cached_tokens → cacheReadTokens', () => {
    const d = new ResponsesSseDecoder();
    const out = [
      ...d.push({ type: 'response.output_text.delta', delta: 'x' }),
      ...d.push({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } },
      }),
    ];
    expect(out.find((e) => e.kind === 'UsageUpdate')).toMatchObject({ usage: { cacheReadTokens: 3 } });
    expect(out.find((e) => e.kind === 'Stop')).toEqual({ kind: 'Stop', reason: 'end_turn' });
  });
});
