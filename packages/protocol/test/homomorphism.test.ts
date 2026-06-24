import { describe, it, expect } from 'vitest';
import { AGENT_EVENT_KINDS } from '@yo-agent/protocol';

/**
 * Phase 0 退出标准：与 yo-aichat AgentEvent 同构性 review（DESIGN §6.4）。
 *
 * yo-aichat 的 sealed AgentEvent 共 14 个变体（实测自
 * yo-aichat/packages/core/lib/src/agent_event.dart，2026-06-24）。bridge 的
 * YoAgentAdapter 把 yo-agent 事件转成 bridge 归一事件——因为同构，几乎是恒等映射。
 * 本测试断言：每个 yo-aichat 变体都有对应的 yo-agent kind，且 yo-agent 是其超集。
 */
const YO_AICHAT_VARIANTS = [
  'SessionStarted',
  'AssistantText',
  'Reasoning',
  'ToolCallStarted',
  'ToolCallOutput',
  'ToolCallCompleted',
  'FileChanged',
  'TodoUpdated',
  'ApprovalRequested',
  'ApiRetry',
  'TurnCompleted',
  'TurnFailed',
  'BackgroundProcess',
  'AgentErrorEvent',
] as const;

// yo-aichat 变体 → yo-agent kind（仅两处改名：TodoUpdated→Todo、AgentErrorEvent→Error）
const HOMOMORPHISM: Record<(typeof YO_AICHAT_VARIANTS)[number], string> = {
  SessionStarted: 'SessionStarted',
  AssistantText: 'AssistantText',
  Reasoning: 'Reasoning',
  ToolCallStarted: 'ToolCallStarted',
  ToolCallOutput: 'ToolCallOutput',
  ToolCallCompleted: 'ToolCallCompleted',
  FileChanged: 'FileChanged',
  TodoUpdated: 'Todo',
  ApprovalRequested: 'ApprovalRequested',
  ApiRetry: 'ApiRetry',
  TurnCompleted: 'TurnCompleted',
  TurnFailed: 'TurnFailed',
  BackgroundProcess: 'BackgroundProcess',
  AgentErrorEvent: 'Error',
};

describe('与 yo-aichat AgentEvent 同构性（Phase 0 退出标准）', () => {
  it('映射是全的：14 个 yo-aichat 变体都有对应 yo-agent kind', () => {
    for (const v of YO_AICHAT_VARIANTS) {
      const target = HOMOMORPHISM[v];
      expect(target, `yo-aichat ${v} 缺映射`).toBeTruthy();
      expect(AGENT_EVENT_KINDS, `yo-agent 缺 kind ${target}`).toContain(target);
    }
  });

  it('yo-agent 是严格超集（独有 6 个：TurnStarted/Plan/Subagent*/ContextCompacted/UsageUpdate）', () => {
    const mappedTargets = new Set(Object.values(HOMOMORPHISM));
    const yoAgentOnly = AGENT_EVENT_KINDS.filter((k) => !mappedTargets.has(k));
    expect(yoAgentOnly).toEqual(
      expect.arrayContaining([
        'TurnStarted',
        'Plan',
        'SubagentStarted',
        'SubagentResult',
        'ContextCompacted',
        'UsageUpdate',
      ]),
    );
  });
});
