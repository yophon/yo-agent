import { createRequire } from 'node:module';
import type { Cursor, EventEnvelope, Id } from '@yo-agent/protocol';
import { EVENTLOG_SCHEMA_VERSION } from '@yo-agent/protocol';
import type { AgentEvent } from '@yo-agent/protocol';
import type { Checkpoint, EventStore, SessionRow } from './index';

// node:sqlite 经 createRequire 加载，避免对 @types/node 版本的硬依赖（Node ≥ 22.5）。
interface SqliteStmt {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDb;
}

interface EventRow {
  cursor: number;
  parent_cursor: number | null;
  turn_id: string | null;
  ts: number;
  payload_json: string;
}

/**
 * SQLite append-only EventLog（DESIGN §10.1 / ADR-1）。落盘持久化 + schema_version 入库。
 * 用 node:sqlite（Node 内置，免原生编译）。SqliteEventStore.open() 在不支持的环境抛错，
 * 调用方可降级 MemoryEventStore。
 */
export class SqliteEventStore implements EventStore {
  private readonly db: SqliteDb;
  private readonly insertEvent: SqliteStmt;
  private readonly selectEvents: SqliteStmt;
  private readonly selectHead: SqliteStmt;
  private readonly upsertSession: SqliteStmt;
  private readonly selectSession: SqliteStmt;
  private readonly insertCheckpoint: SqliteStmt;

  private constructor(db: SqliteDb) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        parent_cursor INTEGER,
        turn_id TEXT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        PRIMARY KEY (session_id, cursor)
      );
      CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, row_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (checkpoint_id TEXT PRIMARY KEY, row_json TEXT NOT NULL);
    `);
    this.insertEvent = db.prepare(
      `INSERT INTO events (session_id, cursor, parent_cursor, turn_id, ts, kind, payload_json, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectEvents = db.prepare(
      `SELECT cursor, parent_cursor, turn_id, ts, payload_json FROM events WHERE session_id = ? ORDER BY cursor ASC`,
    );
    this.selectHead = db.prepare(`SELECT MAX(cursor) AS head FROM events WHERE session_id = ?`);
    this.upsertSession = db.prepare(`INSERT OR REPLACE INTO sessions (session_id, row_json) VALUES (?, ?)`);
    this.selectSession = db.prepare(`SELECT row_json FROM sessions WHERE session_id = ?`);
    this.insertCheckpoint = db.prepare(`INSERT OR REPLACE INTO checkpoints (checkpoint_id, row_json) VALUES (?, ?)`);
  }

  static open(path = ':memory:'): SqliteEventStore {
    const require = createRequire(import.meta.url);
    const mod = require('node:sqlite') as SqliteModule;
    return new SqliteEventStore(new mod.DatabaseSync(path));
  }

  async append(env: EventEnvelope): Promise<void> {
    const head = await this.head(env.sessionId);
    if (head !== null && env.cursor <= head) {
      throw new Error(`cursor 必须单调递增：${env.cursor} <= ${head}`);
    }
    this.insertEvent.run(
      env.sessionId,
      env.cursor,
      env.parentId,
      env.turnId,
      env.ts,
      env.event.kind,
      JSON.stringify(env.event),
      EVENTLOG_SCHEMA_VERSION,
    );
  }

  async *read(sessionId: Id, fromCursor?: Cursor, toCursor?: Cursor): AsyncIterable<EventEnvelope> {
    const rows = this.selectEvents.all(sessionId) as EventRow[];
    for (const r of rows) {
      const cursor = Number(r.cursor);
      if (fromCursor !== undefined && cursor <= fromCursor) continue;
      if (toCursor !== undefined && cursor > toCursor) continue;
      yield {
        sessionId,
        cursor,
        parentId: r.parent_cursor === null ? null : Number(r.parent_cursor),
        turnId: r.turn_id,
        ts: Number(r.ts),
        event: JSON.parse(r.payload_json) as AgentEvent,
      };
    }
  }

  async head(sessionId: Id): Promise<Cursor | null> {
    const row = this.selectHead.get(sessionId) as { head: number | null } | undefined;
    return row && row.head !== null ? Number(row.head) : null;
  }

  async createSession(row: SessionRow): Promise<void> {
    this.upsertSession.run(row.sessionId, JSON.stringify(row));
  }

  async getSession(sessionId: Id): Promise<SessionRow | null> {
    const row = this.selectSession.get(sessionId) as { row_json: string } | undefined;
    return row ? (JSON.parse(row.row_json) as SessionRow) : null;
  }

  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    this.insertCheckpoint.run(cp.checkpointId, JSON.stringify(cp));
  }

  close(): void {
    this.db.close();
  }
}
