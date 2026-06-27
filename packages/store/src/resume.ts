/**
 * resume 重连支持（DESIGN §6.3 / §10.1）。
 * - ResumeBuffer：内存 ring，服务实时重连——fromCursor 仍在缓冲则重放缺口 [fromCursor+1 .. head]。
 * - gapOverflowSummary：fromCursor 被淘汰（gap 溢出）时，从全量 EventLog 取"状态变更/审批/FileChanged"摘要，
 *   折叠 AssistantText/ToolCallOutput/Reasoning/Usage 等流式噪声（审计不丢，借鉴 yo-aichat replay_gap_overflow）。
 *
 * 本文件纯内存 / 纯函数，全离线可测；RPC Surface（Phase 2）据此实现 session/reconnect。
 */
import type { AgentEventKind, Cursor, EventEnvelope } from '@yo-agent/protocol';

/** 跨重连需保留的"显著"事件类型（状态变更 / 审批 / 文件变更 / 完成态）。 */
export const SIGNIFICANT_EVENT_KINDS: ReadonlySet<AgentEventKind> = new Set<AgentEventKind>([
  'SessionStarted',
  'TurnStarted',
  'ToolCallStarted',
  'ToolCallCompleted',
  'FileChanged',
  'Todo',
  'Plan',
  'ApprovalRequested',
  'SubagentStarted',
  'SubagentResult',
  'BackgroundProcess', // 离散状态迁移（running/exited），非流式噪声（§6.3 属"状态变更"）
  'McpServerStatus', // MCP 连接状态迁移（3C：连接/断连/熔断），离散状态变更非流式噪声
  'ContextCompacted',
  'TurnCompleted',
  'TurnFailed',
  'Error',
]);

/** 流式噪声（gap 溢出时折叠）。 */
function isSignificant(env: EventEnvelope): boolean {
  return SIGNIFICANT_EVENT_KINDS.has(env.event.kind);
}

/**
 * gap 溢出降级：只保留显著事件，折叠中间流式过程（审计不丢、带宽省）。
 * 返回过滤后的事件序列（cursor 保持原值，保证仍单调）。
 */
export function gapOverflowSummary(events: EventEnvelope[]): EventEnvelope[] {
  return events.filter(isSignificant);
}

export class ResumeBuffer {
  private readonly capacity: number;
  /** 按 session 维护 ring（最近 N 帧）。 */
  private readonly ring = new Map<string, EventEnvelope[]>();

  constructor(capacity = 256) {
    this.capacity = Math.max(1, capacity);
  }

  add(env: EventEnvelope): void {
    const arr = this.ring.get(env.sessionId) ?? [];
    arr.push(env);
    if (arr.length > this.capacity) arr.splice(0, arr.length - this.capacity);
    this.ring.set(env.sessionId, arr);
  }

  /** 缓冲内最早事件的 cursor（用于判断 fromCursor 是否已被淘汰）。 */
  oldestCursor(sessionId: string): Cursor | null {
    const arr = this.ring.get(sessionId);
    return arr && arr.length > 0 ? arr[0]!.cursor : null;
  }

  /**
   * 取 fromCursor 之后的缺口。fromCursor 仍可由缓冲覆盖（>= oldest-1）→ 返回缺口事件；
   * 否则返回 null 表示 gap 溢出，调用方应走 gapOverflowSummary 从全量 EventLog 降级。
   */
  since(sessionId: string, fromCursor: Cursor): EventEnvelope[] | null {
    const arr = this.ring.get(sessionId);
    if (!arr || arr.length === 0) return fromCursor < 0 ? [] : null;
    const oldest = arr[0]!.cursor;
    const head = arr[arr.length - 1]!.cursor;
    // 下界：fromCursor+1 必须 >= oldest 才能保证缺口完整（无空洞）。
    // 上界：fromCursor 不得超过 head（陈旧/未来 cursor，如进程重启 cursor 重排）——否则误返回空被当"已追平"丢事件；
    // 返回 null 强制走全量 EventLog 重放。fromCursor===head 仍返回 []（已追平）。
    if (fromCursor + 1 < oldest || fromCursor > head) return null;
    return arr.filter((e) => e.cursor > fromCursor);
  }
}
