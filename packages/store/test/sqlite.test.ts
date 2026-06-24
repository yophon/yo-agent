import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteEventStore } from '@yo-agent/store';
import type { EventEnvelope } from '@yo-agent/protocol';

function env(cursor: number): EventEnvelope {
  return {
    sessionId: 's',
    cursor,
    parentId: cursor > 0 ? cursor - 1 : null,
    turnId: 't',
    ts: 1000 + cursor,
    event: { kind: 'AssistantText', delta: `d${cursor}` },
  };
}

// node:sqlite 需 Node ≥ 22.5（部分版本要 --experimental-sqlite）。不可用则整组跳过，保持套件绿。
const probe = (() => {
  try {
    const s = SqliteEventStore.open(':memory:');
    s.close();
    return true;
  } catch {
    return false;
  }
})();
const suite = probe ? describe : describe.skip;

suite('SqliteEventStore (node:sqlite)', () => {
  it('append/read/head + 拒绝非递增 cursor', async () => {
    const st = SqliteEventStore.open(':memory:');
    await st.append(env(0));
    await st.append(env(1));
    await expect(st.append(env(1))).rejects.toThrow(/单调递增/);
    expect(await st.head('s')).toBe(1);
    const got: number[] = [];
    for await (const e of st.read('s')) got.push(e.cursor);
    expect(got).toEqual([0, 1]);
    const after: number[] = [];
    for await (const e of st.read('s', 0)) after.push(e.cursor);
    expect(after).toEqual([1]);
    st.close();
  });

  it('落盘后重开仍可读（持久化 + payload/parentId 往返）', async () => {
    const path = join(tmpdir(), `yo-sqlite-${randomUUID()}.db`);
    const a = SqliteEventStore.open(path);
    await a.append(env(0));
    await a.append(env(1));
    a.close();
    const b = SqliteEventStore.open(path);
    const rows: EventEnvelope[] = [];
    for await (const e of b.read('s')) rows.push(e);
    expect(rows.map((e) => e.cursor)).toEqual([0, 1]);
    expect(rows[0]!.event.kind).toBe('AssistantText');
    expect(rows[1]!.parentId).toBe(0);
    b.close();
  });
});
