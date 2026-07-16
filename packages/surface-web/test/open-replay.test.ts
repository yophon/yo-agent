import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@yo-agent/protocol';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { IndexedDBEventStore } from '@yo-agent/store/core';
import type { RegisteredTool } from '@yo-agent/tools/core';
import { ChatController, createWebAgent } from '@yo-agent/surface-web';

let seq = 0;
const freshDb = () => IndexedDBEventStore.open(`yo-web-open-${++seq}`);

const echoTool = (name: string): RegisteredTool => ({
  descriptor: {
    name,
    kind: 'fetch',
    description: 'echo',
    inputSchema: { type: 'object' },
    owner: 'core',
    availability: { always: true },
    approval: 'never',
  },
  executor: {
    async *execute(input) {
      yield { kind: 'output', chunk: `已查:${JSON.stringify(input)}` };
    },
  },
});

function makeAgent(store: IndexedDBEventStore, provider: FakeProvider, tools: RegisteredTool[] = []) {
  return createWebAgent({
    connection: { provider: 'openai', model: 'fake-model', baseUrl: 'https://x.example/v1' },
    providerOverride: provider,
    store,
    agentProfile: 'agent-test',
    tools,
  });
}

describe('ChatController.open —— 历史会话回放与续聊（5.1c）', () => {
  it('跨 agent 实例回放重建（user 气泡 + 工具 part + 文本），随后续聊带上下文', async () => {
    const store = await freshDb();
    // 第一「页面生命周期」：聊一轮含工具
    const pa = new FakeProvider().script(toolCallTurn('order_query', 't1', { orderId: '42' })).script(textTurn('42 已发货'));
    const ca = new ChatController(makeAgent(store, pa, [echoTool('order_query')]));
    await ca.send('订单 42 到哪了');
    const sid = ca.state.sessionId;
    if (!sid) throw new Error('no sid');
    const snapshotA = JSON.parse(JSON.stringify(ca.state.messages));
    ca.dispose(); // 模拟关页：清内存不删持久

    // 第二「页面生命周期」：新 agent/kernel 同库 open 回放
    const pb = new FakeProvider().script(textTurn('还有什么可以帮你？'));
    const cb = new ChatController(makeAgent(store, pb, [echoTool('order_query')]));
    await cb.open(sid);
    expect(cb.state.sessionId).toBe(sid);
    expect(cb.state.turnActive).toBe(false);
    // 回放重建与实时构建一致：user 气泡（UserMessage 事件）+ assistant（tool part ok + 文本）
    expect(cb.state.messages).toEqual(snapshotA);
    expect(cb.state.messages[0]).toEqual({ role: 'user', parts: [{ type: 'text', text: '订单 42 到哪了' }], status: 'done' });
    const assistant = cb.state.messages[1];
    expect(assistant?.parts.map((p) => p.type)).toEqual(['tool', 'text']);

    // 续聊：cursor 从持久 head 续接、消息窗口带第一轮上下文
    await cb.send('再确认下');
    expect(cb.state.messages).toHaveLength(4);
    expect(cb.state.error).toBeUndefined();
    expect(JSON.stringify(pb.seen[0]?.messages)).toContain('42 已发货');
    store.close();
  });

  it('open 后立即 send：回放与实时衔接无双记（lastCursor 贯通）', async () => {
    const store = await freshDb();
    const pa = new FakeProvider().script(textTurn('一'));
    const ca = new ChatController(makeAgent(store, pa));
    await ca.send('第一问');
    const sid = ca.state.sessionId;
    if (!sid) throw new Error('no sid');
    ca.dispose();

    const pb = new FakeProvider().script(textTurn('二'));
    const cb = new ChatController(makeAgent(store, pb));
    await cb.open(sid);
    await cb.send('第二问');
    // 恰好 4 条：user/assistant × 2——任何双记都会多出来
    expect(cb.state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    store.close();
  });

  it('上次 turn 进行中被刷新打断（EventLog 无收尾）：open 后 turnActive 复位、无 streaming 残留', async () => {
    const store = await freshDb();
    const sid = 'interrupted-session';
    const mk = (cursor: number, event: EventEnvelope['event']): EventEnvelope => ({
      sessionId: sid,
      cursor,
      parentId: null,
      turnId: 'tx',
      ts: 1000 + cursor,
      event,
    });
    await store.createSession({
      sessionId: sid,
      owner: 'self',
      surfaceKind: 'kernel',
      agentProfile: 'agent-test',
      workspacePath: '/',
      model: 'fake-model',
      permissionMode: 'supervised',
      state: 'active',
      headCursor: 2,
      createdAt: 1,
      lastActiveAt: 1,
      messages: [{ role: 'user', content: '查一下' }],
    });
    await store.append(mk(0, { kind: 'TurnStarted', turnId: 'tx', promptIdemKey: 'k' }));
    await store.append(mk(1, { kind: 'UserMessage', text: '查一下', source: 'prompt' }));
    await store.append(mk(2, { kind: 'AssistantText', delta: '正在' }));
    // 无 TurnCompleted —— 模拟刷新打断

    const c = new ChatController(makeAgent(store, new FakeProvider().script(textTurn('继续'))));
    await c.open(sid);
    expect(c.state.turnActive).toBe(false);
    expect(c.state.messages.filter((m) => m.status === 'streaming')).toHaveLength(0);
    expect(c.state.messages[1]?.parts).toEqual([{ type: 'text', text: '正在' }]);
    // 还能继续聊
    await c.send('继续查');
    expect(c.state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    store.close();
  });

  it('open 不存在的会话 → 可行动错误', async () => {
    const store = await freshDb();
    const c = new ChatController(makeAgent(store, new FakeProvider()));
    await expect(c.open('nope')).rejects.toThrow(/会话不存在/);
    store.close();
  });
});

describe('ChatController.fork（5.3b/c）', () => {
  it('fork 切到分支：跨链回放重建源历史气泡；分支续聊带源上下文且不写回源会话', async () => {
    const store = await freshDb();
    const p = new FakeProvider().script(textTurn('答一')).script(textTurn('分支答'));
    const c = new ChatController(makeAgent(store, p));
    await c.send('第一问');
    const srcSid = c.state.sessionId;
    if (!srcSid) throw new Error('no sid');
    const bubblesBefore = JSON.parse(JSON.stringify(c.state.messages));

    const forkSid = await c.fork();
    expect(forkSid).not.toBe(srcSid);
    expect(c.state.sessionId).toBe(forkSid);
    expect(c.state.messages).toEqual(bubblesBefore); // readThread 跨链回放重建源历史气泡

    await c.send('分支问');
    expect(JSON.stringify(p.seen[1]?.messages)).toContain('第一问'); // 源上下文进分支

    // 分支消息不写回源会话事件流
    const srcUserTexts: string[] = [];
    for await (const env of store.read(srcSid)) {
      if (env.event.kind === 'UserMessage') srcUserTexts.push((env.event as { text: string }).text);
    }
    expect(srcUserTexts).toEqual(['第一问']);
    store.close();
  });
});
