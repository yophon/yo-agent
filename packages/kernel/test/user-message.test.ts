import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@yo-agent/protocol';
import { AgentKernel, NoopCondenser, makeLoopBreaker } from '@yo-agent/kernel';
import { FakeProvider, textTurn } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';

function makeKernel(opts: { agentProfile?: string; provider?: FakeProvider; store?: MemoryEventStore } = {}) {
  const store = opts.store ?? new MemoryEventStore();
  const kernel = new AgentKernel({
    store,
    provider: opts.provider ?? new FakeProvider().script(textTurn('好')),
    tools: new InMemoryToolRegistry(),
    loopBreaker: makeLoopBreaker('loose'),
    condenser: new NoopCondenser(),
    model: 'fake-model',
    cwd: '/',
    agentProfile: opts.agentProfile,
  });
  return { kernel, store };
}

describe('UserMessage 事件 + agentProfile 注入（5.1b）', () => {
  it('submitInput：TurnStarted 后紧跟 UserMessage{source:prompt}，带 turnId——回放可重建用户气泡', async () => {
    const { kernel } = makeKernel();
    const sid = await kernel.startSession();
    const events: EventEnvelope[] = [];
    kernel.subscribe(sid, null, (env) => events.push(env));
    const { turnId } = await kernel.submitInput(sid, '订单 42 到哪了', 'k1');
    const kinds = events.map((e) => e.event.kind);
    expect(kinds.indexOf('UserMessage')).toBe(kinds.indexOf('TurnStarted') + 1);
    const um = events.find((e) => e.event.kind === 'UserMessage');
    expect(um?.event).toEqual({ kind: 'UserMessage', text: '订单 42 到哪了', source: 'prompt' });
    expect(um?.turnId).toBe(turnId);
  });

  it('steer：落 UserMessage{source:steer} 进事件流', async () => {
    const { kernel } = makeKernel();
    const sid = await kernel.startSession();
    const events: EventEnvelope[] = [];
    kernel.subscribe(sid, null, (env) => events.push(env));
    await kernel.steer(sid, '要发顺丰');
    expect(events.map((e) => e.event)).toContainEqual({ kind: 'UserMessage', text: '要发顺丰', source: 'steer' });
  });

  it('agentProfile 注入：会话行标注归属；缺省仍是 default（行为不变）', async () => {
    const { kernel, store } = makeKernel({ agentProfile: 'agent-售后' });
    const sid = await kernel.startSession();
    await kernel.submitInput(sid, 'hi', 'k1');
    expect((await store.getSession(sid))?.agentProfile).toBe('agent-售后');

    const plain = makeKernel();
    const sid2 = await plain.kernel.startSession();
    await plain.kernel.submitInput(sid2, 'hi', 'k1');
    expect((await plain.store.getSession(sid2))?.agentProfile).toBe('default');
  });
});
