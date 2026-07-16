/**
 * IndexedDB append-only EventLog（Phase 5.1a，浏览器持久化）。
 * 三 object store 对应 SqliteEventStore 三表，行为逐条对齐（sqlite.ts:82-137）：
 * append 单调校验 / read 半开区间 (from,to] 升序 / createSession=upsert / head=MAX。
 * 换给 createWebAgent 注入即得「跨刷新会话恢复」（内核 resumeSession 只依赖 getSession+head+read）。
 *
 * 类型说明：仓库 lib 无 DOM，照 sqlite.ts 对 node:sqlite 的做法，
 * 以最小结构接口描述用到的 IndexedDB 面，经 globalThis 取全局（浏览器真机 / 测试 fake-indexeddb）。
 */
import type { AgentEvent, Cursor, EventEnvelope, Id } from '@yo-agent/protocol';
import { EVENTLOG_SCHEMA_VERSION } from '@yo-agent/protocol';
import type { Checkpoint, EventStore, SessionRow, TurnSnapshot } from './index';

// ───────────────────────── 最小 IndexedDB 结构类型 ─────────────────────────

interface IdbRequest<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
interface IdbCursor {
  value: unknown;
  continue(): void;
}
interface IdbObjectStore {
  add(value: unknown): IdbRequest;
  put(value: unknown): IdbRequest;
  get(key: unknown): IdbRequest;
  getAll(query?: unknown): IdbRequest<unknown[]>;
  delete(query: unknown): IdbRequest;
  openCursor(query?: unknown, direction?: 'next' | 'prev'): IdbRequest<IdbCursor | null>;
  createIndex?(name: string, keyPath: unknown, opts?: unknown): unknown;
}
interface IdbTransaction {
  objectStore(name: string): IdbObjectStore;
}
interface IdbDatabase {
  transaction(names: string | string[], mode?: 'readonly' | 'readwrite'): IdbTransaction;
  createObjectStore(name: string, opts?: { keyPath?: string | string[] }): IdbObjectStore;
  objectStoreNames: { contains(name: string): boolean };
  close(): void;
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: ((ev: unknown) => void) | null;
}
interface IdbFactory {
  open(name: string, version?: number): IdbOpenRequest;
}
interface IdbKeyRangeStatic {
  bound(lower: unknown, upper: unknown): unknown;
}

function idbGlobals(): { factory: IdbFactory; KeyRange: IdbKeyRangeStatic } {
  const g = globalThis as unknown as { indexedDB?: IdbFactory; IDBKeyRange?: IdbKeyRangeStatic };
  if (!g.indexedDB || !g.IDBKeyRange) {
    throw new Error('当前环境无 IndexedDB（隐私模式/非浏览器）——降级 MemoryEventStore（刷新即失）');
  }
  return { factory: g.indexedDB, KeyRange: g.IDBKeyRange };
}

/** IDBRequest → Promise。 */
function req<T>(r: IdbRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error instanceof Error ? r.error : new Error(String(r.error)));
  });
}

interface StoredEvent {
  sessionId: Id;
  cursor: number;
  parentId: number | null;
  turnId: string | null;
  ts: number;
  kind: string;
  event: AgentEvent;
  schemaVersion: number;
}

const EVENTS = 'events';
const SESSIONS = 'sessions';
const CHECKPOINTS = 'checkpoints';
const SNAPSHOTS = 'turn_snapshots';

export class IndexedDBEventStore implements EventStore {
  private readonly db: IdbDatabase;
  private readonly KeyRange: IdbKeyRangeStatic;

  private constructor(db: IdbDatabase, keyRange: IdbKeyRangeStatic) {
    this.db = db;
    this.KeyRange = keyRange;
  }

