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

  it('交互审批：内核挂起等外部 decideApproval 唤醒 → 工具执行', async () => {
    const h = harness();
    // 直接重建一个 interactiveApproval 内核（harness 默认无此项）。
    const kernel = new AgentKernel({
      store: h.store,
      provider: h.provider,
      tools: h.tools,
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      interactiveApproval: true,
    });
    h.tools.register(h.echoTool('always'));
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 9 }));
    h.provider.script(textTurn('ok'));
    const events: AgentEvent[] = [];
    const sessionId = await kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    kernel.subscribe(sessionId, null, (env: EventEnvelope) => {
      events.push(env.event);
      if (env.event.kind === 'ApprovalRequested') {
        const requestId = env.event.requestId;
        // 延后到 pending 注册完成后再裁决（真实 UI 也是异步应答）。
        setTimeout(() => kernel.decideApproval(requestId, 'allow_once'), 0);
      }
    });
    await kernel.submitInput(sessionId, 'go', 'k1');
    expect(h.calls).toEqual([{ m: 9 }]);
    expect(events.find((e) => e.kind === 'TurnCompleted')).toBeDefined();
  });

  it('交互审批超时：到时默认 deny → 工具不执行', async () => {
    const h = harness();
    const kernel = new AgentKernel({
      store: h.store,
      provider: h.provider,
      tools: h.tools,
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      interactiveApproval: true,
      approvalTimeoutMs: 10,
    });
    h.tools.register(h.echoTool('always'));
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 1 }));
    h.provider.script(textTurn('ok'));
    const sessionId = await kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    await kernel.submitInput(sessionId, 'go', 'k1'); // 无人应答，10ms 后超时 deny
    expect(h.calls).toEqual([]);
  });

  it('交互审批：interrupt 解除挂起 → turn 返回（不永久挂起），工具不执行', async () => {
    const h = harness();
    const kernel = new AgentKernel({
      store: h.store,
      provider: h.provider,
      tools: h.tools,
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      interactiveApproval: true, // 无超时：仅靠 interrupt 解除
    });
    h.tools.register(h.echoTool('always'));
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 1 }));
    h.provider.script(textTurn('ok'));
    const sessionId = await kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    kernel.subscribe(sessionId, null, (env: EventEnvelope) => {
      if (env.event.kind === 'ApprovalRequested') setTimeout(() => kernel.interrupt(sessionId), 0);
    });
    await kernel.submitInput(sessionId, 'go', 'k1'); // 若 interrupt 不解除 pending 会永久挂起、此处 await 不返回
    expect(h.calls).toEqual([]);
  });

  it('always 审批缓存：reject_always 后同名工具不再二次弹审批', async () => {
    let asks = 0;
    const gate: ApprovalGate = { async request() { asks++; return { decision: 'reject_always' }; } };
    const h = harness({ approvalGate: gate });
    h.tools.register(h.echoTool('always'));
    h.provider.script(toolCallTurn('echo', 'a', { i: 1 }));
    h.provider.script(toolCallTurn('echo', 'b', { i: 2 })); // 第二次同名调用
    h.provider.script(textTurn('done'));
    await drive(h);
    expect(asks).toBe(1); // 只问一次，第二次命中缓存直接拒绝
    expect(h.calls).toEqual([]);
  });

  it('updatedInput：审批改参后放行 → 用新参数执行', async () => {
    const gate: ApprovalGate = { async request() { return { decision: 'allow_once', updatedInput: { i: 99 } }; } };
    const h = harness({ approvalGate: gate });
    h.tools.register(h.echoTool('always'));
    h.provider.script(toolCallTurn('echo', 'a', { i: 1 }));
    h.provider.script(textTurn('done'));
    await drive(h);
    expect(h.calls).toEqual([{ i: 99 }]); // 用 updatedInput 而非原始 {i:1}
  });

  it('edit 类工具成功 → 发 FileChanged + 调 checkpointer.snapshot + saveCheckpoint', async () => {
    const store = new MemoryEventStore();
    const provider = new FakeProvider();
    const tools = new InMemoryToolRegistry();
    const snapshots: string[] = [];
    const saved: string[] = [];
    const origSave = store.saveCheckpoint.bind(store);
    store.saveCheckpoint = async (cp) => { saved.push(cp.shadowGitRef); return origSave(cp); };
    const editTool: RegisteredTool = {
      descriptor: { name: 'write', kind: 'edit', description: 'w', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval: 'never' },
      executor: { async *execute() { yield { kind: 'output', chunk: 'ok' }; } },
    };
    tools.register(editTool);
    const checkpointer = { async snapshot(label?: string) { snapshots.push(label ?? ''); return { checkpointId: 'cp1', ref: 'deadbeef', createdAt: 1 }; } };
    const kernel = new AgentKernel({ store, provider, tools, loopBreaker: new HistoryLoopBreaker(), condenser: new NoopCondenser(), checkpointer });
    provider.script(toolCallTurn('write', 'w1', { path: 'src/a.ts', content: 'x' }));
    provider.script(textTurn('done'));
    const events: AgentEvent[] = [];
    const sessionId = await kernel.startSession();
    kernel.subscribe(sessionId, null, (env: EventEnvelope) => events.push(env.event));
    await kernel.submitInput(sessionId, 'go', 'k1');
    const fc = events.find((e) => e.kind === 'FileChanged');
    expect(fc && 'path' in fc ? fc.path : null).toBe('src/a.ts');
    expect(fc && 'changeKind' in fc ? fc.changeKind : null).toBe('edit');
    expect(snapshots).toHaveLength(1);
    expect(saved).toEqual(['deadbeef']);
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
