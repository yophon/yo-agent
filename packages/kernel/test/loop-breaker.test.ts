import { describe, expect, it } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser, makeLoopBreaker, parseLoopBreakerMode } from '@yo-agent/kernel';
import type { LoopBreaker } from '@yo-agent/kernel';
import { FakeProvider, textTurn, toolCallTurn, toolCallsTurn } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool } from '@yo-agent/tools';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';

// ───────────────────────── 单元层：HistoryLoopBreaker 计重语义（4.10a）─────────────────────────

describe('HistoryLoopBreaker 批内豁免与豁免清单', () => {
  const call = (name: string, input: unknown, extra: { kind?: string; batchId?: string } = {}) => ({
    name,
    input,
    ...extra,
  });

  it('批内豁免：同 batchId 的同参重复只计 1 次，不触发熔断', () => {
    const lb = new HistoryLoopBreaker({ breakThreshold: 3, warnThreshold: 3 });
    expect(lb.check(call('spawn', { p: 'hi' }, { batchId: 'b1' }))).toBe('ok');
    expect(lb.check(call('spawn', { p: 'hi' }, { batchId: 'b1' }))).toBe('ok');
    expect(lb.check(call('spawn', { p: 'hi' }, { batchId: 'b1' }))).toBe('ok');
  });

  it('跨批仍计重：同参调用分散在不同 batch → 阈值到即熔断（真死循环护栏不拆）', () => {
    const lb = new HistoryLoopBreaker({ breakThreshold: 3, warnThreshold: 2 });
    expect(lb.check(call('poll', { q: 1 }, { batchId: 'b1' }))).toBe('ok');
    expect(lb.check(call('poll', { q: 1 }, { batchId: 'b2' }))).toBe('warn');
    expect(lb.check(call('poll', { q: 1 }, { batchId: 'b3' }))).toBe('break');
  });

  it('批内不同参不豁免影响：各 key 独立计数', () => {
    const lb = new HistoryLoopBreaker({ breakThreshold: 2, warnThreshold: 2 });
    expect(lb.check(call('t', { a: 1 }, { batchId: 'b1' }))).toBe('ok');
    expect(lb.check(call('t', { a: 2 }, { batchId: 'b1' }))).toBe('ok');
    expect(lb.check(call('t', { a: 1 }, { batchId: 'b2' }))).toBe('break');
  });

  it('无 batchId（旧调用方）：行为与 4.10 前一致，连续同参即计重', () => {
    const lb = new HistoryLoopBreaker({ breakThreshold: 3, warnThreshold: 2 });
    expect(lb.check(call('t', { x: 1 }))).toBe('ok');
    expect(lb.check(call('t', { x: 1 }))).toBe('warn');
    expect(lb.check(call('t', { x: 1 }))).toBe('break');
  });

  it('batchScoped:false（strict 档）：批内同参重复照样计重', () => {
    const lb = new HistoryLoopBreaker({ breakThreshold: 3, warnThreshold: 2, batchScoped: false });
    expect(lb.check(call('spawn', { p: 'hi' }, { batchId: 'b1' }))).toBe('ok');
    expect(lb.check(call('spawn', { p: 'hi' }, { batchId: 'b1' }))).toBe('warn');
    expect(lb.check(call('spawn', { p: 'hi' }, { batchId: 'b1' }))).toBe('break');
  });

  it('exemptTools：清单内工具永不计重', () => {
    const lb = new HistoryLoopBreaker({ breakThreshold: 2, warnThreshold: 2, exemptTools: ['subagent_spawn'] });
    for (let i = 0; i < 5; i++) {
      expect(lb.check(call('subagent_spawn', { p: 'hi' }, { batchId: `b${i}` }))).toBe('ok');
    }
    // 非豁免工具不受影响
    expect(lb.check(call('other', { p: 'hi' }, { batchId: 'x1' }))).toBe('ok');
    expect(lb.check(call('other', { p: 'hi' }, { batchId: 'x2' }))).toBe('break');
  });

  it('exemptKinds：read/search 只读类按类豁免', () => {
    const lb = new HistoryLoopBreaker({ breakThreshold: 2, warnThreshold: 2, exemptKinds: ['read', 'search'] });
    for (let i = 0; i < 5; i++) {
      expect(lb.check(call('read_file', { path: 'a' }, { kind: 'read', batchId: `b${i}` }))).toBe('ok');
    }
    expect(lb.check(call('write_file', { path: 'a' }, { kind: 'edit', batchId: 'y1' }))).toBe('ok');
    expect(lb.check(call('write_file', { path: 'a' }, { kind: 'edit', batchId: 'y2' }))).toBe('break');
  });
});

