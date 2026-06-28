import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import type { Condenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry, readTool } from '@yo-agent/tools';
import { FakeProvider, errorTurn, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { ProviderEvent } from '@yo-agent/provider';
import type { AgentEvent } from '@yo-agent/protocol';

interface Harness {
  kernel: AgentKernel;
  primary: FakeProvider;
  backup: FakeProvider;
  run(prompt?: string): Promise<AgentEvent[]>;
}

function harness(opts: { withFallback?: boolean; condenser?: Condenser; system?: string } = {}): Harness {
  const primary = new FakeProvider();
  const backup = new FakeProvider();
  const registry = new InMemoryToolRegistry();
  registry.register(readTool);
  const kernel = new AgentKernel({
    store: new MemoryEventStore(),
    provider: primary,
    tools: registry,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: opts.condenser ?? new NoopCondenser(),
    model: 'primary',
    cwd: '/work',
    ...(opts.withFallback ? { fallbacks: [{ provider: backup, model: 'backup' }] } : {}),
  });
  let sid = '';
  const events: AgentEvent[] = [];
  return {
    kernel,
    primary,
    backup,
    async run(prompt = 'go'): Promise<AgentEvent[]> {
      if (!sid) sid = await kernel.startSession(opts.system ? { system: opts.system } : {});
      events.length = 0;
      kernel.subscribe(sid, null, (env) => events.push(env.event));
      await kernel.submitInput(sid, prompt, `k-${events.length}-${prompt}`);
      return events;
    },
  };
}

const kinds = (evs: AgentEvent[]): string[] => evs.map((e) => e.kind);
const text = (evs: AgentEvent[]): string =>
  evs.filter((e): e is Extract<AgentEvent, { kind: 'AssistantText' }> => e.kind === 'AssistantText').map((e) => e.delta ?? '').join('');

describe('4F — provider fallback / auth rotation', () => {
  it('rate_limit → 换路由（备用 provider 接手成功）', async () => {
    const h = harness({ withFallback: true });
    h.primary.script(errorTurn('429', { category: 'rate_limit' }));
    h.backup.script(textTurn('备用应答'));
    const evs = await h.run();
    expect(h.backup.seen).toHaveLength(1);
    expect(h.backup.seen[0]!.modelId).toBe('backup');
    expect(kinds(evs)).toContain('TurnCompleted');
    expect(kinds(evs)).not.toContain('TurnFailed');
    expect(text(evs)).toBe('备用应答');
  });

  it('billing/auth → 换 provider；路由粘滞（下一 turn 直接走备用）', async () => {
    const h = harness({ withFallback: true });
    h.primary.script(errorTurn('402', { category: 'billing' }));
    h.backup.script(textTurn('一'));
    await h.run('t1');
    h.backup.script(textTurn('二'));
    await h.run('t2');
    expect(h.primary.seen).toHaveLength(1); // 主路由只在第一次被试
    expect(h.backup.seen).toHaveLength(2); // 粘滞：t2 直接走备用，不回探死掉的主路由
  });

  it('context_overflow → 同模型压缩后重试（不换路由）', async () => {
    const compacting: Condenser = {
      shouldCompact: () => false,
      condense: async (msgs) => (msgs.length > 1 ? [msgs[0]!] : msgs),
    };
    const h = harness({ withFallback: true, condenser: compacting, system: '系统提示占位' });
    h.primary.script(errorTurn('context length exceeded', { category: 'context_overflow' }));
    h.primary.script(textTurn('压缩后重试成功'));
    const evs = await h.run();
    expect(h.backup.seen).toHaveLength(0); // 不换路由
    expect(h.primary.seen).toHaveLength(2); // 同模型重试
    expect(kinds(evs)).toContain('ContextCompacted');
    expect(text(evs)).toBe('压缩后重试成功');
  });

  it('已 commit（产出后）的错误不漂移：换路由被拒 → TurnFailed，备用不被调用', async () => {
    const h = harness({ withFallback: true });
    // step1：工具调用（产出 → commit 模型）；step2：rate_limit 错误 → 已 commit → fail（不换备用）
    h.primary.script(toolCallTurn('read', 'c1', { path: '/work/nope.txt' }));
    h.primary.script(errorTurn('429', { category: 'rate_limit' }));
    const evs = await h.run();
    expect(h.backup.seen).toHaveLength(0); // commit 后不漂移
    expect(kinds(evs)).toContain('TurnFailed');
  });

  it('unknown 分类 → 不盲目重试（即便有备用）', async () => {
    const h = harness({ withFallback: true });
    h.primary.script(errorTurn('某未知错误', { category: 'unknown' }));
    const evs = await h.run();
    expect(h.backup.seen).toHaveLength(0);
    const tf = evs.find((e) => e.kind === 'TurnFailed');
    expect(tf).toBeDefined();
  });

  it('无 fallback 链 + 错误 → TurnFailed（向后兼容，行为不变）', async () => {
    const h = harness({ withFallback: false });
    h.primary.script(errorTurn('boom'));
    const evs = await h.run();
    expect(kinds(evs)).toContain('Error');
    expect(kinds(evs)).toContain('TurnFailed');
  });
});

describe('4F — costUsd 串接', () => {
  it('UsageUpdate 与 TurnCompleted 经 costEstimator 填 costUsd', async () => {
    const primary = new FakeProvider();
    const registry = new InMemoryToolRegistry();
    const kernel = new AgentKernel({
      store: new MemoryEventStore(),
      provider: primary,
      tools: registry,
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      model: 'primary',
      costEstimator: (m, u) => (m === 'primary' ? (u.inputTokens + u.outputTokens) / 1_000_000 : undefined),
    });
    const usageEvent: ProviderEvent = {
      kind: 'UsageUpdate',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 },
    };
    primary.script([usageEvent, { kind: 'TextDelta', text: 'hi' }, { kind: 'Stop', reason: 'end_turn' }]);
    const sid = await kernel.startSession();
    const events: AgentEvent[] = [];
    kernel.subscribe(sid, null, (env) => events.push(env.event));
    await kernel.submitInput(sid, 'go', 'k1');

    const usage = events.find((e) => e.kind === 'UsageUpdate') as Extract<AgentEvent, { kind: 'UsageUpdate' }>;
    expect(usage.costUsd).toBeCloseTo(0.0015, 6);
    const tc = events.find((e) => e.kind === 'TurnCompleted') as Extract<AgentEvent, { kind: 'TurnCompleted' }>;
    expect(tc.costUsd).toBeCloseTo(0.0015, 6);
    expect(tc.usage.costUsd).toBeCloseTo(0.0015, 6);
  });

  it('无 costEstimator → 不填 costUsd（向后兼容）', async () => {
    const primary = new FakeProvider();
    const kernel = new AgentKernel({
      store: new MemoryEventStore(),
      provider: primary,
      tools: new InMemoryToolRegistry(),
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      model: 'primary',
    });
    primary.script(textTurn('hi'));
    const sid = await kernel.startSession();
    const events: AgentEvent[] = [];
    kernel.subscribe(sid, null, (env) => events.push(env.event));
    await kernel.submitInput(sid, 'go', 'k1');
    const tc = events.find((e) => e.kind === 'TurnCompleted') as Extract<AgentEvent, { kind: 'TurnCompleted' }>;
    expect(tc.costUsd).toBeUndefined();
  });
});
