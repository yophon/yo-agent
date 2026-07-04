/**
 * ChatController —— headless 事件流→聊天状态适配器（PHASE-5 5C）。
 * 把 kernel 的 AgentEvent 流归约成 UI 无关的 ChatState（消息/流式增量/工具态/用量），
 * 任何宿主 UI（原生挂件 / React / Vue / 小程序）经 onChange 消费；零 DOM 依赖。
 * 自定义审批 UI 不走这里——用 WebAgentConfig.approval 传 ApprovalGate（gate 内直接弹窗）。
 */
import type { EventEnvelope, Id } from '@yo-agent/protocol';
import type { WebAgent } from './agent';

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatToolPart {
  type: 'tool';
  id: string;
  name: string;
  /** 内核生成的一句话摘要（如「查订单 42」），挂件折叠态直接展示。 */
  summary: string;
  input: unknown;
  output: string;
  status: 'running' | 'ok' | 'error';
}

export type ChatPart = ChatTextPart | ChatToolPart;

export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: ChatPart[];
  status: 'streaming' | 'done' | 'error';
}

export interface ChatTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ChatState {
  sessionId?: Id;
  messages: ChatMessage[];
  turnActive: boolean;
  /** 最近一次失败文案（TurnFailed/Error/send 拒绝）；下一次 send 时清空。 */
  error?: string;
  /** 跨 turn 累计用量（中转站不回 usage 时保持 0，挂件降级为不显示）。 */
  totals: ChatTotals;
}

/**
 * 状态语义：`state` 为内部可变对象，每次归约后通知 onChange 订阅者——
 * 原生挂件直接读没有问题；接 React 等需快照语义的框架时在回调里自行浅拷贝。
 */
export class ChatController {
  private readonly agent: WebAgent;
  private sessionId?: Id;
  private unsub?: () => void;
  private readonly listeners = new Set<(s: ChatState) => void>();

  readonly state: ChatState = {
    messages: [],
    turnActive: false,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };

  constructor(agent: WebAgent) {
    this.agent = agent;
  }

  /** 开会话并订阅事件流；send 首次调用会自动 start，可显式提前建连。 */
  async start(): Promise<Id> {
    if (this.sessionId) return this.sessionId;
    const sid = await this.agent.startSession();
    this.sessionId = sid;
    this.state.sessionId = sid;
    this.unsub = this.agent.kernel.subscribe(sid, null, (env) => this.reduce(env));
    this.emit();
    return sid;
  }

  onChange(cb: (s: ChatState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * 发一轮用户输入；resolve 于 turn 结束。turn 内的失败经事件落 state.error，
   * 不向调用方抛（挂件读状态即可）；仅「上一轮未结束」这类用法错误同步抛。
   */
  async send(text: string): Promise<void> {
    if (this.state.turnActive) {
      throw new Error('上一轮未结束：等 TurnCompleted，或先 interrupt()');
    }
    const sid = this.sessionId ?? (await this.start());
    this.state.error = undefined;
    this.state.messages.push({ role: 'user', parts: [{ type: 'text', text }], status: 'done' });
    this.emit();
    try {
      await this.agent.kernel.submitInput(sid, text, globalThis.crypto.randomUUID());
    } catch (e) {
      this.state.turnActive = false;
      this.state.error = e instanceof Error ? e.message : String(e);
      this.closeAssistant('error');
      this.emit();
    }
  }

  /** turn 进行中追加引导（显示为一条用户消息）。 */
  async steer(text: string): Promise<void> {
    if (!this.sessionId || !this.state.turnActive) {
      throw new Error('steer 只在 turn 进行中有效；空闲时用 send()');
    }
    this.state.messages.push({ role: 'user', parts: [{ type: 'text', text }], status: 'done' });
    this.emit();
    await this.agent.kernel.steer(this.sessionId, text);
  }

  /** 中断当前 turn（取消 in-flight 的 LLM/工具调用）；空闲时为 no-op。 */
  async interrupt(): Promise<void> {
    if (this.sessionId && this.state.turnActive) await this.agent.kernel.interrupt(this.sessionId);
  }

  /** 结束当前会话、清空状态、开新会话（挂件「新对话」按钮）。 */
  async newSession(): Promise<Id> {
    this.dispose();
    this.state.messages = [];
    this.state.turnActive = false;
    this.state.error = undefined;
    this.state.totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    return this.start();
  }

  /** 退订并驱逐会话（宿主卸载挂件时调用，防常驻泄漏）。 */
  dispose(): void {
    this.unsub?.();
    this.unsub = undefined;
    if (this.sessionId) this.agent.kernel.endSession(this.sessionId);
    this.sessionId = undefined;
    this.state.sessionId = undefined;
  }

  // ───────────────────────── 事件归约 ─────────────────────────

  private reduce(env: EventEnvelope): void {
    const e = env.event;
    switch (e.kind) {
      case 'TurnStarted': {
        this.state.turnActive = true;
        // 立即开 assistant 消息（挂件可显示输入中指示）。
        this.state.messages.push({ role: 'assistant', parts: [], status: 'streaming' });
        break;
      }
      case 'AssistantText': {
        const msg = this.currentAssistant();
        const last = msg.parts[msg.parts.length - 1];
        if (e.full !== undefined) {
          if (last?.type === 'text') last.text = e.full;
          else msg.parts.push({ type: 'text', text: e.full });
        } else if (e.delta) {
          if (last?.type === 'text') last.text += e.delta;
          else msg.parts.push({ type: 'text', text: e.delta });
        }
        break;
      }
      case 'ToolCallStarted': {
        this.currentAssistant().parts.push({
          type: 'tool',
          id: e.id,
          name: e.name,
          summary: e.summary,
          input: e.input,
          output: '',
          status: 'running',
        });
        break;
      }
      case 'ToolCallOutput': {
        const part = this.findToolPart(e.id);
        if (part) part.output += e.chunk;
        break;
      }
      case 'ToolCallCompleted': {
        const part = this.findToolPart(e.id);
        if (part) part.status = e.status;
        break;
      }
      case 'TurnCompleted': {
        this.state.turnActive = false;
        this.closeAssistant('done');
        this.state.totals.inputTokens += e.usage.inputTokens;
        this.state.totals.outputTokens += e.usage.outputTokens;
        this.state.totals.costUsd += e.costUsd ?? e.usage.costUsd ?? 0;
        break;
      }
      case 'TurnFailed': {
        this.state.turnActive = false;
        this.state.error = e.error.message;
        this.closeAssistant('error');
        break;
      }
      case 'Error': {
        this.state.error = e.message;
        break;
      }
      default:
        // Reasoning/Todo/Plan/Usage 中间量等对客服挂件不呈现；需要时宿主可自行 kernel.subscribe。
        break;
    }
    this.emit();
  }

  private currentAssistant(): ChatMessage {
    const last = this.state.messages[this.state.messages.length - 1];
    if (last?.role === 'assistant' && last.status === 'streaming') return last;
    const msg: ChatMessage = { role: 'assistant', parts: [], status: 'streaming' };
    this.state.messages.push(msg);
    return msg;
  }

  private closeAssistant(status: 'done' | 'error'): void {
    const last = this.state.messages[this.state.messages.length - 1];
    if (last?.role === 'assistant' && last.status === 'streaming') last.status = status;
  }

  private findToolPart(id: string): ChatToolPart | undefined {
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const msg = this.state.messages[i];
      if (msg.role !== 'assistant') continue;
      for (const p of msg.parts) {
        if (p.type === 'tool' && p.id === id) return p;
      }
    }
    return undefined;
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.state);
  }
}
