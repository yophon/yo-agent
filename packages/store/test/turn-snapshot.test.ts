import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { MemoryEventStore, SqliteEventStore } from '@yo-agent/store';
import { IndexedDBEventStore } from '@yo-agent/store/core';
import type { EventStore, SessionRow, TurnSnapshot } from '@yo-agent/store';

const makeSnap = (sessionId: string, cursor: number, tag: string): TurnSnapshot => ({
  sessionId,
  cursor,
  messages: [{ role: 'user', content: tag }],
  createdAt: 1000 + cursor,
});

let dbSeq = 0;
const stores: Array<[string, () => Promise<EventStore>]> = [
  ['memory', async () => new MemoryEventStore()],
  ['sqlite', async () => SqliteEventStore.open(':memory:')],
  ['indexeddb', async () => IndexedDBEventStore.open(`snap-test-${++dbSeq}`)],
];

describe.each(stores)('5.3b turn 快照 — %s', (_name, make) => {
  it('save/get/list：upsert 覆盖 + 会话分区隔离 + cursor 升序 + 非快照点 null', async () => {
    const st = await make();
    await st.saveTurnSnapshot!(makeSnap('a', 5, 'v1'));
    await st.saveTurnSnapshot!(makeSnap('a', 2, 'early'));
    await st.saveTurnSnapshot!(makeSnap('b', 3, 'other'));
    await st.saveTurnSnapshot!(makeSnap('a', 5, 'v2')); // 同键重写 = upsert

    expect(await st.listTurnSnapshots!('a')).toEqual([2, 5]);
    expect(await st.listTurnSnapshots!('b')).toEqual([3]);
    expect(await st.listTurnSnapshots!('none')).toEqual([]);
    expect((await st.getTurnSnapshot!('a', 5))?.messages).toEqual([{ role: 'user', content: 'v2' }]);
    expect(await st.getTurnSnapshot!('a', 4)).toBeNull();
  });

  it('SessionRow.forkedFrom 持久往返', async () => {
    const st = await make();
    const row: SessionRow = {
      sessionId: 'child',
      owner: 'self',
      surfaceKind: 'kernel',
      agentProfile: 'default',
      workspacePath: '/ws',
      model: 'm',
      permissionMode: 'supervised',
      state: 'active',
      headCursor: 7,
      createdAt: 1,
      lastActiveAt: 1,
      forkedFrom: { sessionId: 'parent', cursor: 7 },
    };
    await st.createSession(row);
    expect((await st.getSession('child'))?.forkedFrom).toEqual({ sessionId: 'parent', cursor: 7 });
  });
});
