/**
 * ConsoleStore（Phase 5.1d）—— agent 配置与会话元数据的 CRUD 接口。
 * 这是「本地为主 + 预留后端同步」的接缝：本期 LocalConsoleStore（IndexedDB）；
 * 将来 RemoteConsoleStore 实现同接口即可切多设备同步，视图层零改动。
 */
import type { AgentConfigRecord, SessionMeta } from './types';

export interface ConsoleStore {
  listAgents(): Promise<AgentConfigRecord[]>;
  getAgent(id: string): Promise<AgentConfigRecord | null>;
  saveAgent(rec: AgentConfigRecord): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  getSessionMeta(sessionId: string): Promise<SessionMeta | null>;
  saveSessionMeta(meta: SessionMeta): Promise<void>;
  deleteSessionMeta(sessionId: string): Promise<void>;
}

const DB_NAME = 'yo-console';
const AGENTS = 'agents';
const SESSION_META = 'sessionMeta';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 请求失败'));
  });
}

export class LocalConsoleStore implements ConsoleStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(dbName = DB_NAME): Promise<LocalConsoleStore> {
    const openReq = indexedDB.open(dbName, 1);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(AGENTS)) db.createObjectStore(AGENTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SESSION_META)) db.createObjectStore(SESSION_META, { keyPath: 'sessionId' });
    };
    return new LocalConsoleStore(await req(openReq));
  }

  private store(name: string, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async listAgents(): Promise<AgentConfigRecord[]> {
    const all = (await req(this.store(AGENTS, 'readonly').getAll())) as AgentConfigRecord[];
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getAgent(id: string): Promise<AgentConfigRecord | null> {
    return ((await req(this.store(AGENTS, 'readonly').get(id))) as AgentConfigRecord | undefined) ?? null;
  }

  async saveAgent(rec: AgentConfigRecord): Promise<void> {
    await req(this.store(AGENTS, 'readwrite').put(rec));
  }

  async deleteAgent(id: string): Promise<void> {
    await req(this.store(AGENTS, 'readwrite').delete(id));
  }

  async getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    return ((await req(this.store(SESSION_META, 'readonly').get(sessionId))) as SessionMeta | undefined) ?? null;
  }

  async saveSessionMeta(meta: SessionMeta): Promise<void> {
    await req(this.store(SESSION_META, 'readwrite').put(meta));
  }

  async deleteSessionMeta(sessionId: string): Promise<void> {
    await req(this.store(SESSION_META, 'readwrite').delete(sessionId));
  }
}

/** 内存兜底（隐私模式等无 IndexedDB 环境）：本次会话内可用，刷新即失。 */
export class MemoryConsoleStore implements ConsoleStore {
  private agents = new Map<string, AgentConfigRecord>();
  private meta = new Map<string, SessionMeta>();

  async listAgents(): Promise<AgentConfigRecord[]> {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async getAgent(id: string): Promise<AgentConfigRecord | null> {
    return this.agents.get(id) ?? null;
  }
  async saveAgent(rec: AgentConfigRecord): Promise<void> {
    this.agents.set(rec.id, rec);
  }
  async deleteAgent(id: string): Promise<void> {
    this.agents.delete(id);
  }
  async getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    return this.meta.get(sessionId) ?? null;
  }
  async saveSessionMeta(meta: SessionMeta): Promise<void> {
    this.meta.set(meta.sessionId, meta);
  }
  async deleteSessionMeta(sessionId: string): Promise<void> {
    this.meta.delete(sessionId);
  }
}