  /** 打开/建库。环境无 IndexedDB 抛可行动错误，调用方降级 MemoryEventStore。v2：+turn_snapshots（5.3b，contains 判缺旧库自动补）。 */
  static async open(dbName = 'yo-agent'): Promise<IndexedDBEventStore> {
    const { factory, KeyRange } = idbGlobals();
    const openReq = factory.open(dbName, 2);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(EVENTS)) {
        db.createObjectStore(EVENTS, { keyPath: ['sessionId', 'cursor'] });
      }
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(CHECKPOINTS)) {
        db.createObjectStore(CHECKPOINTS, { keyPath: 'checkpointId' });
      }
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        db.createObjectStore(SNAPSHOTS, { keyPath: ['sessionId', 'cursor'] });
      }
    };
    const db = await req(openReq);
    return new IndexedDBEventStore(db, KeyRange);
  }

  /** 复合主键 [sessionId, cursor] 的会话分区范围。 */
  private sessionRange(sessionId: Id): unknown {
    return this.KeyRange.bound([sessionId, Number.NEGATIVE_INFINITY], [sessionId, Number.POSITIVE_INFINITY]);
  }

  async append(env: EventEnvelope): Promise<void> {
    // 与 sqlite.ts:82-86 同构：先 head 对账再插入（内核 emitChain 已串行化 emit；add 撞主键兜底抛错）。
    const head = await this.head(env.sessionId);
    if (head !== null && env.cursor <= head) {
      throw new Error(`cursor 必须单调递增：${env.cursor} <= ${head}`);
    }
    const record: StoredEvent = {
      sessionId: env.sessionId,
      cursor: env.cursor,
      parentId: env.parentId,
      turnId: env.turnId,
      ts: env.ts,
      kind: env.event.kind,
      event: env.event,
      schemaVersion: EVENTLOG_SCHEMA_VERSION,
    };
    const store = this.db.transaction(EVENTS, 'readwrite').objectStore(EVENTS);
    await req(store.add(record));
  }

  async *read(sessionId: Id, fromCursor?: Cursor, toCursor?: Cursor): AsyncIterable<EventEnvelope> {
    // getAll 按主键升序（等价 sqlite 的 ORDER BY cursor ASC 全量取 + JS 侧半开区间过滤）。
    const store = this.db.transaction(EVENTS, 'readonly').objectStore(EVENTS);
    const rows = (await req(store.getAll(this.sessionRange(sessionId)))) as StoredEvent[];
    for (const r of rows) {
      if (fromCursor !== undefined && r.cursor <= fromCursor) continue;
      if (toCursor !== undefined && r.cursor > toCursor) continue;
      yield {
        sessionId,
        cursor: r.cursor,
        parentId: r.parentId,
        turnId: r.turnId,
        ts: r.ts,
        event: r.event,
      };
    }
  }

  async head(sessionId: Id): Promise<Cursor | null> {
    const store = this.db.transaction(EVENTS, 'readonly').objectStore(EVENTS);
    const cur = await req(store.openCursor(this.sessionRange(sessionId), 'prev'));
    return cur ? (cur.value as StoredEvent).cursor : null;
  }

  async createSession(row: SessionRow): Promise<void> {
    // put = upsert（等价 INSERT OR REPLACE）；SessionRow 纯 JSON，结构化克隆直存。
    const store = this.db.transaction(SESSIONS, 'readwrite').objectStore(SESSIONS);
    await req(store.put(row));
  }

  async getSession(sessionId: Id): Promise<SessionRow | null> {
    const store = this.db.transaction(SESSIONS, 'readonly').objectStore(SESSIONS);
    const row = (await req(store.get(sessionId))) as SessionRow | undefined;
    return row ?? null;
  }

  async listSessions(): Promise<SessionRow[]> {
    const store = this.db.transaction(SESSIONS, 'readonly').objectStore(SESSIONS);
    return (await req(store.getAll())) as SessionRow[];
  }

  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    const store = this.db.transaction(CHECKPOINTS, 'readwrite').objectStore(CHECKPOINTS);
    await req(store.put(cp));
  }

  // ── 5.3b turn 快照 ──

  async saveTurnSnapshot(snap: TurnSnapshot): Promise<void> {
    const store = this.db.transaction(SNAPSHOTS, 'readwrite').objectStore(SNAPSHOTS);
    await req(store.put(snap));
  }

  async getTurnSnapshot(sessionId: Id, cursor: Cursor): Promise<TurnSnapshot | null> {
    const store = this.db.transaction(SNAPSHOTS, 'readonly').objectStore(SNAPSHOTS);
    const row = (await req(store.get([sessionId, cursor]))) as TurnSnapshot | undefined;
    return row ?? null;
  }

  async listTurnSnapshots(sessionId: Id): Promise<Cursor[]> {
    const store = this.db.transaction(SNAPSHOTS, 'readonly').objectStore(SNAPSHOTS);
    const rows = (await req(store.getAll(this.sessionRange(sessionId)))) as TurnSnapshot[];
    return rows.map((r) => r.cursor); // getAll 按复合主键升序，天然 cursor 有序
  }

  /**
   * 删除会话（EventStore 冻结接口无删除——控制台等持有具体类型的调用方使用）：
   * 事件分区 + 会话行 + turn 快照分区 + 该会话的 checkpoints 一并清理。
   */
  async deleteSession(sessionId: Id): Promise<void> {
    const events = this.db.transaction(EVENTS, 'readwrite').objectStore(EVENTS);
    await req(events.delete(this.sessionRange(sessionId)));
    const sessions = this.db.transaction(SESSIONS, 'readwrite').objectStore(SESSIONS);
    await req(sessions.delete(sessionId));
    const snaps = this.db.transaction(SNAPSHOTS, 'readwrite').objectStore(SNAPSHOTS);
    await req(snaps.delete(this.sessionRange(sessionId)));
    const cps = this.db.transaction(CHECKPOINTS, 'readwrite').objectStore(CHECKPOINTS);
    const all = (await req(cps.getAll())) as Checkpoint[];
    for (const cp of all) {
      if (cp.sessionId === sessionId) await req(cps.delete(cp.checkpointId));
    }
  }

  close(): void {
    this.db.close();
  }
}
