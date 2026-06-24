import { describe, it, expect } from 'vitest';
import {
  AgentKernel,
  HistoryLoopBreaker,
  NoopCondenser,
  SummarizingCondenser,
  estimateMessagesTokens,
  estimateTokens,
  makeProviderSummarizer,
} from '@yo-agent/kernel';
import type { Condenser } from '@yo-agent/kernel';
import type { CanonMessage } from '@yo-agent/provider';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool } from '@yo-agent/tools';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';

describe('token 估算', () => {
  it('ASCII ≈ 4 字符/token，CJK 更密；空串 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('aaaa')).toBe(1);
    expect(estimateTokens('你好')).toBeGreaterThanOrEqual(1);
    const msgs: CanonMessage[] = [{ role: 'user', content: 'hello world' }];
    expect(estimateMessagesTokens(msgs)).toBeGreaterThan(0);
  });
});

describe('SummarizingCondenser', () => {
  const fakeSummarize = async (text: string) => `SUMMARY(${text.length}字符)`;

  it('shouldCompact 按阈值；usable<=0 不压', () => {
    const c = new SummarizingCondenser({ summarize: fakeSummarize, thresholdRatio: 0.8 });
    expect(c.shouldCompact({ usedTokens: 80, usableTokens: 100 })).toBe(true);
    expect(c.shouldCompact({ usedTokens: 79, usableTokens: 100 })).toBe(false);
    expect(c.shouldCompact({ usedTokens: 80, usableTokens: 0 })).toBe(false);
  });

  it('condense 保首 keepFirst + 中段摘要 + 保尾 keepTail', async () => {
    const c = new SummarizingCondenser({ summarize: fakeSummarize, keepFirst: 1, keepTail: 2 });
    const messages: CanonMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ];
    const out = await c.condense(messages);
    expect(out[0]).toEqual({ role: 'system', content: 'S' }); // 保首
    expect(out[1]!.role).toBe('user'); // 摘要
    expect(typeof out[1]!.content === 'string' && out[1]!.content).toContain('SUMMARY');
    expect(out.slice(-2)).toEqual([
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]); // 保尾
    expect(out.length).toBeLessThan(messages.length);
  });

  it('中段太短不压缩，原样返回', async () => {
    const c = new SummarizingCondenser({ summarize: fakeSummarize, keepFirst: 2, keepTail: 6 });
    const messages: CanonMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
    ];
    expect(await c.condense(messages)).toBe(messages);
  });

  it('边界保护：尾段不以孤儿 tool_result 开头', async () => {
    const c = new SummarizingCondenser({ summarize: fakeSummarize, keepFirst: 1, keepTail: 1 });
    const messages: CanonMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r1' }] },
      { role: 'assistant', content: 'done' },
    ];
    const out = await c.condense(messages);
    const last = out[out.length - 1]!;
    // 末条不应是 tool_result（被边界保护推过），最终保留正常 assistant。
    const lastIsToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    expect(lastIsToolResult).toBe(false);
  });

  it('head 边界保护：head 末不留孤儿 tool_use（keepFirst 落在 assistant(tool_use) 上时回退）', async () => {
    const c = new SummarizingCondenser({ summarize: fakeSummarize, keepFirst: 2, keepTail: 2 });
    // 无 system：[user, assistant(tool_use), user(tool_result), assistant, user] —— keepFirst=2 原本切在 assistant(tool_use)。
    const messages: CanonMessage[] = [
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r1' }] },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'u' },
    ];
    const out = await c.condense(messages);
    // 任何保留的 tool_use 必须有紧随的配对 tool_result（无孤儿）。
    for (let i = 0; i < out.length; i++) {
      const m = out[i]!;
      if (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')) {
        const next = out[i + 1];
        const paired = next && Array.isArray(next.content) && next.content.some((b) => b.type === 'tool_result');
        expect(paired).toBe(true);
      }
    }
  });

  it('相邻 user 合并：摘要(user) 与尾段首条 user 不产生两条连续 user', async () => {
    const c = new SummarizingCondenser({ summarize: fakeSummarize, keepFirst: 1, keepTail: 1 });
    const messages: CanonMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u-tail' }, // 尾段以 user 开头 → 与摘要(user)相邻
    ];
    const out = await c.condense(messages);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.role === 'user' && out[i]!.role === 'user').toBe(false);
    }
    // 摘要与尾段 user 已合并为单条（含两个文本块）。
    const merged = out.find((m) => Array.isArray(m.content) && m.content.length >= 2 && m.role === 'user');
    expect(merged).toBeDefined();
  });

  it('makeProviderSummarizer 用 provider 文本流拼摘要', async () => {
    const p = new FakeProvider();
    p.script(textTurn('结构化摘要文本'));
    const summarize = makeProviderSummarizer(p, 'cheap-model');
    expect(await summarize('一些历史')).toBe('结构化摘要文本');
    expect(p.seen[0]!.modelId).toBe('cheap-model');
  });
});

describe('Condenser 接入内核主循环', () => {
  it('超阈值触发压缩 → emit ContextCompacted，消息窗口被替换', async () => {
    const store = new MemoryEventStore();
    const provider = new FakeProvider();
    const tools = new InMemoryToolRegistry();
    const echo: RegisteredTool = {
      descriptor: { name: 'echo', kind: 'other', description: 'e', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval: 'never' },
      executor: { async *execute(input) { yield { kind: 'output', chunk: 'x'.repeat(200) + JSON.stringify(input) }; } },
    };
    tools.register(echo);
    // 极低 usable，第一步注入 observation 后必然超阈值。
    const condenser: Condenser = new SummarizingCondenser({ summarize: async () => '摘要', thresholdRatio: 0.8, keepFirst: 1, keepTail: 1 });
    const kernel = new AgentKernel({ store, provider, tools, loopBreaker: new HistoryLoopBreaker(), condenser, usableContextTokens: 20, minStepsBetweenCompact: 1 });
    // 两个工具调用步 + 收尾，制造足够长中段。
    provider.script(toolCallTurn('echo', 'a', { i: 1 }));
    provider.script(toolCallTurn('echo', 'b', { i: 2 }));
    provider.script(textTurn('done'));
    const events: AgentEvent[] = [];
    const sessionId = await kernel.startSession({ system: 'SYS' });
    kernel.subscribe(sessionId, null, (env: EventEnvelope) => events.push(env.event));
    await kernel.submitInput(sessionId, 'go', 'k1');
    const compacted = events.filter((e) => e.kind === 'ContextCompacted');
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    const c = compacted[0]!;
    expect(c.kind === 'ContextCompacted' && c.tokensSaved).toBeGreaterThanOrEqual(0);
  });

  it('NoopCondenser 恒不压缩 → 无 ContextCompacted', async () => {
    const store = new MemoryEventStore();
    const provider = new FakeProvider();
    const tools = new InMemoryToolRegistry();
    const kernel = new AgentKernel({ store, provider, tools, loopBreaker: new HistoryLoopBreaker(), condenser: new NoopCondenser(), usableContextTokens: 1 });
    provider.script(textTurn('hi'));
    const events: AgentEvent[] = [];
    const sessionId = await kernel.startSession({ system: 'SYS' });
    kernel.subscribe(sessionId, null, (env: EventEnvelope) => events.push(env.event));
    await kernel.submitInput(sessionId, 'go', 'k1');
    expect(events.some((e) => e.kind === 'ContextCompacted')).toBe(false);
  });
});
