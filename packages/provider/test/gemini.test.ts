import { describe, it, expect } from 'vitest';
import {
  GeminiSseDecoder,
  buildGeminiBody,
  downgradeSchemaForGemini,
  type ProviderEvent,
} from '@yo-agent/provider';

describe('downgradeSchemaForGemini', () => {
  it('剥除不支持关键字（minLength/pattern/maximum/additionalProperties），递归 properties/items', () => {
    const down = downgradeSchemaForGemini({
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1, pattern: '^/', description: '路径' },
        n: { type: 'number', minimum: 0, maximum: 10 },
        tags: { type: 'array', items: { type: 'string', maxLength: 5 } },
      },
      required: ['path'],
    }) as Record<string, any>;
    expect(down.additionalProperties).toBeUndefined();
    expect(down.properties.path).toEqual({ type: 'string', description: '路径' });
    expect(down.properties.n).toEqual({ type: 'number' });
    expect(down.properties.tags.items).toEqual({ type: 'string' });
    expect(down.required).toEqual(['path']);
  });
});

describe('downgradeSchemaForGemini —— 组合关键字 / type 数组 / $ref', () => {
  it('剥 oneOf/allOf/not；递归 anyOf 分支剥关键字 + 过滤 null 设 nullable', () => {
    const down = downgradeSchemaForGemini({
      type: 'object',
      properties: {
        a: { oneOf: [{ type: 'string', minLength: 1 }] },
        b: { allOf: [{ type: 'number', minimum: 0 }] },
        c: { anyOf: [{ type: 'string', pattern: '^x' }, { type: 'null' }] },
      },
    }) as Record<string, any>;
    expect(down.properties.a).toEqual({}); // oneOf 整体剥除
    expect(down.properties.b).toEqual({});
    expect(down.properties.c.anyOf).toEqual([{ type: 'string' }]); // pattern 剥除，null 分支过滤
    expect(down.properties.c.nullable).toBe(true);
  });

  it('type 数组 ["string","null"] 归一为单 type + nullable', () => {
    const down = downgradeSchemaForGemini({ type: ['string', 'null'], pattern: 'x' }) as Record<string, any>;
    expect(down.type).toBe('string');
    expect(down.nullable).toBe(true);
    expect(down.pattern).toBeUndefined();
  });

  it('$ref 解引用 inline $defs；解不开退化 {type:object}', () => {
    const down = downgradeSchemaForGemini({
      type: 'object',
      properties: { user: { $ref: '#/$defs/User' } },
      $defs: { User: { type: 'object', properties: { id: { type: 'string', minLength: 1 } } } },
    }) as Record<string, any>;
    expect(down.properties.user.type).toBe('object');
    expect(down.properties.user.properties.id).toEqual({ type: 'string' }); // 解引用后递归剥 minLength
    const broken = downgradeSchemaForGemini({ $ref: '#/$defs/Missing' }) as Record<string, any>;
    expect(broken).toEqual({ type: 'object' });
  });
});

describe('buildGeminiBody', () => {
  it('functionResponse.name 用真实函数名（b.name），非合成 call id —— 多轮工具调用关联正确', () => {
    const body = buildGeminiBody(
      {
        modelId: 'gemini-2.0-flash',
        messages: [
          { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'gemini_call_1', name: 'read', content: 'ok' }] },
        ],
        tools: [],
      },
      8192,
    );
    const contents = body.contents as Array<{ parts: Array<{ functionResponse: { name: string } }> }>;
    expect(contents[0].parts[0].functionResponse.name).toBe('read'); // 不是 gemini_call_1
  });

  it('system → systemInstruction；tools → functionDeclarations(降级 schema)；tool_result → functionResponse', () => {
    const body = buildGeminiBody(
      {
        modelId: 'gemini-2.0-flash',
        system: '你是助手',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } }] },
          { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'read', content: 'ok' }] },
        ],
        tools: [{ name: 'read', description: '读', jsonSchema: { type: 'object', additionalProperties: false } }],
      },
      8192,
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: '你是助手' }] });
    const tools = body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    expect(tools[0].functionDeclarations[0]).toMatchObject({ name: 'read' });
    expect((tools[0].functionDeclarations[0].parameters as Record<string, unknown>).additionalProperties).toBeUndefined();
    const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'a' } } }] });
    expect(contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'read', response: { content: 'ok' } } }] });
  });
});

describe('GeminiSseDecoder', () => {
  it('文本 part → TextDelta；functionCall 整块 → Start+ArgsDelta+End；usage；finish=tool_use', () => {
    const d = new GeminiSseDecoder();
    const out: ProviderEvent[] = [
      ...d.push({ candidates: [{ content: { parts: [{ text: '你好' }] } }] }),
      ...d.push({ candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { path: 'a.ts' } } }] } }] }),
      ...d.push({
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      }),
    ];
    expect(out).toContainEqual({ kind: 'TextDelta', text: '你好' });
    const start = out.find((e) => e.kind === 'ToolCallStart');
    expect(start).toMatchObject({ kind: 'ToolCallStart', name: 'read' });
    const args = out
      .filter((e): e is Extract<ProviderEvent, { kind: 'ToolCallArgsDelta' }> => e.kind === 'ToolCallArgsDelta')
      .map((e) => e.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.ts' });
    expect(out.find((e) => e.kind === 'UsageUpdate')).toMatchObject({ usage: { inputTokens: 10, outputTokens: 4 } });
    // 出现过 functionCall → Stop 应为 tool_use（即便 finishReason=STOP）。
    expect(out.find((e) => e.kind === 'Stop')).toEqual({ kind: 'Stop', reason: 'tool_use' });
  });

  it('纯文本 finish=STOP → end_turn；MAX_TOKENS → max_tokens', () => {
    const d1 = new GeminiSseDecoder();
    const o1 = [...d1.push({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] })];
    expect(o1.find((e) => e.kind === 'Stop')).toEqual({ kind: 'Stop', reason: 'end_turn' });
    const d2 = new GeminiSseDecoder();
    const o2 = [...d2.push({ candidates: [{ finishReason: 'MAX_TOKENS' }] })];
    expect(o2.find((e) => e.kind === 'Stop')).toEqual({ kind: 'Stop', reason: 'max_tokens' });
  });

  it('流异常截断（无 finishReason）→ flush 兜底 Stop', () => {
    const d = new GeminiSseDecoder();
    d.push({ candidates: [{ content: { parts: [{ text: 'x' }] } }] });
    expect(d.flush()).toEqual([{ kind: 'Stop', reason: 'end_turn' }]);
  });

  it('usage：promptTokenCount 含 cached → inputTokens 减去 cached（与 estimateCost 互斥语义对齐）', () => {
    const d = new GeminiSseDecoder();
    const out = [
      ...d.push({
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 30 },
      }),
    ];
    expect(out.find((e) => e.kind === 'UsageUpdate')).toMatchObject({
      usage: { inputTokens: 70, cacheReadTokens: 30, outputTokens: 10 },
    });
  });
});
