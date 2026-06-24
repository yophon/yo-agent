import { describe, it, expect } from 'vitest';
import {
  AgentEventSchema,
  EventEnvelopeSchema,
  AGENT_EVENT_KINDS,
} from '@yo-agent/protocol';

describe('AgentEvent sealed union', () => {
  it('恰好覆盖 DESIGN §2.2 的 20 个变体且无重复', () => {
    expect(AGENT_EVENT_KINDS).toHaveLength(20);
    expect(new Set(AGENT_EVENT_KINDS).size).toBe(20);
    expect(AGENT_EVENT_KINDS).toContain('SessionStarted');
    expect(AGENT_EVENT_KINDS).toContain('TurnCompleted');
    expect(AGENT_EVENT_KINDS).toContain('ApprovalRequested');
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
