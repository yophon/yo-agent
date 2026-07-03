import { describe, expect, it } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import type { ApprovalGate } from '@yo-agent/kernel';
import { FakeProvider, textTurn, toolCallsTurn } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool, ToolApproval, ToolContext } from '@yo-agent/tools';
import type { AgentEvent, EventEnvelope, ToolKind } from '@yo-agent/protocol';

// ───────────────────────── 4.10b — tool 循环批内并发 ─────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, capMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < capMs) await sleep(2);
}

function makeTool(opts: {
  name: string;
  kind: ToolKind;
  approval?: ToolApproval;
  execute: (input: unknown, ctx: ToolContext) => Promise<string>;
}): RegisteredTool {
  return {
    descriptor: {
      name: opts.name,
      kind: opts.kind,
      description: opts.name,
      inputSchema: { type: 'object' },
      owner: 'core',
      availability: { always: true },
      approval: opts.approval ?? 'never',
    },
    executor: {
      async *execute(input, ctx) {
        yield { kind: 'output', chunk: await opts.execute(input, ctx) };
      },
    },
  };
}

function harness(opts: { approvalGate?: ApprovalGate } = {}) {
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker({ breakThreshold: 99, warnThreshold: 99 }),
    condenser: new NoopCondenser(),
    approvalGate: opts.approvalGate,
  });
  return { store, provider, tools, kernel };
}

async function drive(h: ReturnType<typeof harness>): Promise<{ events: AgentEvent[]; sessionId: string }> {
  const events: AgentEvent[] = [];
  const sessionId = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
  h.kernel.subscribe(sessionId, null, (env: EventEnvelope) => events.push(env.event));
  await h.kernel.submitInput(sessionId, 'go', 'k1');
  return { events, sessionId };
}

