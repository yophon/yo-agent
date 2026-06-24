import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool, ToolApproval } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';
import { InMemoryChannelPair, JsonRpcPeer, RpcSurface } from '@yo-agent/surface-rpc';

function echoTool(approval: ToolApproval, calls: unknown[]): RegisteredTool {
  return {
    descriptor: { name: 'echo', kind: 'other', description: 'echo', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval },
    executor: { async *execute(input) { calls.push(input); yield { kind: 'output', chunk: `echoed:${JSON.stringify(input)}` }; } },
  };
}

async function harness(opts: { tool?: RegisteredTool } = {}) {
  const calls: unknown[] = [];
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  if (opts.tool) tools.register(opts.tool);
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: 'fake-model',
    cwd: '/tmp',
    interactiveApproval: true, // 审批走协议（approval/request → approval/decide）
  });
  const pair = new InMemoryChannelPair();
  const surface = new RpcSurface(pair.a);
  await surface.start(kernel);

  // 客户端
  const client = new JsonRpcPeer(pair.b);
  const events: AgentEvent[] = [];
  const envelopes: EventEnvelope[] = [];
  const approvals: Array<{ requestId: string; tool: string }> = [];
  const waiters: Array<{ pred: (e: AgentEvent) => boolean; resolve: () => void }> = [];
  client.onNotify('event', (p) => {
    const env = p as EventEnvelope;
    envelopes.push(env);
    events.push(env.event);
    for (const w of [...waiters]) if (w.pred(env.event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
  });
  client.onNotify('approval/request', (p) => approvals.push(p as { requestId: string; tool: string }));
  const waitFor = (pred: (e: AgentEvent) => boolean) =>
    new Promise<void>((resolve) => {
      if (events.some(pred)) return resolve();
      waiters.push({ pred, resolve });
    });
  const waitForApproval = async () => {
    for (let i = 0; i < 200 && approvals.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    return approvals[0]!;
  };

  return { kernel, provider, calls, client, events, envelopes, approvals, waitFor, waitForApproval };
}

describe('RpcSurface（JSON-RPC 通用远端驱动）', () => {
  it('ping → pong；model/list → 模型目录', async () => {
    const h = await harness();
    expect(await h.client.request('ping')).toBe('pong');
    const models = (await h.client.request('model/list')) as Array<{ id: string }>;
    expect(models[0]!.id).toBe('fake-model');
  });

  it('session/new → 收到 SessionStarted；session/list 列出会话', async () => {
    const h = await harness();
    const res = (await h.client.request('session/new', { project: '/tmp/ws', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string; workspacePath: string };
    expect(res.sessionId).toBeTruthy();
    expect(res.workspacePath).toBe('/tmp/ws');
    expect(h.events.some((e) => e.kind === 'SessionStarted')).toBe(true);
    const list = (await h.client.request('session/list')) as { sessions: Array<{ sessionId: string }> };
    expect(list.sessions.map((s) => s.sessionId)).toContain(res.sessionId);
  });

  it('turn/start 文本 turn：事件流式推送 + TurnCompleted', async () => {
    const h = await harness();
    h.provider.script(textTurn('你好世界'));
    const { sessionId } = (await h.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    const { turnId } = (await h.client.request('turn/start', { sessionId, prompt: 'hi', idemKey: 'k1' })) as { turnId: string };
    expect(turnId).toBeTruthy();
    await h.waitFor((e) => e.kind === 'TurnCompleted');
    const text = h.events.filter((e): e is Extract<AgentEvent, { kind: 'AssistantText' }> => e.kind === 'AssistantText').map((e) => e.delta).join('');
    expect(text).toBe('你好世界');
  });

  it('工具 turn + 协议化审批：approval/request → approval/decide(allow) → 工具执行 → 完成', async () => {
    const calls: unknown[] = [];
    const h = await harness({ tool: echoTool('always', calls) });
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 1 }));
    h.provider.script(textTurn('done'));
    const { sessionId } = (await h.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    await h.client.request('turn/start', { sessionId, prompt: 'go', idemKey: 'k1' });
    const ar = await h.waitForApproval();
    expect(ar.tool).toBe('echo');
    // turn 正挂起等审批；approval/decide 必须能被并发处理（不死锁）。
    await h.client.request('approval/decide', { requestId: ar.requestId, decision: 'allow_once' });
    await h.waitFor((e) => e.kind === 'TurnCompleted');
    expect(calls).toEqual([{ m: 1 }]);
  });

  it('工具 turn + 审批拒绝：approval/decide(reject) → 工具不执行', async () => {
    const calls: unknown[] = [];
    const h = await harness({ tool: echoTool('always', calls) });
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 2 }));
    h.provider.script(textTurn('done'));
    const { sessionId } = (await h.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    await h.client.request('turn/start', { sessionId, prompt: 'go', idemKey: 'k1' });
    const ar = await h.waitForApproval();
    await h.client.request('approval/decide', { requestId: ar.requestId, decision: 'reject_once' });
    await h.waitFor((e) => e.kind === 'TurnCompleted');
    expect(calls).toEqual([]);
  });

  it('turn/interrupt：挂起等审批时中断 → turn 收尾（interrupted），不死锁', async () => {
    const calls: unknown[] = [];
    const h = await harness({ tool: echoTool('always', calls) });
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 3 }));
    const { sessionId } = (await h.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    await h.client.request('turn/start', { sessionId, prompt: 'go', idemKey: 'k1' });
    await h.waitForApproval();
    await h.client.request('turn/interrupt', { sessionId });
    await h.waitFor((e) => e.kind === 'TurnCompleted' || e.kind === 'TurnFailed');
    expect(calls).toEqual([]); // 审批被 interrupt 以 deny 解除，工具未执行
  });

  it('session/resume：带历史重放（fromCursor 之后的事件重新推送）', async () => {
    const h = await harness();
    h.provider.script(textTurn('a'));
    const { sessionId } = (await h.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    await h.client.request('turn/start', { sessionId, prompt: 'hi', idemKey: 'k1' });
    await h.waitFor((e) => e.kind === 'TurnCompleted');
    const before = h.envelopes.length;
    // resume from cursor 0 → 重放 cursor>0 的全部事件。
    await h.client.request('session/resume', { sessionId, fromCursor: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.envelopes.length).toBeGreaterThan(before); // 历史被重放
  });

  it('未知方法 → JSON-RPC error（-32601）', async () => {
    const h = await harness();
    await expect(h.client.request('no/such/method', {})).rejects.toThrow(/method not found/);
  });
});
