import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { EventEnvelope } from '@yo-agent/protocol';

function harness(store = new MemoryEventStore()) {
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

/** 最后一次送 provider 的消息窗口序列化（断言分支上下文含/不含某内容）。 */
function lastSeen(h: ReturnType<typeof harness>): string {
  return JSON.stringify(h.provider.seen[h.provider.seen.length - 1]!.messages);
}

describe('5.3b fork — turn 边界分支', () => {
  it('缺省最近边界 fork：分支续聊带源上下文；源续聊与分支相互隔离', async () => {
    const h = harness();
    h.provider.script(textTurn('答一'));
    const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    await h.kernel.submitInput(sid, '第一问', 'k1');

    const forkId = await h.kernel.forkSession(sid);
    expect(forkId).not.toBe(sid);

    h.provider.script(textTurn('分支答'));
    await h.kernel.submitInput(forkId, '分支问', 'kb1');
    const branchCtx = lastSeen(h);
    expect(branchCtx).toContain('第一问'); // 源历史进分支上下文
    expect(branchCtx).toContain('答一');

    h.provider.script(textTurn('源答二'));
    await h.kernel.submitInput(sid, '源第二问', 'k2');
    expect(lastSeen(h)).not.toContain('分支问'); // 分支不漏进源

    h.provider.script(textTurn('分支答二'));
    await h.kernel.submitInput(forkId, '分支再问', 'kb2');
    expect(lastSeen(h)).not.toContain('源第二问'); // 源 fork 后的续聊不漏进分支
  });

  it('指定历史边界 fork：只带该点前上下文（快照不被源会话后续活动串改）', async () => {
    const h = harness();
    h.provider.script(textTurn('答一'));
    h.provider.script(textTurn('答二'));
    const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    await h.kernel.submitInput(sid, '第一问', 'k1');
    await h.kernel.submitInput(sid, '第二问', 'k2'); // fork 前源已续写活数组 → 验证快照深拷贝

    const points = await h.kernel.listForkPoints(sid);
    expect(points).toHaveLength(2);
    const forkId = await h.kernel.forkSession(sid, points[0]);

    h.provider.script(textTurn('分支答'));
    await h.kernel.submitInput(forkId, '分支问', 'kb');
    const ctx = lastSeen(h);
    expect(ctx).toContain('第一问');
    expect(ctx).not.toContain('第二问'); // turn1 边界的快照不含 turn2
  });

  it('校验：非边界 cursor 报错列出可选点；无已完成 turn 报错', async () => {
    const h = harness();
    h.provider.script(textTurn('答一'));
    const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    await expect(h.kernel.forkSession(sid)).rejects.toThrow('无可 fork');
    await h.kernel.submitInput(sid, '第一问', 'k1');
    await expect(h.kernel.forkSession(sid, 999)).rejects.toThrow('可选 fork 点');
  });

  it('源会话 turn 进行中仍可 fork 已完成边界（fork 对源纯读；「收到 TurnCompleted 即 fork」的远端模式依赖此语义）', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const tool: RegisteredTool = {
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
          await gate;
          yield { kind: 'output' as const, chunk: 'ok' };
        },
      },
    };
    h.tools.register(tool);
    h.provider.script(textTurn('答一'));
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('收尾'));
    const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    await h.kernel.submitInput(sid, '第一问', 'k1'); // 产生一个已完成边界
    const started: string[] = [];
    h.kernel.subscribe(sid, null, (env) => started.push(env.event.kind));
    const p = h.kernel.submitInput(sid, '慢任务', 'k2');
    while (!started.includes('ToolCallStarted')) await new Promise((r) => setTimeout(r, 5));

    const forkId = await h.kernel.forkSession(sid); // turn 2 进行中，从 turn 1 边界 fork
    expect(forkId).not.toBe(sid);
    h.provider.script(textTurn('分支答'));
    await h.kernel.submitInput(forkId, '分支问', 'kb');
    expect(lastSeen(h)).toContain('第一问'); // 分支带 turn 1 上下文
    expect(lastSeen(h)).not.toContain('慢任务'); // 进行中的 turn 2 不入分支

    release();
    await p; // 源 turn 2 正常收尾，不受 fork 影响
  });

  it('readThread 跨链回放：源事件(≤fork 点)+分支自有事件，cursor 全局单调；SessionStarted 带 forkedFrom', async () => {
    const h = harness();
    h.provider.script(textTurn('答一'));
    const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    await h.kernel.submitInput(sid, '第一问', 'k1');
    const forkId = await h.kernel.forkSession(sid);
    h.provider.script(textTurn('源答二'));
    await h.kernel.submitInput(sid, '源第二问', 'k2'); // fork 点之后的源事件不得进分支线
    h.provider.script(textTurn('分支答'));
    await h.kernel.submitInput(forkId, '分支问', 'kb');

    const thread: EventEnvelope[] = [];
    for await (const env of h.kernel.readThread(forkId)) thread.push(env);

    const cursors = thread.map((e) => e.cursor);
    expect([...cursors].sort((a, b) => a - b)).toEqual(cursors); // 合并时间线单调
    const userTexts = thread.filter((e) => e.event.kind === 'UserMessage').map((e) => (e.event as { text: string }).text);
    expect(userTexts).toEqual(['第一问', '分支问']); // 源 fork 后续聊不在线内
    const started = thread.find((e) => e.event.kind === 'SessionStarted' && e.sessionId === forkId);
    expect(started && 'forkedFrom' in started.event ? started.event.forkedFrom : null).toEqual({
      sessionId: sid,
      cursor: (await h.kernel.listForkPoints(sid))[0],
    });
  });

  it('跨 kernel 实例：同 store 重建后 resume fork 会话续聊带上下文，readThread 仍跨链（forkedFrom 持久往返）', async () => {
    const store = new MemoryEventStore();
    const h1 = harness(store);
    h1.provider.script(textTurn('答一'));
    const sid = await h1.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
    await h1.kernel.submitInput(sid, '第一问', 'k1');
    const forkId = await h1.kernel.forkSession(sid);

    const h2 = harness(store); // 模拟进程重启：新内核同库
    expect(await h2.kernel.resumeSession(forkId)).toBe(true);
    h2.provider.script(textTurn('分支答'));
    await h2.kernel.submitInput(forkId, '分支问', 'kb');
    expect(lastSeen(h2)).toContain('第一问');

    const kinds: string[] = [];
    for await (const env of h2.kernel.readThread(forkId)) {
      if (env.event.kind === 'UserMessage') kinds.push((env.event as { text: string }).text);
    }
    expect(kinds).toEqual(['第一问', '分支问']);
  });
});