describe('4.10b — 批内并发执行', () => {
  it('同批 3 个只读调用真并发（并发高水位=3），全部成功', async () => {
    const h = harness();
    let active = 0;
    let maxActive = 0;
    h.tools.register(
      makeTool({
        name: 'probe',
        kind: 'read',
        execute: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await waitUntil(() => active === 3, 200); // 三方会合屏障：串行执行到不了 3
          active--;
          return 'ok';
        },
      }),
    );
    h.provider.script(
      toolCallsTurn([
        { name: 'probe', id: 'tu1', input: { n: 1 } },
        { name: 'probe', id: 'tu2', input: { n: 2 } },
        { name: 'probe', id: 'tu3', input: { n: 3 } },
      ]),
    );
    h.provider.script(textTurn('done'));
    const { events } = await drive(h);
    expect(maxActive).toBe(3);
    expect(events.filter((e) => e.kind === 'ToolCallCompleted')).toHaveLength(3);
    const done = events.find((e) => e.kind === 'TurnCompleted');
    expect(done && 'stopReason' in done ? done.stopReason : null).toBe('end_turn');
  });

  it('subagent_spawn（kind=other）经默认 concurrentTools 名单并发', async () => {
    const h = harness();
    let active = 0;
    let maxActive = 0;
    h.tools.register(
      makeTool({
        name: 'subagent_spawn',
        kind: 'other',
        execute: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await waitUntil(() => active === 3, 200);
          active--;
          return 'hi';
        },
      }),
    );
    h.provider.script(
      toolCallsTurn([
        { name: 'subagent_spawn', id: 'tu1', input: { p: 'a' } },
        { name: 'subagent_spawn', id: 'tu2', input: { p: 'b' } },
        { name: 'subagent_spawn', id: 'tu3', input: { p: 'c' } },
      ]),
    );
    h.provider.script(textTurn('done'));
    await drive(h);
    expect(maxActive).toBe(3); // 真机反馈场景：并行 spawn 生效
  });

  it('tool_result 按原批次顺序回填，即使完成顺序相反', async () => {
    const h = harness();
    const doneOrder: number[] = [];
    h.tools.register(
      makeTool({
        name: 'probe',
        kind: 'read',
        execute: async (input) => {
          const n = (input as { n: number }).n;
          // n=1 等其余两个先完成，n=2 等 n=3 → 完成顺序 3,2,1
          if (n === 1) await waitUntil(() => doneOrder.length === 2);
          else if (n === 2) await waitUntil(() => doneOrder.length === 1);
          doneOrder.push(n);
          return `r${n}`;
        },
      }),
    );
    h.provider.script(
      toolCallsTurn([
        { name: 'probe', id: 'tu1', input: { n: 1 } },
        { name: 'probe', id: 'tu2', input: { n: 2 } },
        { name: 'probe', id: 'tu3', input: { n: 3 } },
      ]),
    );
    h.provider.script(textTurn('done'));
    await drive(h);
    expect(doneOrder).toEqual([3, 2, 1]); // 完成顺序确实被打乱（证明并发）
    // 第二次推理请求里回填的 tool_result 消息：仍按 tu1,tu2,tu3 原批次顺序
    const msgs = h.provider.seen[1]!.messages;
    const resultMsg = msgs.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    const blocks = Array.isArray(resultMsg?.content) ? resultMsg.content : [];
    const ids = blocks.filter((b) => b.type === 'tool_result').map((b) => (b as { toolUseId: string }).toolUseId);
    expect(ids).toEqual(['tu1', 'tu2', 'tu3']);
  });

  it('混入写类调用：写作屏障——前波只读全部完成才执行写，写完成才执行后波只读', async () => {
    const h = harness();
    const log: string[] = [];
    let readsActive = 0;
    h.tools.register(
      makeTool({
        name: 'look',
        kind: 'read',
        execute: async (input) => {
          const n = (input as { n: number }).n;
          log.push(`start:look${n}`);
          readsActive++;
          if (n === 1 || n === 2) await waitUntil(() => readsActive >= 2, 200); // r1/r2 会合，证明同波并发
          readsActive--;
          log.push(`end:look${n}`);
          return 'ok';
        },
      }),
    );
    h.tools.register(
      makeTool({
        name: 'put',
        kind: 'edit',
        execute: async () => {
          log.push('start:put');
          log.push('end:put');
          return 'ok';
        },
      }),
    );
    h.provider.script(
      toolCallsTurn([
        { name: 'look', id: 'tu1', input: { n: 1 } },
        { name: 'look', id: 'tu2', input: { n: 2 } },
        { name: 'put', id: 'tu3', input: { path: 'x' } },
        { name: 'look', id: 'tu4', input: { n: 4 } },
      ]),
    );
    h.provider.script(textTurn('done'));
    await drive(h);
    // 波 1（look1+look2 并发）：两者都 start 后才有人 end
    expect(log.indexOf('start:look2')).toBeLessThan(log.indexOf('end:look1'));
    // 写屏障：put 在两个 look 都 end 之后才 start
    expect(log.indexOf('start:put')).toBeGreaterThan(log.indexOf('end:look1'));
    expect(log.indexOf('start:put')).toBeGreaterThan(log.indexOf('end:look2'));
    // 波 3：look4 在 put 之后
    expect(log.indexOf('start:look4')).toBeGreaterThan(log.indexOf('end:put'));
  });

  it('混入需审批调用：准入（审批）串行先行，全部批完才开始任何执行', async () => {
    const approvalLog: string[] = [];
    const gate: ApprovalGate = {
      async request(req) {
        approvalLog.push(`approve:${req.tool}`);
        return { decision: 'allow_once' };
      },
    };
    const h = harness({ approvalGate: gate });
    const log: string[] = [];
    h.tools.register(
      makeTool({
        name: 'look',
        kind: 'read',
        execute: async () => {
          log.push('exec:look');
          return 'ok';
        },
      }),
    );
    h.tools.register(
      makeTool({
        name: 'danger',
        kind: 'execute',
        approval: 'always',
        execute: async () => {
          log.push('exec:danger');
          return 'ok';
        },
      }),
    );
    h.provider.script(
      toolCallsTurn([
        { name: 'look', id: 'tu1', input: {} },
        { name: 'danger', id: 'tu2', input: {} },
      ]),
    );
    h.provider.script(textTurn('done'));
    await drive(h);
    // 两段式：danger 的审批发生在 look 执行之前（准入全部完成才进执行阶段）
    expect(approvalLog).toEqual(['approve:danger']);
    expect(log).toEqual(['exec:look', 'exec:danger']); // 执行仍按批次顺序（look 只读波在前）
  });

  it('中断取消在飞的并发调用：turn 以 interrupted 收尾，不挂死', async () => {
    const h = harness();
    h.tools.register(
      makeTool({
        name: 'hang',
        kind: 'read',
        execute: (_input, ctx) =>
          new Promise<string>((_resolve, reject) => {
            // 规范 executor：先查已 abort 态再挂监听（MCP callTool 同款契约）
            if (ctx.signal?.aborted) return reject(new Error('aborted'));
            ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      }),
    );
    h.provider.script(
      toolCallsTurn([
        { name: 'hang', id: 'tu1', input: { n: 1 } },
        { name: 'hang', id: 'tu2', input: { n: 2 } },
      ]),
    );
    const events: AgentEvent[] = [];
    const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    h.kernel.subscribe(sid, null, (env: EventEnvelope) => {
      events.push(env.event);
      if (env.event.kind === 'ToolCallStarted' && env.event.id === 'tu2') void h.kernel.interrupt(sid);
    });
    await h.kernel.submitInput(sid, 'go', 'k1');
    const done = events.find((e) => e.kind === 'TurnCompleted');
    expect(done && 'stopReason' in done ? done.stopReason : null).toBe('interrupted');
  }, 5000);
});
