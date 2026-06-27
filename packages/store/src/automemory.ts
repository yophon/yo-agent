/**
 * @yo-agent/store — auto-memory 独立存储（3E / DESIGN §15.5 / ADR-12）。
 *
 * 严格不扩展 ADR-1 冻结的 `EventStore` 接口：记忆与 EventLog 共 SQLite 库、不同表（`memory`），
 * 关注点分离。PK = (workspace_path, key) → 跨会话长期记忆，**按 workspace 隔离**（git repo 根作边界，
 * 调用方传入 workspacePath）。命名为 MemoryStore / automemory.ts，与既有 `MemoryEventStore` 区分。
 *
 * 本文件持久层不引入时钟：`updatedAt` 由调用方戳入（保持确定性可测；workflow 外的常规代码可用 Date.now）。
 */
import { createRequire } from 'node:module';

/** 记忆来源：手动 #remember / 自动蒸馏（Phase N）/ 其它。 */
export type MemorySource = 'remember' | 'distill' | 'manual';

export interface MemoryRecord {
  /** 隔离边界（git repo 根或显式 workspaceRoot 的 realpath）。 */
  workspacePath: string;
  /** 记忆键（同 workspace 内唯一，upsert 语义）。 */
  key: string;
  content: string;
  /** 调用方戳入的更新时间（ms）。 */
  updatedAt: number;
  source: MemorySource;
}

export interface MemoryStore {
  /** upsert：同 (workspacePath, key) 覆盖。 */
  writeMemory(rec: MemoryRecord): Promise<void>;
  readMemory(workspacePath: string, key: string): Promise<MemoryRecord | null>;
  /** 列某 workspace 的全部记忆（按 key 字典序，稳定）。 */
  listMemory(workspacePath: string): Promise<MemoryRecord[]>;
  deleteMemory(workspacePath: string, key: string): Promise<void>;
}

/** 内存组合键：JSON 编码 [workspacePath, key] —— 无分隔符撞键风险（路径/键含任意字符都安全）。 */
const ckey = (workspacePath: string, key: string): string => JSON.stringify([workspacePath, key]);

/** 内存实现（测试 / 无持久化场景）。 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly map = new Map<string, MemoryRecord>();

  async writeMemory(rec: MemoryRecord): Promise<void> {
    this.map.set(ckey(rec.workspacePath, rec.key), { ...rec });
  }

  async readMemory(workspacePath: string, key: string): Promise<MemoryRecord | null> {
    const r = this.map.get(ckey(workspacePath, key));
    return r ? { ...r } : null;
  }

  async listMemory(workspacePath: string): Promise<MemoryRecord[]> {
    return [...this.map.values()]
      .filter((r) => r.workspacePath === workspacePath)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((r) => ({ ...r }));
  }

  async deleteMemory(workspacePath: string, key: string): Promise<void> {
    this.map.delete(ckey(workspacePath, key));
  }
}

// node:sqlite 经 createRequire 加载（同 SqliteEventStore），避免对 @types/node 版本硬依赖（Node ≥ 22.5）。
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

interface MemoryRow {
  workspace_path: string;
  key: string;
  content: string;
  updated_at: number;
  source: string;
}

/**
 * SQLite 持久实现。与 SqliteEventStore 共库不同表（落盘同一文件，`memory` 表独立）。
 * 用 node:sqlite（Node 内置，免原生编译）。open() 在不支持的环境抛错，调用方可降级 InMemoryMemoryStore。
 */
export class SqliteMemoryStore implements MemoryStore {
  private readonly db: SqliteDb;
  private readonly upsert: SqliteStmt;
  private readonly selectOne: SqliteStmt;
  private readonly selectByWs: SqliteStmt;
  private readonly del: SqliteStmt;

  private constructor(db: SqliteDb) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        workspace_path TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (workspace_path, key)
      );
    `);
    this.upsert = db.prepare(
      `INSERT OR REPLACE INTO memory (workspace_path, key, content, updated_at, source) VALUES (?, ?, ?, ?, ?)`,
    );
    this.selectOne = db.prepare(
      `SELECT workspace_path, key, content, updated_at, source FROM memory WHERE workspace_path = ? AND key = ?`,
    );
    this.selectByWs = db.prepare(
      `SELECT workspace_path, key, content, updated_at, source FROM memory WHERE workspace_path = ? ORDER BY key ASC`,
    );
    this.del = db.prepare(`DELETE FROM memory WHERE workspace_path = ? AND key = ?`);
  }

  static open(path = ':memory:'): SqliteMemoryStore {
    const require = createRequire(import.meta.url);
    const mod = require('node:sqlite') as SqliteModule;
    return new SqliteMemoryStore(new mod.DatabaseSync(path));
  }

  async writeMemory(rec: MemoryRecord): Promise<void> {
    this.upsert.run(rec.workspacePath, rec.key, rec.content, rec.updatedAt, rec.source);
  }

  async readMemory(workspacePath: string, key: string): Promise<MemoryRecord | null> {
    const row = this.selectOne.get(workspacePath, key) as MemoryRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async listMemory(workspacePath: string): Promise<MemoryRecord[]> {
    const rows = this.selectByWs.all(workspacePath) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  async deleteMemory(workspacePath: string, key: string): Promise<void> {
    this.del.run(workspacePath, key);
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    workspacePath: row.workspace_path,
    key: row.key,
    content: row.content,
    updatedAt: Number(row.updated_at),
    source: row.source as MemorySource,
  };
}
