import { describe, it, expect } from 'vitest';
import { formatHeadless } from '@yo-agent/surface-cli';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';

function wrap(event: AgentEvent): EventEnvelope {
  return { sessionId: 's', cursor: 0, parentId: null, turnId: null, ts: 0, event };
}

describe('formatHeadless', () => {
  it('AssistantText.delta 直出；Reasoning/Usage 折叠为 null', () => {
    expect(formatHeadless(wrap({ kind: 'AssistantText', delta: 'hi' }))).toBe('hi');
    expect(formatHeadless(wrap({ kind: 'Reasoning', delta: 'think' }))).toBeNull();
    expect(formatHeadless(wrap({ kind: 'UsageUpdate', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }))).toBeNull();
  });

  it('工具/压缩/完成/失败有文本', () => {
    expect(formatHeadless(wrap({ kind: 'ToolCallStarted', id: 'c', name: 'read', toolKind: 'read', summary: '', input: {} }))).toContain('read');
    expect(formatHeadless(wrap({ kind: 'ContextCompacted', fromCursor: 0, toCursor: 5, tokensSaved: 42 }))).toContain('42');
    expect(formatHeadless(wrap({ kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }))).toContain('end_turn');
    expect(formatHeadless(wrap({ kind: 'TurnFailed', error: { message: '炸了' } }))).toContain('炸了');
  });

  it('ApprovalRequested 提示 headless 默认拒绝', () => {
    const s = formatHeadless(wrap({ kind: 'ApprovalRequested', requestId: 'r', tool: 'write', input: {}, risk: 'high', suggestions: [] }));
    expect(s).toContain('write');
    expect(s).toContain('拒绝');
  });
});
