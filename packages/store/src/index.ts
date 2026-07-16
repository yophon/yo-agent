/**
 * @yo-agent/store —— 持久化（冻结接口，DESIGN §10.1 / ADR-1）。
 * append-only EventLog 是唯一事实源，免费换来 resume + 确定性重放 + 审计三件套。
 */
import type { Cursor, EventEnvelope, Id } from '@yo-agent/protocol';
import { EVENTLOG_SCHEMA_VERSION } from '@yo-agent/protocol';

export { EVENTLOG_SCHEMA_VERSION };
export * from './memory';
export * from './automemory';
export * from './sqlite';
export * from './checkpoint';
export * from './resume';

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
  /** 送 LLM 的消息窗口快照（opaque JSON，CanonMessage[]）——跨进程 resume 重建会话状态用。 */
  messages?: unknown[];
  /** 5.3b fork 谱系：本会话从源会话的哪个 turn 边界分出。会话间 DAG 的唯一数据源（tree 视图 / readThread 链回放）。 */
  forkedFrom?: { sessionId: Id; cursor: Cursor };
}

/**
 * turn 边界消息窗口快照（5.3b）：fork 在历史点续聊的数据源。
 * 事件回放重建 CanonMessage 不可行（压缩不可逆：doCondense 整体替换消息窗口，
 * ContextCompacted 只含 handoff 摘要），故按 (sessionId, cursor) 逐 turn 边界留存。
 */
export interface TurnSnapshot {
  sessionId: Id;
  /** TurnCompleted/TurnFailed 事件自身的 cursor（= 合法 fork 点）。 */
  cursor: Cursor;
  /** CanonMessage[]（opaque JSON，同 SessionRow.messages 形制）。 */
  messages: unknown[];
  createdAt: number;
}

export interface EventStore {
  /** append-only 写入（带 schemaVersion 入库，旧事件始终可加载）。 */
  append(env: EventEnvelope): Promise<void>;
  /** 区间重放（resume / gap 溢出降级）。 */
  read(sessionId: Id, fromCursor?: Cursor, toCursor?: Cursor): AsyncIterable<EventEnvelope>;
  head(sessionId: Id): Promise<Cursor | null>;
  /** upsert 会话行（含 messages 快照），跨进程 resume 重建用。 */
  createSession(row: SessionRow): Promise<void>;
  getSession(sessionId: Id): Promise<SessionRow | null>;
  /** 列持久会话（"last" / 跨进程发现）。 */
  listSessions(): Promise<SessionRow[]>;
  saveCheckpoint(cp: Checkpoint): Promise<void>;
  // ── 5.3b turn 快照（可选方法，沿冻结接口的 deleteSession 先例做增量：既有外部实现/测试 fake 不破；
  //    缺失时内核 fork 面优雅降级——快照不落、forkSession 抛可行动错误）。仓库内三实现全配。──
  /** upsert turn 边界快照（terminal 事件落库后由内核调用）。 */
  saveTurnSnapshot?(snap: TurnSnapshot): Promise<void>;
  /** 取指定 turn 边界快照；非快照点返回 null。 */
  getTurnSnapshot?(sessionId: Id, cursor: Cursor): Promise<TurnSnapshot | null>;
  /** 列会话全部合法 fork 点（cursor 升序）。 */
  listTurnSnapshots?(sessionId: Id): Promise<Cursor[]>;
}
