/**
 * 控制台全局状态（Phase 5.1d，单例模块）：初始化两库（事件库共享单例 + 控制台配置库）、
 * agent CRUD、confirm 审批的弹窗管道。逻辑全在 .ts（biome 可 lint / vitest 可测），.vue 只做绑定。
 */
import { reactive } from 'vue';
import type { ConsoleStore } from './console-store';
import { LocalConsoleStore, MemoryConsoleStore } from './console-store';
import type { ApprovalPrompt, SharedEventStore } from './runtime';
import { AgentRuntime, openSharedEventStore } from './runtime';
import type { SessionListItem } from './session-list';
import { listSessionItems } from './session-list';
import type { AgentConfigRecord } from './types';

interface PendingApproval extends ApprovalPrompt {
  resolve: (allow: boolean) => void;
}

export class AppContext {
  console!: ConsoleStore;
  shared!: SharedEventStore;
  runtime!: AgentRuntime;

  readonly state = reactive({
    ready: false,
    /** false = 事件库降级内存（隐私模式等），顶栏提示本次会话不持久。 */
    persistent: true,
    agents: [] as AgentConfigRecord[],
    sessions: [] as SessionListItem[],
  });

  /**
   * confirm 审批弹窗管道：gate 挂 Promise，UI 弹窗决策后 resolve。
   * 用队列而非单槽——即便同一时刻涌入多个审批请求也不会互相覆盖丢 resolve（否则被覆盖的 turn 永久挂起）。
   * UI 只显示 queue[0]，逐个裁决。
   */
  readonly approval = reactive<{ queue: PendingApproval[] }>({ queue: [] });

  async init(): Promise<void> {
    if (this.state.ready) return;
    this.console = await LocalConsoleStore.open().catch(() => new MemoryConsoleStore());
    this.shared = await openSharedEventStore();
    this.runtime = new AgentRuntime(this.shared.store, (req) => this.requestApproval(req));
    this.state.agents = await this.console.listAgents();
    this.state.persistent = this.shared.persistent;
    await this.refreshSessions();
    this.state.ready = true;
  }

  /** 刷新侧栏会话列表（开会话/turn 结束/删除后调用）。 */
  async refreshSessions(): Promise<void> {
    this.state.sessions = await listSessionItems(this.shared.store, this.console, this.state.agents);
  }

  /** 删除会话：持久事件+行 + 控制台元数据；调用方须先 dispose 活 controller。 */
  async removeSession(sessionId: string): Promise<void> {
    await this.shared.deleteSession?.(sessionId);
    await this.console.deleteSessionMeta(sessionId);
    await this.refreshSessions();
  }

  agentById(id: string): AgentConfigRecord | undefined {
    return this.state.agents.find((a) => a.id === id);
  }

  async saveAgent(rec: AgentConfigRecord): Promise<void> {
    rec.updatedAt = Date.now();
    await this.console.saveAgent(rec);
    this.runtime.invalidate(rec.id); // 下次取即新 kernel；历史会话在共享库随时可 resume
    this.state.agents = await this.console.listAgents();
  }

  async removeAgent(id: string): Promise<void> {
    await this.console.deleteAgent(id);
    this.runtime.invalidate(id);
    this.state.agents = await this.console.listAgents();
  }

  private requestApproval(req: ApprovalPrompt): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.approval.queue.push({ ...req, resolve });
    });
  }

  decideApproval(allow: boolean): void {
    const cur = this.approval.queue.shift();
    cur?.resolve(allow);
  }
}

/** 单例：main.ts init 后全应用共用。 */
export const app = new AppContext();