describe('makeLoopBreaker 三档行为矩阵（4.10a）', () => {
  const repeat = (lb: LoopBreaker, n: number, batchPrefix = 'b') => {
    const verdicts: string[] = [];
    for (let i = 0; i < n; i++) verdicts.push(lb.check({ name: 'echo', input: { same: 1 }, kind: 'other', batchId: `${batchPrefix}${i}` }));
    return verdicts;
  };

  it('off：任意重复全放行', () => {
    const lb = makeLoopBreaker('off');
    expect(repeat(lb, 50).every((v) => v === 'ok')).toBe(true);
  });

  it('loose：跨批同参第 5 次 warn、第 10 次 break（DESIGN §2.3 生产阈值）', () => {
    const lb = makeLoopBreaker('loose');
    const v = repeat(lb, 10);
    expect(v.slice(0, 4)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(v[4]).toBe('warn');
    expect(v[9]).toBe('break');
  });

  it('loose：subagent_spawn 与 read/search 类豁免（真机反馈场景）', () => {
    const lb = makeLoopBreaker('loose');
    for (let i = 0; i < 12; i++) {
      expect(lb.check({ name: 'subagent_spawn', input: { p: '回 hi' }, kind: 'other', batchId: `b${i}` })).toBe('ok');
    }
    for (let i = 0; i < 12; i++) {
      expect(lb.check({ name: 'grep', input: { q: 'x' }, kind: 'search', batchId: `c${i}` })).toBe('ok');
    }
  });

  it('strict：保留 4.10 前行为——批内同参也计重，第 3 次 break', () => {
    const lb = makeLoopBreaker('strict');
    const v = [
      lb.check({ name: 'echo', input: { same: 1 }, batchId: 'b1' }),
      lb.check({ name: 'echo', input: { same: 1 }, batchId: 'b1' }),
      lb.check({ name: 'echo', input: { same: 1 }, batchId: 'b1' }),
    ];
    expect(v).toEqual(['ok', 'warn', 'break']);
  });

  it('parseLoopBreakerMode：合法值透传，非法/缺省回 undefined', () => {
    expect(parseLoopBreakerMode('off')).toBe('off');
    expect(parseLoopBreakerMode('loose')).toBe('loose');
    expect(parseLoopBreakerMode('strict')).toBe('strict');
    expect(parseLoopBreakerMode('on')).toBeUndefined();
    expect(parseLoopBreakerMode(undefined)).toBeUndefined();
  });
});

// ───────────────────────── 内核层：批内豁免 + warn 注入（4.10a）─────────────────────────

function echoTool(calls: unknown[]): RegisteredTool {
  return {
    descriptor: {
      name: 'echo',
      kind: 'other',
      description: 'echo',
      inputSchema: { type: 'object' },
      owner: 'core',
      availability: { always: true },
      approval: 'never',
    },
    executor: {
      async *execute(input) {
        calls.push(input);
        yield { kind: 'output', chunk: 'ok' };
      },
    },
  };
}

function harness(loopBreaker: LoopBreaker) {
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  const calls: unknown[] = [];
  tools.register(echoTool(calls));
  const kernel = new AgentKernel({ store, provider, tools, loopBreaker, condenser: new NoopCondenser() });
  return { kernel, provider, calls };
}

async function drive(h: ReturnType<typeof harness>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
  h.kernel.subscribe(sid, null, (env: EventEnvelope) => events.push(env.event));
  await h.kernel.submitInput(sid, 'go', 'k1');
  return events;
}

describe('AgentKernel × 4.10a（批内豁免 + warn 状态提醒）', () => {
  it('同批 3 个同参调用不熔断，全部执行（真机误伤场景修复）', async () => {
    const h = harness(new HistoryLoopBreaker({ breakThreshold: 3, warnThreshold: 3 }));
    h.provider.script(
      toolCallsTurn([
        { name: 'echo', id: 'tu1', input: { p: 'hi' } },
        { name: 'echo', id: 'tu2', input: { p: 'hi' } },
        { name: 'echo', id: 'tu3', input: { p: 'hi' } },
      ]),
    );
    h.provider.script(textTurn('done'));
    const events = await drive(h);
    expect(h.calls).toHaveLength(3);
    const done = events.find((e) => e.kind === 'TurnCompleted');
    expect(done && 'stopReason' in done ? done.stopReason : null).toBe('end_turn');
  });

  it('跨 step 同参重复到 break 阈值仍熔断（护栏不拆）', async () => {
    const h = harness(new HistoryLoopBreaker({ breakThreshold: 3, warnThreshold: 2 }));
    for (let i = 0; i < 4; i++) h.provider.script(toolCallTurn('echo', `tu${i}`, { same: true }));
    const events = await drive(h);
    const done = events.find((e) => e.kind === 'TurnCompleted');
    expect(done && 'stopReason' in done ? done.stopReason : null).toBe('loop_detected');
    expect(h.calls).toHaveLength(2); // warn 的第 2 次仍执行，第 3 次 break 前拦下
  });

  it('warn 注入状态提醒：下一 step 消息窗口出现重复调用提醒，且同文去重', async () => {
    const h = harness(new HistoryLoopBreaker({ breakThreshold: 99, warnThreshold: 2 }));
    for (let i = 0; i < 3; i++) h.provider.script(toolCallTurn('echo', `tu${i}`, { same: true }));
    h.provider.script(textTurn('done'));
    await drive(h);
    // 第 2 次调用（step2）warn → 提醒并入 step3 的推理窗口
    const step3 = JSON.stringify(h.provider.seen[2]!.messages);
    expect(step3).toContain('反复以相同参数调用工具 echo');
    // 同文去重：step3 的窗口里提醒只出现一次（step2/step3 连续 warn 不叠加重复行）
    const step4 = JSON.stringify(h.provider.seen[3]!.messages);
    expect(step4.split('反复以相同参数调用工具 echo').length - 1).toBeLessThanOrEqual(2); // 历史里至多留存两条独立提醒
    expect(h.calls).toHaveLength(3); // warn 不中止执行
  });

  it('off 档经内核全放行：大量同参重复不熔断', async () => {
    const h = harness(makeLoopBreaker('off'));
    for (let i = 0; i < 6; i++) h.provider.script(toolCallTurn('echo', `tu${i}`, { same: true }));
    h.provider.script(textTurn('done'));
    const events = await drive(h);
    expect(h.calls).toHaveLength(6);
    const done = events.find((e) => e.kind === 'TurnCompleted');
    expect(done && 'stopReason' in done ? done.stopReason : null).toBe('end_turn');
  });
});
