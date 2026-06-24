import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import type { EventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';
import { InMemoryChannelPair, JsonRpcPeer, RpcSurface } from '@yo-agent/surface-rpc';

function echoTool(calls: unknown[]): RegisteredTool {
  return {
    descriptor: { name: 'echo', kind: 'other', description: 'echo', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval: 'always' },
    executor: { async *execute(input) { calls.push(input); yield { kind: 'output', chunk: 'ok' }; } },
  };
}

function makeKernel(store: EventStore, opts: { resumeBufferCapacity?: number; interactiveApproval?: boolean; calls?: unknown[] } = {}) {
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  if (opts.calls) tools.register(echoTool(opts.calls));
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: 'fake-model',
    cwd: '/tmp',
    interactiveApproval: opts.interactiveApproval,
    resumeBufferCapacity: opts.resumeBufferCapacity,
  });
  return { kernel, provider };
}

function connect(kernel: AgentKernel) {
  const pair = new InMemoryChannelPair();
  const surface = new RpcSurface(pair.a);
  const client = new JsonRpcPeer(pair.b);
  const events: AgentEvent[] = [];
  const envelopes: EventEnvelope[] = [];
  const approvals: Array<{ requestId: string }> = [];
  const waiters: Array<{ pred: (e: AgentEvent) => boolean; resolve: () => void }> = [];
  client.onNotify('event', (p) => {
    const env = p as EventEnvelope;
    envelopes.push(env);
    events.push(env.event);
    for (const w of [...waiters]) if (w.pred(env.event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
  });
  client.onNotify('approval/request', (p) => approvals.push(p as { requestId: string }));
  const waitFor = (pred: (e: AgentEvent) => boolean) =>
    new Promise<void>((resolve) => {
      if (events.some(pred)) return resolve();
      waiters.push({ pred, resolve });
    });
  const waitForApproval = async () => {
    for (let i = 0; i < 200 && approvals.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    return approvals[0]!;
  };
  return { surface, client, events, envelopes, approvals, waitFor, waitForApproval, started: surface.start(kernel) };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe('Slice 2B —— resume / reconnect / gap 降级 / 跨进程重建', () => {
  it('session/reconnect 缺口填充：内存 ring 覆盖 → 只推 fromCursor 之后', async () => {
    const store = new MemoryEventStore();
    const { kernel, provider } = makeKernel(store);
    provider.script(textTurn('一些文本'));
    const c = connect(kernel);
    await c.started;
    const { sessionId } = (await c.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    await c.client.request('turn/start', { sessionId, prompt: 'hi', idemKey: 'k1' });
    await c.waitFor((e) => e.kind === 'TurnCompleted');
    const head = Math.max(...c.envelopes.map((e) => e.cursor));
    const marker = c.envelopes.length;
    await c.client.request('session/reconnect', { sessionId, fromCursor: 1 });
    await tick();
    const reFilled = c.envelopes.slice(marker);
    expect(reFilled.length).toBeGreaterThan(0);
    expect(reFilled.every((e) => e.cursor > 1)).toBe(true); // 只填缺口，不重发 <=1
    expect(Math.max(...reFilled.map((e) => e.cursor))).toBe(head); // 填到 head
  });

  it('gap 溢出降级：ring 太小淘汰旧 cursor → 走 EventLog 取显著事件摘要（折叠流式）', async () => {
    const store = new MemoryEventStore();
    const { kernel, provider } = makeKernel(store, { resumeBufferCapacity: 2 });
    provider.script(textTurn('折叠我'));
    const c = connect(kernel);
    await c.started;
    const { sessionId } = (await c.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    await c.client.request('turn/start', { sessionId, prompt: 'hi', idemKey: 'k1' });
    await c.waitFor((e) => e.kind === 'TurnCompleted');
    const marker = c.envelopes.length;
    await c.client.request('session/reconnect', { sessionId, fromCursor: 0 }); // ring 已淘汰 cursor 0 → 溢出
    await tick();
    const summary = c.envelopes.slice(marker).map((e) => e.event.kind);
    expect(summary).not.toContain('AssistantText'); // 流式被折叠
    expect(summary).toEqual(expect.arrayContaining(['TurnStarted', 'TurnCompleted'])); // 状态变更保留
  });

  it('跨进程重建：新内核共享 store → resume 重放历史 + 续 turn 带完整上下文', async () => {
    const store = new MemoryEventStore();
    // 进程 1：跑一轮
    const k1 = makeKernel(store);
    k1.provider.script(textTurn('第一轮回答'));
    const c1 = connect(k1.kernel);
    await c1.started;
    const { sessionId } = (await c1.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    await c1.client.request('turn/start', { sessionId, prompt: '问题一', idemKey: 'k1' });
    await c1.waitFor((e) => e.kind === 'TurnCompleted');

    // 进程 2（模拟重启）：全新内核，仅共享 store
    const k2 = makeKernel(store);
    k2.provider.script(textTurn('第二轮回答'));
    const c2 = connect(k2.kernel);
    await c2.started;
    const r = (await c2.client.request('session/resume', { sessionId, fromCursor: 0 })) as { sessionId: string };
    expect(r.sessionId).toBe(sessionId);
    await tick();
    // 历史被重放给新客户端
    expect(c2.events.some((e) => e.kind === 'TurnCompleted')).toBe(true);
    // 续 turn 成功，且新内核发给 provider 的 messages 含第一轮上下文（会话状态已重建）
    await c2.client.request('turn/start', { sessionId, prompt: '问题二', idemKey: 'k2' });
    await c2.waitFor((e) => e.kind === 'TurnCompleted' && true);
    const lastReq = k2.provider.seen[k2.provider.seen.length - 1]!;
    const dump = JSON.stringify(lastReq.messages);
    expect(dump).toContain('问题一'); // 第一轮 user prompt 在重建的窗口里
    expect(dump).toContain('第一轮回答'); // 第一轮 assistant 也在
    expect(dump).toContain('问题二');
  });

  it('审批跨重连存活：turn 挂起等审批时重连 → 审批被重投 → decide 后工具执行', async () => {
    const store = new MemoryEventStore();
    const calls: unknown[] = [];
    const { kernel, provider } = makeKernel(store, { interactiveApproval: true, calls });
    provider.script(toolCallTurn('echo', 'tu1', { m: 7 }));
    provider.script(textTurn('done'));
    const c = connect(kernel);
    await c.started;
    const { sessionId } = (await c.client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    await c.client.request('turn/start', { sessionId, prompt: 'go', idemKey: 'k1' });
    const ar1 = await c.waitForApproval();
    // 模拟断线重连（turn 仍挂起等审批）：reconnect 从 turn 之前 → 缺口含 ApprovalRequested 被重投
    c.approvals.length = 0;
    await c.client.request('session/reconnect', { sessionId, fromCursor: 0 });
    await tick();
    expect(c.approvals.length).toBeGreaterThan(0); // 未决审批被重投
    expect(c.approvals[0]!.requestId).toBe(ar1.requestId);
    // 裁决 → turn 继续、工具执行
    await c.client.request('approval/decide', { requestId: ar1.requestId, decision: 'allow_once' });
    await c.waitFor((e) => e.kind === 'TurnCompleted');
    expect(calls).toEqual([{ m: 7 }]);
  });
});
