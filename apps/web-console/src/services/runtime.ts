/**
 * 运行时装配（Phase 5.1d）：
 * - openSharedEventStore：全部 agent 的 kernel 共享的单例事件库（IndexedDB；无环境降级 Memory）。
 * - AgentRuntime：AgentConfigRecord → WebAgent 懒建缓存；配置变更 invalidate（旧会话数据在共享库，随时可 resume）。
 * - materializeAgentConfig：声明式记录 → WebAgentConfig（工具经 defineHttpTool 物化，confirm 审批挂控制台弹窗 gate）。
 */
import type { ApprovalGate, ApprovalOutcome } from '@yo-agent/kernel/core';
import type { EventStore } from '@yo-agent/store/core';
import { IndexedDBEventStore, MemoryEventStore } from '@yo-agent/store/core';
import type { WebAgent, WebAgentConfig } from '@yo-agent/surface-web';
import { createWebAgent, defineHttpTool } from '@yo-agent/surface-web';
import type { AgentConfigRecord } from './types';

export interface SharedEventStore {
  store: EventStore;
  /** false = 降级 Memory（隐私模式等），顶栏提示「本次会话不持久」。 */
  persistent: boolean;
  /** 持久实现才有：删除会话（事件+行+checkpoints）。 */
  deleteSession?: (sessionId: string) => Promise<void>;
}

export async function openSharedEventStore(dbName = 'yo-agent'): Promise<SharedEventStore> {
  try {
    const idb = await IndexedDBEventStore.open(dbName);
    return { store: idb, persistent: true, deleteSession: (sid) => idb.deleteSession(sid) };
  } catch {
    return { store: new MemoryEventStore(), persistent: false };
  }
}

/** 审批请求（confirm 模式弹窗的入参）。 */
export interface ApprovalPrompt {
  tool: string;
  input: unknown;
  risk: string;
}
export type ApprovalUi = (req: ApprovalPrompt) => Promise<boolean>;

/** 声明式配置 → 可执行 WebAgentConfig。inputSchemaJson 非法在此抛可行动错误（保存前应已校验）。 */
export function materializeAgentConfig(rec: AgentConfigRecord, events: EventStore, approvalUi?: ApprovalUi): WebAgentConfig {
  const tools = rec.tools.map((t) => {
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(t.inputSchemaJson) as Record<string, unknown>;
    } catch {
      throw new Error(`工具 ${t.name} 的 inputSchema 不是合法 JSON——请回配置页修正`);
    }
    return defineHttpTool({
      name: t.name,
      description: t.description,
      inputSchema: schema,
      url: t.url,
      method: t.method,
      headers: t.headers,
      credentials: t.credentials,
    });
  });
  const confirmGate: ApprovalGate | undefined = approvalUi
    ? {
        async request(req): Promise<ApprovalOutcome> {
          const ok = await approvalUi({ tool: req.tool, input: req.input, risk: req.risk });
          return { decision: ok ? 'allow_once' : 'reject_once' };
        },
      }
    : undefined;
  return {
    connection: {
      provider: rec.connection.provider,
      model: rec.connection.model,
      baseUrl: rec.connection.baseUrl || undefined,
      apiKey: rec.connection.apiKey || undefined,
      headers: Object.keys(rec.connection.headers).length ? rec.connection.headers : undefined,
    },
    system: rec.system || undefined,
    tools,
    approval: rec.approvalMode === 'confirm' && confirmGate ? confirmGate : 'auto',
    compaction: rec.compaction,
    loopBreakerMode: rec.loopBreakerMode,
    store: events,
    agentProfile: rec.id,
  };
}

export class AgentRuntime {
  private readonly cache = new Map<string, WebAgent>();
  constructor(
    private readonly events: EventStore,
    private readonly approvalUi?: ApprovalUi,
  ) {}

  agentFor(rec: AgentConfigRecord): WebAgent {
    const hit = this.cache.get(rec.id);
    if (hit) return hit;
    const agent = createWebAgent(materializeAgentConfig(rec, this.events, this.approvalUi));
    this.cache.set(rec.id, agent);
    return agent;
  }

  /** 配置保存/删除后失效缓存——下次取新 kernel；历史会话在共享库中随时可被新 kernel resume。 */
  invalidate(agentId: string): void {
    this.cache.delete(agentId);
  }
}
