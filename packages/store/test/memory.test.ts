import { describe, it, expect } from 'vitest';
import { MemoryEventStore, EVENTLOG_SCHEMA_VERSION } from '@yo-agent/store';
import type { EventEnvelope } from '@yo-agent/protocol';

function env(cursor: number, parentId: number | null = null): EventEnvelope {
  return {
    sessionId: 's',
    cursor,
    parentId,
    turnId: null,
    ts: cursor,
    event: { kind: 'Error', message: `e${cursor}` },
  };
}

describe('MemoryEventStore', () => {
  it('append-only：拒绝非递增 cursor，head 跟踪末尾', async () => {
    const st = new MemoryEventStore();
    await st.append(env(0));
    await st.append(env(1));
    await expect(st.append(env(1))).rejects.toThrow(/单调递增/);
    expect(await st.head('s')).toBe(1);
    expect(await st.head('unknown')).toBeNull();
  });

  it('read(fromCursor) = resume 从该 cursor 之后（独占）', async () => {
    const st = new MemoryEventStore();
    for (let i = 0; i < 5; i++) await st.append(env(i));
    const got: number[] = [];
    for await (const e of st.read('s', 2)) got.push(e.cursor);
    expect(got).toEqual([3, 4]);
  });

  it('parentId 形成 DAG（fork / reply 锚点）', async () => {
    const st = new MemoryEventStore();
    await st.append(env(0));
    await st.append(env(1, 0));
    const all: EventEnvelope[] = [];
    for await (const e of st.read('s')) all.push(e);
    expect(all[1]!.parentId).toBe(0);
  });

  it('EventLog schema 版本入库', () => {
    expect(EVENTLOG_SCHEMA_VERSION).toBe(1);
  });
});
