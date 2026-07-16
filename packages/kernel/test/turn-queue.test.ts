import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { EventEnvelope } from '@yo-agent/protocol';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 可控慢工具：execute 挂在外部 gate 上，用于把 turn 钉在「进行中」状态。 */
function gateTool(gate: { promise: Promise<void> }): RegisteredTool {
  return {
    descriptor: {
      name: 'gate',
      kind: 'other',
      description: 'gate',
      inputSchema: { type: 'object' },
      owner: 'core',
      availability: { always: true },
      approval: 'never',
    },
    executor: {
      async *execute() {
        await gate.promise;
        yield { kind: 'output' as const, chunk: 'opened' };
      },
    },
  };
}

function harness() {
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
  });
  return { store, provider, tools, kernel };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 起会话 + 收集全部信封。 */
async function openSession(h: ReturnType<typeof harness>) {
  const envs: EventEnvelope[] = [];
  const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
  h.kernel.subscribe(sid, null, (env) => envs.push(env));
  const kinds = (kind: string) => envs.filter((e) => e.event.kind === kind);
  return { sid, envs, kinds };
}

describe('5.3a 并发闸 — 内核 turn 队列', () => {
  it('turn 进行中 submitInput 排队串行：事件流严格线性，B 在 A 完结后才 TurnStarted', async () => {
    const h = harness();
    const gate = deferred();
    h.tools.register(gateTool(gate));
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('A 收尾'));
    h.provider.script(textTurn('B 回答'));
    const { sid, envs, kinds } = await openSession(h);

    const aP = h.kernel.submitInput(sid, '任务A', 'ka');
    await until(() => kinds('ToolCallStarted').length === 1); // A 已进 gate 工具挂住
    const bP = h.kernel.submitInput(sid, '任务B', 'kb');
    await new Promise((r) => setTimeout(r, 20));
    expect(kinds('TurnStarted')).toHaveLength(1); // B 排队未起跑

    gate.resolve();
    const [a, b] = await Promise.all([aP, bP]);
    expect(a.turnId).not.toBe(b.turnId);

    // 线性：A 的 TurnCompleted 先于 B 的 TurnStarted；turn 事件零交错。
    const lifecycle = envs.filter((e) => e.event.kind === 'TurnStarted' || e.event.kind === 'TurnCompleted');
    expect(lifecycle.map((e) => e.event.kind)).toEqual(['TurnStarted', 'TurnCompleted', 'TurnStarted', 'TurnCompleted']);
    expect(lifecycle.map((e) => e.turnId)).toEqual([a.turnId, a.turnId, b.turnId, b.turnId]);
  });

  it('beginTurn 排队预分配 turnId：立即返回，TurnStarted 在实际起跑时带同一 turnId 推送', async () => {
    const h = harness();
    const gate = deferred();
    h.tools.register(gateTool(gate));
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('A 收尾'));
    h.provider.script(textTurn('B 回答'));
    const { sid, kinds } = await openSession(h);

    const { turnId: ta } = await h.kernel.beginTurn(sid, '任务A', 'ka');
    await until(() => kinds('ToolCallStarted').length === 1);
    const { turnId: tb } = await h.kernel.beginTurn(sid, '任务B', 'kb'); // 立即返回，不等 A
    expect(tb).not.toBe(ta);
    expect(kinds('TurnStarted')).toHaveLength(1);

    gate.resolve();
    await until(() => kinds('TurnCompleted').length === 2);
    expect(kinds('TurnStarted').map((e) => e.turnId)).toEqual([ta, tb]);
  });

  it('同 idemKey 去重：命中活跃/排队 turn 返回既有 turnId，不排成重复 turn', async () => {
    const h = harness();
    const gate = deferred();
    h.tools.register(gateTool(gate));
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('A 收尾'));
    h.provider.script(textTurn('B 回答'));
    const { sid, kinds } = await openSession(h);

    const { turnId: ta } = await h.kernel.beginTurn(sid, '任务A', 'k1');
    await until(() => kinds('ToolCallStarted').length === 1);
    const retryA = await h.kernel.beginTurn(sid, '任务A', 'k1'); // 活跃命中
    expect(retryA.turnId).toBe(ta);

    const { turnId: tb } = await h.kernel.beginTurn(sid, '任务B', 'k2');
    const retryB = await h.kernel.beginTurn(sid, '任务B', 'k2'); // 排队命中
    expect(retryB.turnId).toBe(tb);

    gate.resolve();
    await until(() => kinds('TurnCompleted').length === 2);
    expect(kinds('TurnStarted')).toHaveLength(2); // 四次提交只跑两个 turn
  });

  it('interrupt 清队：排队 turn reject 且不起跑；中断后新 turn 正常', async () => {
    const h = harness();
    const gate = deferred();
    h.tools.register(gateTool(gate));
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('A 收尾'));
    h.provider.script(textTurn('C 回答'));
    const { sid, kinds } = await openSession(h);

    const aP = h.kernel.submitInput(sid, '任务A', 'ka');
    await until(() => kinds('ToolCallStarted').length === 1);
    const bP = h.kernel.submitInput(sid, '任务B', 'kb');
    await h.kernel.interrupt(sid);
    await expect(bP).rejects.toThrow('中断');

    gate.resolve();
    await aP; // A 照常收尾（中断态），不受清队影响
    expect(kinds('TurnStarted')).toHaveLength(1); // B 从未起跑

    const c = await h.kernel.submitInput(sid, '任务C', 'kc');
    expect(kinds('TurnStarted').map((e) => e.turnId)).toContain(c.turnId);
  });

  it('endSession 清队：排队 turn reject，不在已驱逐会话上起孤儿 turn', async () => {
    const h = harness();
    const gate = deferred();
    h.tools.register(gateTool(gate));
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('A 收尾'));
    const { sid, kinds } = await openSession(h);

    const aP = h.kernel.submitInput(sid, '任务A', 'ka');
    await until(() => kinds('ToolCallStarted').length === 1);
    const bP = h.kernel.submitInput(sid, '任务B', 'kb');
    h.kernel.endSession(sid);
    await expect(bP).rejects.toThrow('会话已结束');

    gate.resolve();
    await aP;
    await new Promise((r) => setTimeout(r, 20));
    expect(kinds('TurnStarted')).toHaveLength(1); // 无孤儿 drain
  });

  it('MED-2 回归：双订阅者在 TurnCompleted(end_turn) 回调内各自立即提交 → 三 turn 串行各跑一次，零交错零报错', async () => {
    const h = harness();
    h.provider.script(textTurn('T0'));
    h.provider.script(textTurn('T1'));
    h.provider.script(textTurn('T2'));
    const { sid, kinds } = await openSession(h);

    // 模拟 TUI 队列与扩展 followUp 队列的双路出队（判据一致、同一事件同步 fan-out 触发）。
    let fired1 = false;
    let fired2 = false;
    const isEndTurn = (env: EventEnvelope) => env.event.kind === 'TurnCompleted' && 'stopReason' in env.event && env.event.stopReason === 'end_turn';
    h.kernel.subscribe(sid, null, (env) => {
      if (isEndTurn(env) && !fired1) {
        fired1 = true;
        void h.kernel.submitInput(sid, '队列一跟进', 'k-f1');
      }
    });
    h.kernel.subscribe(sid, null, (env) => {
      if (isEndTurn(env) && !fired2) {
        fired2 = true;
        void h.kernel.submitInput(sid, '队列二跟进', 'k-f2');
      }
    });

    await h.kernel.submitInput(sid, '起跑', 'k0');
    await until(() => kinds('TurnCompleted').length === 3);

    const lifecycle = [...kinds('TurnStarted'), ...kinds('TurnCompleted')]
      .sort((a, b) => a.cursor - b.cursor)
      .map((e) => e.event.kind);
    expect(lifecycle).toEqual(['TurnStarted', 'TurnCompleted', 'TurnStarted', 'TurnCompleted', 'TurnStarted', 'TurnCompleted']);
    expect(kinds('TurnFailed')).toHaveLength(0);
  });
});
