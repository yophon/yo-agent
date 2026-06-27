/**
 * ACP 翻译层（3F / DESIGN §6）：内核事件 ↔ ACP session/update + stopReason 纯映射。
 * 纯函数、无副作用、可离线单测——AcpSurface 仅在此调用，保证翻译同步、不乱序。
 */
import type { AgentEvent, StopReason } from '@yo-agent/protocol';
import type { ContentBlock, PromptResponse, SessionNotification } from '@zed-industries/agent-client-protocol';

/** ACP PromptResponse.stopReason 取值。 */
export type AcpStopReason = PromptResponse['stopReason'];
/** ACP session/update 负载（SessionNotification.update 联合）。 */
export type AcpSessionUpdate = SessionNotification['update'];

/**
 * 内核 StopReason → ACP stopReason 完整映射表（DESIGN §6 / 3F）。
 * ACP 只有 5 值：end_turn / max_tokens / max_turn_requests / refusal / cancelled。
 * - interrupted → cancelled（用户 session/cancel）
 * - max_turn_steps / tool_budget_exceeded → max_turn_requests（命中轮次/预算上限语义最近）
 * - loop_detected → refusal（agent 放弃）
 * - pause_turn / error → end_turn 兜底（pause 不应外泄；error 走 TurnFailed 抛错，不到此）
 */
export function mapStopReason(stop: StopReason): AcpStopReason {
  switch (stop) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'interrupted':
      return 'cancelled';
    case 'refusal':
      return 'refusal';
    case 'max_turn_steps':
    case 'tool_budget_exceeded':
      return 'max_turn_requests';
    case 'loop_detected':
      return 'refusal';
    case 'pause_turn':
    case 'error':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/** 文本 ContentBlock。 */
function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

/**
 * 内核 AgentEvent → ACP session/update 负载。返回 null = 本事件不翻译（如 SessionStarted / Usage /
 * ApprovalRequested（走反向 requestPermission 而非 update）/ FileChanged（MVP 不带 diff，由 tool_call 覆盖））。
 */
export function eventToSessionUpdate(event: AgentEvent): AcpSessionUpdate | null {
  switch (event.kind) {
    case 'AssistantText': {
      const text = event.delta ?? event.full;
      if (!text) return null;
      return { sessionUpdate: 'agent_message_chunk', content: textBlock(text) };
    }
    case 'Reasoning': {
      const text = event.delta ?? event.text;
      if (!text) return null;
      return { sessionUpdate: 'agent_thought_chunk', content: textBlock(text) };
    }
    case 'ToolCallStarted':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: event.id,
        title: event.summary || event.name,
        kind: event.toolKind, // 内核 ToolKind ⊆ ACP ToolKind
        status: 'in_progress',
        rawInput: toRawObject(event.input),
      };
    case 'ToolCallOutput':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.id,
        content: [{ type: 'content', content: textBlock(event.chunk) }],
      };
    case 'ToolCallCompleted':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.id,
        status: event.status === 'ok' ? 'completed' : 'failed',
      };
    default:
      return null;
  }
}

/** rawInput 必须是对象；非对象 input 包一层 { value }。 */
function toRawObject(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (input === undefined) return undefined;
  return { value: input };
}

/** ACP prompt 的 ContentBlock[] → 单条文本（text 拼接；resource_link/resource 退化为 @uri 标注）。 */
export function blocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'resource_link') parts.push(`@${b.uri}`);
    else if (b.type === 'resource') {
      const r = b.resource as { text?: string; uri?: string };
      if (typeof r.text === 'string') parts.push(r.text);
      else if (typeof r.uri === 'string') parts.push(`@${r.uri}`);
      else parts.push('[resource]');
    }
    // image/audio：MVP 不声明能力；不静默丢，产占位标注（审查 L6）。
    else if (b.type === 'image') parts.push('[image]');
    else if (b.type === 'audio') parts.push('[audio]');
  }
  return parts.join('\n');
}
