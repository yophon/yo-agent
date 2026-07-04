import { describe, it, expect } from 'vitest';
import {
  AgentEventSchema,
  EventEnvelopeSchema,
  AGENT_EVENT_KINDS,
} from '@yo-agent/protocol';

describe('AgentEvent sealed union', () => {
  it('恰好覆盖 DESIGN §2.2 的 22 个变体且无重复（3C 增 McpServerStatus，5.1b 增 UserMessage）', () => {
    expect(AGENT_EVENT_KINDS).toHaveLength(22);
    expect(new Set(AGENT_EVENT_KINDS).size).toBe(22);
    expect(AGENT_EVENT_KINDS).toContain('SessionStarted');
    expect(AGENT_EVENT_KINDS).toContain('TurnCompleted');
    expect(AGENT_EVENT_KINDS).toContain('ApprovalRequested');
    expect(AGENT_EVENT_KINDS).toContain('McpServerStatus');
    expect(AGENT_EVENT_KINDS).toContain('UserMessage');
  });

  it('UserMessage 事件（5.1b）：text 必填，source 只认 prompt|steer', () => {
    expect(AgentEventSchema.safeParse({ kind: 'UserMessage', text: '在吗', source: 'prompt' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ kind: 'UserMessage', text: '补充', source: 'steer' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ kind: 'UserMessage', text: 'x', source: 'other' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ kind: 'UserMessage', source: 'prompt' }).success).toBe(false);
  });

  it('校验合法 McpServerStatus 事件（3C 连接可观测）', () => {
    expect(
      AgentEventSchema.safeParse({ kind: 'McpServerStatus', server: 'fs', status: 'connected', toolCount: 3 }).success,
    ).toBe(true);
    expect(AgentEventSchema.safeParse({ kind: 'McpServerStatus', server: 'fs', status: 'nope' }).success).toBe(false);
  });

  it('ContextCompacted 兼容旧三字段，并接受 3D 结构化 handoffSummary/preservedIdentifiers', () => {
    // 旧事件（无新字段）仍合法——向后兼容。
    expect(
      AgentEventSchema.safeParse({ kind: 'ContextCompacted', fromCursor: 1, toCursor: 5, tokensSaved: 100 }).success,
    ).toBe(true);
    // 带结构化交接的新事件。
    const r = AgentEventSchema.safeParse({
      kind: 'ContextCompacted',
      fromCursor: 1,
      toCursor: 5,
      tokensSaved: 100,
      handoffSummary: { goal: 'G', whatHappened: 'H', currentState: 'C', nextSteps: 'N' },
      preservedIdentifiers: ['uuid-1', 'path/a.ts'],
    });
    expect(r.success).toBe(true);
    // handoffSummary 缺节 → 拒绝（四节必填）。
    expect(
      AgentEventSchema.safeParse({
        kind: 'ContextCompacted',
        fromCursor: 1,
        toCursor: 5,
        tokensSaved: 100,
        handoffSummary: { goal: 'G' },
      }).success,
    ).toBe(false);
  });

  it('校验合法 SessionStarted 信封', () => {
    const env = {
      sessionId: 'sess_1',
      cursor: 0,
      parentId: null,
      turnId: null,
      ts: 1_700_000_000_000,
      event: {
        kind: 'SessionStarted',
        externalId: 'ext_1',
        model: 'claude-opus-4-8',
        tools: ['read', 'bash'],
        workspacePath: '/w',
        permissionMode: 'supervised',
        profile: 'default',
      },
    };
    expect(EventEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('拒绝未知 kind', () => {
    expect(AgentEventSchema.safeParse({ kind: 'Nope' }).success).toBe(false);
  });

  it('cursor 必须是非负整数', () => {
    const bad = {
      sessionId: 's',
      cursor: -1,
      parentId: null,
      turnId: null,
      ts: 1,
      event: { kind: 'Error', message: 'x' },
    };
    expect(EventEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('TurnCompleted.usage 缺字段时拒绝', () => {
    const bad = { kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 1 } };
    expect(AgentEventSchema.safeParse(bad).success).toBe(false);
  });
});
