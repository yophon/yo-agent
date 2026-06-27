import { describe, it, expect } from 'vitest';
import {
  AgentKernel,
  HistoryLoopBreaker,
  NoopCondenser,
  SummarizingCondenser,
  estimateMessagesTokens,
  estimateTokens,
  extractIdentifiers,
  makeProviderSummarizer,
  parseHandoffSections,
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

const asText = (content: CanonMessage['content']): string =>
  typeof content === 'string' ? content : content.map((b) => ('text' in b ? b.text : '')).join('\n');

describe('3D — 标识符提取（extractIdentifiers）', () => {
  it('抽取 UUID/path/hash/URL/error-code，过滤散文误命中', () => {
    const text =
      'see packages/kernel/src/kernel.ts and https://example.com/p?q=1 ' +
      'uuid 12345678-1234-1234-1234-123456789abc sha deadbeef123 code TS2304 errno ENOENT and/or foo';
    const ids = extractIdentifiers(text);
    expect(ids).toContain('packages/kernel/src/kernel.ts');
    expect(ids).toContain('https://example.com/p?q=1');
    expect(ids).toContain('12345678-1234-1234-1234-123456789abc');
    expect(ids).toContain('deadbeef123');
    expect(ids).toContain('TS2304');
    expect(ids).toContain('ENOENT');
    expect(ids).not.toContain('and/or'); // 单斜杠无扩展名的散文被路径过滤剔除
  });

  it('UUID 段不被误计为独立 hash（消费式去重）', () => {
    const ids = extractIdentifiers('id 12345678-1234-1234-1234-123456789abc done');
    expect(ids).toEqual(['12345678-1234-1234-1234-123456789abc']);
  });

  it('URL 内路径段不重复计入', () => {
    const ids = extractIdentifiers('open https://example.com/a/b/c.html now');
    expect(ids).toEqual(['https://example.com/a/b/c.html']);
  });
});

describe('3D — 四节交接解析（parseHandoffSections）', () => {
  it('解析 ## 目标/已发生/当前状态/下一步 四节', () => {
    const h = parseHandoffSections('## 目标\nG1\n\n## 已发生\nH1\n\n## 当前状态\nC1\n\n## 下一步\nN1');
    expect(h).toEqual({ goal: 'G1', whatHappened: 'H1', currentState: 'C1', nextSteps: 'N1' });
  });

  it('无可识别标题 → 回退全文塞入 whatHappened（不丢内容）', () => {
    const h = parseHandoffSections('一段没有标题的自由文本');
    expect(h.whatHappened).toBe('一段没有标题的自由文本');
    expect(h.goal).toBe('');
  });
});

describe('3D — 标识符保真机制（diff → 重试 → 回填）', () => {
  const ids = [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'packages/kernel/src/kernel.ts',
    'deadbeef123',
    'https://example.com/x',
  ];
  // keepFirst=1 → 摘要(user) 不与任何 user 相邻，content 保持 string，便于断言。
  const make = (mid: string): CanonMessage[] => [
    { role: 'system', content: 'S' },
    { role: 'user', content: `任务用到 ${ids.join(' ')}` },
    { role: 'assistant', content: mid },
    { role: 'user', content: 'more' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'tail' },
  ];
  const fourSection = (body: string) => `## 目标\nG\n## 已发生\n${body}\n## 当前状态\nC\n## 下一步\nN`;

  it('丢 2 个标识符 → 重试一次补齐（summarizer 调用 2 次，无回填段）', async () => {
    let calls = 0;
    const summarize = async (_text: string, _hint?: string) => {
      calls++;
      return calls === 1 ? fourSection(`用到 ${ids[0]} ${ids[1]} ${ids[2]}`) : fourSection(`全部 ${ids.join(' ')}`);
    };
    const c = new SummarizingCondenser({ summarize, keepFirst: 1, keepTail: 2 });
    const out = await c.condense(make('m'));
    expect(calls).toBe(2); // 首版缺 2 个 → 触发一次重试
    const summary = asText(out.find((m) => m.role === 'user' && asText(m.content).includes('结构化交接'))!.content);
    for (const id of ids) expect(summary).toContain(id); // 最终逐字含全部
    expect(summary).not.toContain('自动回填'); // 重试补齐 → 无需回填段
  });

  it('重试仍丢 → 确定性回填段保证逐字含全部标识符', async () => {
    let calls = 0;
    const summarize = async () => {
      calls++;
      return fourSection(`只提 ${ids[0]} ${ids[1]} ${ids[2]}`); // 恒丢 ids[3]/ids[4]
    };
    const c = new SummarizingCondenser({ summarize, keepFirst: 1, keepTail: 2, maxIdentifierRetries: 1 });
    const out = await c.condense(make('m'));
    expect(calls).toBe(2); // 1 次首发 + 1 次重试
    const summary = asText(out.find((m) => m.role === 'user' && asText(m.content).includes('结构化交接'))!.content);
    expect(summary).toContain('自动回填');
    for (const id of ids) expect(summary).toContain(id); // 回填后逐字含全部 5 个
  });

  it('onHandoff 回传四节交接 + 全量保真标识符', async () => {
    const summarize = async () => fourSection(`含 ${ids.join(' ')}`);
    const c = new SummarizingCondenser({ summarize, keepFirst: 1, keepTail: 2 });
    let captured: { goal: string; preserved: string[] } | null = null;
    await c.condense(make('m'), {
      onHandoff: (h, preserved) => {
        captured = { goal: h.goal, preserved };
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.goal).toBe('G');
    for (const id of ids) expect(captured!.preserved).toContain(id);
  });

  it('中段无标识符 → onHandoff 仍回传交接、preserved 为空', async () => {
    const summarize = async () => fourSection('无标识符的普通描述');
    const c = new SummarizingCondenser({ summarize, keepFirst: 1, keepTail: 2 });
    let preserved: string[] | null = null;
    const msgs: CanonMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: '普通任务' },
      { role: 'assistant', content: '普通回复无标识符' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'tail' },
    ];
    await c.condense(msgs, { onHandoff: (_h, p) => (preserved = p) });
    expect(preserved).toEqual([]);
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

  it('ContextCompacted 落库带结构化 handoffSummary（3D）', async () => {
    const store = new MemoryEventStore();
    const provider = new FakeProvider();
    const tools = new InMemoryToolRegistry();
    const echo: RegisteredTool = {
      descriptor: { name: 'echo', kind: 'other', description: 'e', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval: 'never' },
      executor: { async *execute(input) { yield { kind: 'output', chunk: 'y'.repeat(200) + JSON.stringify(input) }; } },
    };
    tools.register(echo);
    // 固定四节摘要：内核 onHandoff 应捕获并落 ContextCompacted.handoffSummary。
    const summarize = async () => '## 目标\nG\n## 已发生\nH\n## 当前状态\nC\n## 下一步\nN';
    const condenser: Condenser = new SummarizingCondenser({ summarize, thresholdRatio: 0.8, keepFirst: 1, keepTail: 1 });
    const kernel = new AgentKernel({ store, provider, tools, loopBreaker: new HistoryLoopBreaker(), condenser, usableContextTokens: 20, minStepsBetweenCompact: 1 });
    provider.script(toolCallTurn('echo', 'a', { i: 1 }));
    provider.script(toolCallTurn('echo', 'b', { i: 2 }));
    provider.script(textTurn('done'));
    const events: AgentEvent[] = [];
    const sessionId = await kernel.startSession({ system: 'SYS' });
    kernel.subscribe(sessionId, null, (env: EventEnvelope) => events.push(env.event));
    await kernel.submitInput(sessionId, 'go', 'k1');
    const c = events.find((e) => e.kind === 'ContextCompacted');
    expect(c).toBeDefined();
    if (c?.kind === 'ContextCompacted') {
      expect(c.handoffSummary).toEqual({ goal: 'G', whatHappened: 'H', currentState: 'C', nextSteps: 'N' });
    }
  });

  it('minStepsBetweenCompact guard 阻止刚压缩后立即再压（3D 校准）', async () => {
    // 同 "超阈值触发压缩" 场景，但 minSteps 远大于本 turn 步数 → guard 恒阻止，全程无 ContextCompacted。
    const store = new MemoryEventStore();
    const provider = new FakeProvider();
    const tools = new InMemoryToolRegistry();
    const echo: RegisteredTool = {
      descriptor: { name: 'echo', kind: 'other', description: 'e', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval: 'never' },
      executor: { async *execute(input) { yield { kind: 'output', chunk: 'x'.repeat(200) + JSON.stringify(input) }; } },
    };
    tools.register(echo);
    const condenser: Condenser = new SummarizingCondenser({ summarize: async () => '摘要', thresholdRatio: 0.8, keepFirst: 1, keepTail: 1 });
    const kernel = new AgentKernel({ store, provider, tools, loopBreaker: new HistoryLoopBreaker(), condenser, usableContextTokens: 20, minStepsBetweenCompact: 100 });
    provider.script(toolCallTurn('echo', 'a', { i: 1 }));
    provider.script(toolCallTurn('echo', 'b', { i: 2 }));
    provider.script(textTurn('done'));
    const events: AgentEvent[] = [];
    const sessionId = await kernel.startSession({ system: 'SYS' });
    kernel.subscribe(sessionId, null, (env: EventEnvelope) => events.push(env.event));
    await kernel.submitInput(sessionId, 'go', 'k1');
    expect(events.some((e) => e.kind === 'ContextCompacted')).toBe(false); // guard 全程阻止
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
