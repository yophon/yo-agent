import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@yo-agent/protocol';
import { IndexedDBEventStore } from '@yo-agent/store/core';
import { AgentKernel, NoopCondenser, makeLoopBreaker } from '@yo-agent/kernel/core';
import { FakeProvider, textTurn } from '@yo-agent/provider';
import { InMemoryToolRegistry } from '@yo-agent/tools/core';

let dbSeq = 0;
const freshDb = () => IndexedDBEventStore.open(`yo-test-${++dbSeq}`);

function env(cursor: number, sessionId = 's'): EventEnvelope {
  return {
    sessionId,
    cursor,
    parentId: cursor > 0 ? cursor - 1 : null,
    turnId: 't',
    ts: 1000 + cursor,
    event: { kind: 'AssistantText', delta: `d${cursor}` },
  };
}

describe('IndexedDBEventStore（fake-indexeddb，语义对齐 SqliteEventStore）', () => {
  it('append/read/head + 拒绝非递增 cursor + 半开区间 (from,to]', async () => {
    const st = await freshDb();
    await st.append(env(0));
    await st.append(env(1));
    await st.append(env(2));
    await expect(st.append(env(1))).rejects.toThrow(/单调递增/);
    expect(await st.head('s')).toBe(2);
    expect(await st.head('nope')).toBeNull();
    const all: number[] = [];
    for await (const e of st.read('s')) all.push(e.cursor);
    expect(all).toEqual([0, 1, 2]);
    const mid: number[] = [];
    for await (const e of st.read('s', 0, 1)) mid.push(e.cursor);
    expect(mid).toEqual([1]);
    st.close();
  });

  it('会话分区隔离：cursor per-session，互不冲突（多 kernel 共享一库的基座）', async () => {
    const st = await freshDb();
    await st.append(env(0, 'a'));
    await st.append(env(0, 'b')); // 同 cursor 不同会话——合法
    await st.append(env(1, 'a'));
    expect(await st.head('a')).toBe(1);
    expect(await st.head('b')).toBe(0);
    const bOnly: number[] = [];
    for await (const e of st.read('b')) bOnly.push(e.cursor);
    expect(bOnly).toEqual([0]);
    st.close();
  });

  it('payload/parentId 结构化往返 + 会话行（含 messages 快照）upsert 往返', async () => {
    const st = await freshDb();
    await st.append(env(0));
    const rows: EventEnvelope[] = [];
    for await (const e of st.read('s')) rows.push(e);
    expect(rows[0]?.event).toEqual({ kind: 'AssistantText', delta: 'd0' });
    expect(rows[0]?.parentId).toBeNull();

    const row = {
      sessionId: 's1',
      owner: 'self',
      surfaceKind: 'kernel',
      agentProfile: 'default',
      workspacePath: '/ws',
      model: 'm',
      permissionMode: 'supervised',
      state: 'active',
      headCursor: 3,
      createdAt: 1,
      lastActiveAt: 2,
      messages: [{ role: 'user', content: '问题一' }],
    };
    await st.createSession(row);
    await st.createSession({ ...row, headCursor: 5 }); // upsert 覆盖
    expect((await st.getSession('s1'))?.headCursor).toBe(5);
    expect(await st.getSession('nope')).toBeNull();
    expect((await st.listSessions()).map((r) => r.sessionId)).toEqual(['s1']);
    st.close();
  });

  it('deleteSession：事件分区 + 会话行 + 本会话 checkpoints 清理，不伤别的会话', async () => {
    const st = await freshDb();
    await st.append(env(0, 'a'));
    await st.append(env(0, 'b'));
    await st.createSession({
      sessionId: 'a',
      owner: 'self',
      surfaceKind: 'kernel',
      agentProfile: 'default',
      workspacePath: '/',
      model: 'm',
      permissionMode: 'supervised',
      state: 'active',
      headCursor: 0,
      createdAt: 1,
      lastActiveAt: 1,
    });
    await st.saveCheckpoint({ checkpointId: 'cp-a', sessionId: 'a', cursor: 0, shadowGitRef: 'r', createdAt: 1 });
    await st.saveCheckpoint({ checkpointId: 'cp-b', sessionId: 'b', cursor: 0, shadowGitRef: 'r', createdAt: 1 });
    await st.deleteSession('a');
    expect(await st.head('a')).toBeNull();
    expect(await st.getSession('a')).toBeNull();
    expect(await st.head('b')).toBe(0); // b 不受影响
    st.close();
  });

  it('跨 kernel 实例 resume：kernel A 聊一轮 → kernel B 同库 resumeSession 续聊（刷新恢复的基座）', async () => {
    const st = await freshDb();
    const deps = (provider: FakeProvider) => ({
      store: st,
      provider,
      tools: new InMemoryToolRegistry(),
      loopBreaker: makeLoopBreaker('loose'),
      condenser: new NoopCondenser(),
      model: 'fake-model',
      cwd: '/',
    });
    const pa = new FakeProvider().script(textTurn('第一轮回答'));
    const a = new AgentKernel(deps(pa));
    const sid = await a.startSession({ model: 'fake-model' });
    await a.submitInput(sid, '第一问', 'k1');
    const headAfterA = await st.head(sid);
    a.endSession(sid); // 模拟页面关闭：清内存不删持久

    const pb = new FakeProvider().script(textTurn('第二轮回答'));
    const b = new AgentKernel(deps(pb)); // 模拟刷新后的新 kernel
    expect(await b.resumeSession(sid)).toBe(true);
    await b.submitInput(sid, '第二问', 'k2');
    // cursor 从持久 head 续接单调递增（无撞车）
    expect((await st.head(sid))!).toBeGreaterThan(headAfterA!);
    // 第二轮请求的消息窗口带着第一轮上下文（messages 快照恢复生效）
    const seen = pb.seen[0];
    expect(JSON.stringify(seen?.messages)).toContain('第一轮回答');
    st.close();
  });
});
