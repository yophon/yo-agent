import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import type { ApprovalGate, LoopBreaker } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool, ToolApproval } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';

function harness(opts: { approvalGate?: ApprovalGate; loopBreaker?: LoopBreaker } = {}) {
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  const calls: unknown[] = [];
  const echoTool = (approval: ToolApproval = 'never'): RegisteredTool => ({
    descriptor: {
      name: 'echo',
      kind: 'other',
      description: 'echo',
      inputSchema: { type: 'object' },
      owner: 'core',
      availability: { always: true },
      approval,
    },
    executor: {
      async *execute(input) {
        calls.push(input);
        yield { kind: 'output', chunk: `echoed:${JSON.stringify(input)}` };
      },
    },
  });
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: opts.loopBreaker ?? new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    approvalGate: opts.approvalGate,
  });
  return { store, provider, tools, kernel, calls, echoTool };
}

async function drive(
  h: ReturnType<typeof harness>,
  prompt = 'hi',
): Promise<{ events: AgentEvent[]; sessionId: string }> {
  const events: AgentEvent[] = [];
  const sessionId = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
  h.kernel.subscribe(sessionId, null, (env: EventEnvelope) => events.push(env.event));
  await h.kernel.submitInput(sessionId, prompt, 'k1');
  return { events, sessionId };
}

describe('AgentKernel turn 循环', () => {
  it('纯文本 turn：AssistantText 累积 + TurnCompleted(end_turn)', async () => {
    const h = harness();
    h.provider.script(textTurn('你好世界'));
    const { events } = await drive(h);
    const text = events
      .filter((e): e is Extract<AgentEvent, { kind: 'AssistantText' }> => e.kind === 'AssistantText')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('你好世界');
    const done = events.find((e) => e.kind === 'TurnCompleted');
    expect(done && 'stopReason' in done ? done.stopReason : null).toBe('end_turn');
  });

  it('工具调用 turn：事件溯源 + 执行 + 收尾', async () => {
    const h = harness();
    h.tools.register(h.echoTool('never'));
    h.provider.script(toolCallTurn('echo', 'tu1', { msg: 'x' }));
    h.provider.script(textTurn('done'));
    const { events } = await drive(h);
    expect(h.calls).toEqual([{ msg: 'x' }]);
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['ToolCallStarted', 'ToolCallOutput', 'ToolCallCompleted', 'TurnCompleted']),
    );
    const out = events.find((e) => e.kind === 'ToolCallOutput');
    expect(out && 'chunk' in out ? out.chunk : '').toContain('echoed');
  });

  it('死循环熔断：反复同调用 → loop_detected，且 break 前不执行', async () => {
    const h = harness({ loopBreaker: new HistoryLoopBreaker({ breakThreshold: 3 }) });
    h.tools.register(h.echoTool('never'));
    for (let i = 0; i < 4; i++) h.provider.script(toolCallTurn('echo', `tu${i}`, { same: true }));
    const { events } = await drive(h);
    const done = events.find((e) => e.kind === 'TurnCompleted');
    expect(done && 'stopReason' in done ? done.stopReason : null).toBe('loop_detected');
    expect(h.calls).toHaveLength(2); // ok + warn 执行，第 3 次 break 前拦下
  });

  it('max_tokens 自动续传：再调一次 provider，最终 end_turn，不 TurnFailed', async () => {
    const h = harness();
    h.provider.script([
      { kind: 'TextDelta', text: '部分' },
      { kind: 'Stop', reason: 'max_tokens' },
    ]);
    h.provider.script(textTurn('其余'));
    const { events } = await drive(h);
    expect(h.provider.seen).toHaveLength(2);
    const done = events.find((e) => e.kind === 'TurnCompleted');
    expect(done && 'stopReason' in done ? done.stopReason : null).toBe('end_turn');
    expect(events.filter((e) => e.kind === 'TurnFailed')).toHaveLength(0);
  });

  it('审批拒绝：工具不执行 + 发出 ApprovalRequested', async () => {
    const denyGate: ApprovalGate = { async request() { return { decision: 'reject_once' }; } };
    const h = harness({ approvalGate: denyGate });
    h.tools.register(h.echoTool('always'));
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 1 }));
    h.provider.script(textTurn('ok'));
    const { events } = await drive(h);
    expect(h.calls).toEqual([]);
    expect(events.some((e) => e.kind === 'ApprovalRequested')).toBe(true);
  });

  it('审批通过：工具执行', async () => {
    const allowGate: ApprovalGate = { async request() { return { decision: 'allow_once' }; } };
    const h = harness({ approvalGate: allowGate });
    h.tools.register(h.echoTool('always'));
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 2 }));
    h.provider.script(textTurn('ok'));
    const { events } = await drive(h);
    expect(h.calls).toEqual([{ m: 2 }]);
    expect(events.find((e) => e.kind === 'TurnCompleted')).toBeDefined();
  });

  it('resume：事件持久化、cursor 单调、可从 cursor 之后重放', async () => {
    const h = harness();
    h.provider.script(textTurn('a'));
    const { sessionId } = await drive(h);
    const all: EventEnvelope[] = [];
    for await (const e of h.store.read(sessionId)) all.push(e);
    const cursors = all.map((e) => e.cursor);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    expect(cursors[0]).toBe(0);
    const mid = cursors[Math.floor(cursors.length / 2)]!;
    const after: number[] = [];
    for await (const e of h.store.read(sessionId, mid)) after.push(e.cursor);
    expect(after.every((c) => c > mid)).toBe(true);
  });
});
