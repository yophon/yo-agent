import { describe, it, expect } from 'vitest';
import {
  FakeProvider,
  PromptShimProvider,
  encodeToolsAsPrompt,
  nativeStrategy,
  parseToolCallsFromText,
  promptShimStrategy,
  selectStrategy,
  type ProviderEvent,
} from '@yo-agent/provider';

const tools = [{ name: 'read', description: '读文件', jsonSchema: { type: 'object', properties: { path: { type: 'string' } } } }];

describe('encode/parse 纯函数', () => {
  it('encodeToolsAsPrompt 含工具名 + schema', () => {
    const p = encodeToolsAsPrompt(tools);
    expect(p).toContain('read');
    expect(p).toContain('tool_call');
    expect(p).toContain('"path"');
  });

  it('parseToolCallsFromText 提取 tool_call 块 + 干净文本，容错坏块', () => {
    const text = '我来读文件。\n```tool_call\n{"name":"read","arguments":{"path":"a.ts"}}\n```\n好的\n```tool_call\n坏的json\n```';
    const { calls, cleanedText } = parseToolCallsFromText(text);
    expect(calls).toEqual([{ name: 'read', arguments: { path: 'a.ts' } }]);
    expect(cleanedText).not.toContain('tool_call');
    expect(cleanedText).toContain('我来读文件');
  });

  it('max_tokens 截断：未闭合的尾部 tool_call 块被剥除，不泄漏为可见文本', () => {
    const text = '正在调用：\n```tool_call\n{"name":"read","argum'; // 截断在 JSON 中途，无收尾 ```
    const { calls, cleanedText } = parseToolCallsFromText(text);
    expect(calls).toEqual([]);
    expect(cleanedText).toBe('正在调用：'); // 未闭合块整体剥除
    expect(cleanedText).not.toContain('tool_call');
  });
});

describe('selectStrategy', () => {
  it('native 能力 → nativeStrategy；否则 promptShimStrategy', () => {
    expect(selectStrategy({ nativeToolCalling: true, thinking: false, promptCache: false, effort: false })).toBe(nativeStrategy);
    expect(selectStrategy({ nativeToolCalling: false, thinking: false, promptCache: false, effort: false })).toBe(promptShimStrategy);
  });

  it('promptShimStrategy.shimRequest 把工具注入 system、清空 native tools', () => {
    const req = promptShimStrategy.shimRequest({ modelId: 'm', messages: [], tools, system: '基底' });
    expect(req.tools).toEqual([]);
    expect(req.system).toContain('基底');
    expect(req.system).toContain('read');
  });
});

describe('PromptShimProvider', () => {
  it('base 吐 tool_call 文本 → 解析为 ToolCall* + Stop(tool_use)，干净文本另发', async () => {
    const base = new FakeProvider();
    base.script([
      { kind: 'TextDelta', text: '我来读。\n```tool_call\n{"name":"read","arguments":{"path":"a.ts"}}\n```' },
      { kind: 'Stop', reason: 'end_turn' },
    ]);
    const shim = new PromptShimProvider(base);
    expect(shim.capabilities.nativeToolCalling).toBe(true); // 对内核呈现为有 native 能力
    const out: ProviderEvent[] = [];
    for await (const ev of shim.streamChat({ modelId: 'm', messages: [{ role: 'user', content: 'hi' }], tools })) out.push(ev);
    expect(out).toContainEqual({ kind: 'TextDelta', text: '我来读。' });
    const start = out.find((e) => e.kind === 'ToolCallStart');
    expect(start).toMatchObject({ name: 'read' });
    const args = out
      .filter((e): e is Extract<ProviderEvent, { kind: 'ToolCallArgsDelta' }> => e.kind === 'ToolCallArgsDelta')
      .map((e) => e.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.ts' });
    expect(out[out.length - 1]).toEqual({ kind: 'Stop', reason: 'tool_use' });
    // base 收到的请求里 tools 应被清空、system 注入了工具声明。
    expect(base.seen[0]!.tools).toEqual([]);
    expect(base.seen[0]!.system).toContain('read');
  });

  it('无 tool_call 文本 → 原样文本 + 原 Stop', async () => {
    const base = new FakeProvider();
    base.script([{ kind: 'TextDelta', text: '普通回答' }, { kind: 'Stop', reason: 'end_turn' }]);
    const shim = new PromptShimProvider(base);
    const out: ProviderEvent[] = [];
    for await (const ev of shim.streamChat({ modelId: 'm', messages: [], tools: [] })) out.push(ev);
    expect(out).toContainEqual({ kind: 'TextDelta', text: '普通回答' });
    expect(out[out.length - 1]).toEqual({ kind: 'Stop', reason: 'end_turn' });
  });
});
