import type { Cursor, EventEnvelope, Id } from '@yo-agent/protocol';
import type { Checkpoint, EventStore, SessionRow, TurnSnapshot } from './index';

/**
 * 内存 EventStore（DESIGN ADR-1）。证明 append-only / cursor 单调 / resume(fromCursor) /
 * parentId DAG 语义。SQLite 持久实现（better-sqlite3 / node:sqlite）是下一步。
 */
export class MemoryEventStore implements EventStore {
  private readonly log = new Map<Id, EventEnvelope[]>();
  private readonly sessions = new Map<Id, SessionRow>();
  private readonly checkpoints: Checkpoint[] = [];

  async append(env: EventEnvelope): Promise<void> {
    const arr = this.log.get(env.sessionId) ?? [];
    const last = arr[arr.length - 1];
    if (last && env.cursor <= last.cursor) {
      throw new Error(`cursor 必须单调递增：${env.cursor} <= ${last.cursor}`);
    }
    arr.push(env);
    this.log.set(env.sessionId, arr);
  }

  async *read(sessionId: Id, fromCursor?: Cursor, toCursor?: Cursor): AsyncIterable<EventEnvelope> {
    const arr = this.log.get(sessionId) ?? [];
    for (const e of arr) {
      if (fromCursor !== undefined && e.cursor <= fromCursor) continue;
      if (toCursor !== undefined && e.cursor > toCursor) continue;
      yield e;
    }
  }

  async head(sessionId: Id): Promise<Cursor | null> {
    const arr = this.log.get(sessionId);
    return arr && arr.length > 0 ? arr[arr.length - 1]!.cursor : null;
  }

  async createSession(row: SessionRow): Promise<void> {
    this.sessions.set(row.sessionId, row);
  }

  async getSession(sessionId: Id): Promise<SessionRow | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(): Promise<SessionRow[]> {
    return [...this.sessions.values()];
  }

  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    this.checkpoints.push(cp);
  }

  // ── 5.3b turn 快照 ──
  private readonly snapshots = new Map<Id, Map<Cursor, TurnSnapshot>>();

  async saveTurnSnapshot(snap: TurnSnapshot): Promise<void> {
    const bySession = this.snapshots.get(snap.sessionId) ?? new Map<Cursor, TurnSnapshot>();
    bySession.set(snap.cursor, snap);
    this.snapshots.set(snap.sessionId, bySession);
  }

  async getTurnSnapshot(sessionId: Id, cursor: Cursor): Promise<TurnSnapshot | null> {
    return this.snapshots.get(sessionId)?.get(cursor) ?? null;
  }

  async listTurnSnapshots(sessionId: Id): Promise<Cursor[]> {
    return [...(this.snapshots.get(sessionId)?.keys() ?? [])].sort((a, b) => a - b);
  }
}
