import { describe, it, expect } from 'vitest';
import { ResumeBuffer, gapOverflowSummary, SIGNIFICANT_EVENT_KINDS } from '@yo-agent/store';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';

function env(cursor: number, event: AgentEvent): EventEnvelope {
  return { sessionId: 's1', cursor, parentId: null, turnId: null, ts: cursor, event };
}

describe('ResumeBuffer', () => {
  it('fromCursor 仍在缓冲 → 返回缺口 (fromCursor, head]', () => {
    const buf = new ResumeBuffer(10);
    for (let c = 0; c < 5; c++) buf.add(env(c, { kind: 'AssistantText', delta: String(c) }));
    const gap = buf.since('s1', 2);
    expect(gap?.map((e) => e.cursor)).toEqual([3, 4]);
  });

  it('fromCursor 已被淘汰（容量溢出）→ null（gap 溢出）', () => {
    const buf = new ResumeBuffer(3); // 只留最近 3 帧
    for (let c = 0; c < 6; c++) buf.add(env(c, { kind: 'AssistantText', delta: String(c) }));
    expect(buf.oldestCursor('s1')).toBe(3);
    expect(buf.since('s1', 1)).toBeNull(); // 1+1 < 3，缺口有空洞
    expect(buf.since('s1', 3)?.map((e) => e.cursor)).toEqual([4, 5]); // 边界仍可覆盖
  });

  it('未知 session：fromCursor<0 视为新连接返回空，否则 null', () => {
    const buf = new ResumeBuffer();
    expect(buf.since('nope', -1)).toEqual([]);
    expect(buf.since('nope', 5)).toBeNull();
  });

  it('上界防护：fromCursor 超过 head（陈旧/未来 cursor）→ null（强制全量重放），不静默丢事件', () => {
    const buf = new ResumeBuffer(10);
    for (let c = 0; c < 5; c++) buf.add(env(c, { kind: 'AssistantText', delta: String(c) })); // head=4
    expect(buf.since('s1', 50)).toBeNull(); // 不是 []
    expect(buf.since('s1', 4)).toEqual([]); // 恰好追平
  });
});

describe('gapOverflowSummary', () => {
  it('只保留显著事件，折叠 AssistantText/ToolCallOutput/Reasoning/Usage 流式噪声', () => {
    const events: EventEnvelope[] = [
      env(0, { kind: 'SessionStarted', externalId: 's1', model: 'm', tools: [], workspacePath: '/', permissionMode: 'supervised', profile: 'default' }),
      env(1, { kind: 'TurnStarted', turnId: 't1', promptIdemKey: 'k' }),
      env(2, { kind: 'AssistantText', delta: 'hello' }),
      env(3, { kind: 'Reasoning', delta: 'think' }),
      env(4, { kind: 'ToolCallStarted', id: 'c1', name: 'read', toolKind: 'read', summary: 'read', input: {} }),
      env(5, { kind: 'ToolCallOutput', id: 'c1', chunk: '....' }),
      env(6, { kind: 'ToolCallCompleted', id: 'c1', status: 'ok' }),
      env(7, { kind: 'FileChanged', path: 'a.ts', changeKind: 'edit' }),
      env(8, { kind: 'UsageUpdate', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }),
      env(9, { kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } }),
    ];
    const kept = gapOverflowSummary(events).map((e) => e.event.kind);
    expect(kept).toEqual(['SessionStarted', 'TurnStarted', 'ToolCallStarted', 'ToolCallCompleted', 'FileChanged', 'TurnCompleted']);
    // cursor 仍单调。
    const cursors = gapOverflowSummary(events).map((e) => e.cursor);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
  });

  it('SIGNIFICANT_EVENT_KINDS 含审批/压缩/后台进程（离散状态迁移），折叠流式', () => {
    expect(SIGNIFICANT_EVENT_KINDS.has('ApprovalRequested')).toBe(true);
    expect(SIGNIFICANT_EVENT_KINDS.has('ContextCompacted')).toBe(true);
    expect(SIGNIFICANT_EVENT_KINDS.has('BackgroundProcess')).toBe(true); // §6.3 状态变更须保留
    expect(SIGNIFICANT_EVENT_KINDS.has('AssistantText')).toBe(false);
  });

  it('BackgroundProcess 在 gap 溢出后保留（不被当流式噪声折叠）', () => {
    const events: EventEnvelope[] = [
      env(0, { kind: 'AssistantText', delta: 'x' }),
      env(1, { kind: 'BackgroundProcess', procId: 'p1', label: 'build', status: 'exited', exitCode: 0 }),
    ];
    expect(gapOverflowSummary(events).map((e) => e.event.kind)).toEqual(['BackgroundProcess']);
  });
});
