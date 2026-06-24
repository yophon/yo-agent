/**
 * @yo-agent/store —— 持久化（冻结接口，DESIGN §10.1 / ADR-1）。
 * append-only EventLog 是唯一事实源，免费换来 resume + 确定性重放 + 审计三件套。
 */
import type { Cursor, EventEnvelope, Id } from '@yo-agent/protocol';
import { EVENTLOG_SCHEMA_VERSION } from '@yo-agent/protocol';

export { EVENTLOG_SCHEMA_VERSION };
export * from './memory';
export * from './sqlite';

export interface Checkpoint {
  checkpointId: Id;
  sessionId: Id;
  cursor: Cursor;
  shadowGitRef: string;
  createdAt: number;
}

export interface SessionRow {
  sessionId: Id;
  owner: string;
  surfaceKind: string;
  agentProfile: string;
  workspacePath: string;
  gitRef?: string;
  model: string;
  permissionMode: string;
  state: string;
  headCursor: Cursor;
  createdAt: number;
  lastActiveAt: number;
}

export interface EventStore {
  /** append-only 写入（带 schemaVersion 入库，旧事件始终可加载）。 */
  append(env: EventEnvelope): Promise<void>;
  /** 区间重放（resume / gap 溢出降级）。 */
  read(sessionId: Id, fromCursor?: Cursor, toCursor?: Cursor): AsyncIterable<EventEnvelope>;
  head(sessionId: Id): Promise<Cursor | null>;
  createSession(row: SessionRow): Promise<void>;
  getSession(sessionId: Id): Promise<SessionRow | null>;
  saveCheckpoint(cp: Checkpoint): Promise<void>;
}
