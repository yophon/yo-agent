import { describe, it, expect } from 'vitest';
import { AnthropicSseDecoder, buildAnthropicBody, supportsAdaptiveThinking, type ProviderEvent } from '@yo-agent/provider';

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
    expect(body.thinking).toEqual({ type: 'adaptive' }); // 2026-10：adaptive 缺省；无 budget_tokens
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

describe('2026-10 刷新：thinking 块回传与 adaptive 形态', () => {
  it('decoder：thinking 块 → ThinkingStart/Delta/Signature；redacted_thinking → RedactedThinking', () => {
    const d = new AnthropicSseDecoder();
    const out: ProviderEvent[] = [
      ...d.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      ...d.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一下' } }),
      ...d.push({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_abc' } }),
      ...d.push({ type: 'content_block_stop', index: 0 }),
      ...d.push({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENC' } }),
      ...d.push({ type: 'content_block_stop', index: 1 }),
      ...d.push({ type: 'content_block_start', index: 2, content_block: { type: 'text' } }),
      ...d.push({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '答' } }),
    ];
    expect(out).toEqual([
      { kind: 'ThinkingStart' },
      { kind: 'ThinkingDelta', text: '想一下' },
      { kind: 'ThinkingSignature', signature: 'sig_abc' },
      { kind: 'RedactedThinking', data: 'ENC' },
      { kind: 'TextDelta', text: '答' },
    ]);
  });

  it('历史回放：带签名 thinking 原样回传、redacted 原样回传、无签名 thinking 丢弃；滤空补占位文本', () => {
    const body = buildAnthropicBody(
      {
        modelId: 'claude-opus-5-5',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: '想', signature: 'sig1' },
              { type: 'redacted_thinking', data: 'ENC' },
              { type: 'thinking', text: '别家 provider 的无签名思考' },
              { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'a' } },
            ],
          },
          { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'ok' }] },
          { role: 'assistant', content: [{ type: 'thinking', text: '只有无签名思考' }] },
        ],
        tools: [],
      },
      16_000,
    );
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[1]!.content).toEqual([
      { type: 'thinking', thinking: '想', signature: 'sig1' },
      { type: 'redacted_thinking', data: 'ENC' },
      { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'a' } },
    ]);
    expect(messages[3]!.content).toEqual([{ type: 'text', text: '（无内容）' }]);
  });

  it('adaptive 只发给认它的模型：5.x/4.6+ 发，4.5 及 3.x 不发；thinking:off 不发', () => {
    const mk = (modelId: string, thinking?: 'adaptive' | 'off') =>
      buildAnthropicBody({ modelId, messages: [{ role: 'user', content: 'hi' }], tools: [] }, 16_000, thinking ? { thinking } : {}).thinking;
    expect(mk('claude-opus-5-5')).toEqual({ type: 'adaptive' });
    expect(mk('claude-fable-5-1')).toEqual({ type: 'adaptive' });
    expect(mk('claude-sonnet-4-6')).toEqual({ type: 'adaptive' });
    expect(mk('claude-haiku-4-5')).toBeUndefined();
    expect(mk('claude-opus-4-5')).toBeUndefined();
    expect(mk('claude-3-5-sonnet-20241022')).toBeUndefined();
    expect(mk('claude-opus-5-5', 'off')).toBeUndefined();
    expect(supportsAdaptiveThinking('claude-sonnet-5-5')).toBe(true);
  });
});
