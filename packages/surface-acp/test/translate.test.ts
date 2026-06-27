import { describe, it, expect } from 'vitest';
import { blocksToText, eventToSessionUpdate, mapStopReason } from '@yo-agent/surface-acp';
import { ensureFsPathAllowed, FsGuardError } from '@yo-agent/surface-acp';
import type { AgentEvent, StopReason } from '@yo-agent/protocol';

describe('3F — stopReason 映射', () => {
  const cases: Array<[StopReason, string]> = [
    ['end_turn', 'end_turn'],
    ['max_tokens', 'max_tokens'],
    ['interrupted', 'cancelled'],
    ['refusal', 'refusal'],
    ['max_turn_steps', 'max_turn_requests'],
    ['tool_budget_exceeded', 'max_turn_requests'],
    ['loop_detected', 'refusal'],
    ['pause_turn', 'end_turn'],
    ['error', 'end_turn'],
  ];
  for (const [input, want] of cases) {
    it(`${input} → ${want}`, () => expect(mapStopReason(input)).toBe(want));
  }
});

describe('3F — event → session/update 翻译表', () => {
  it('AssistantText(delta) → agent_message_chunk', () => {
    const u = eventToSessionUpdate({ kind: 'AssistantText', delta: 'hi' });
    expect(u?.sessionUpdate).toBe('agent_message_chunk');
    expect(u?.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text).toBe('hi');
  });

  it('Reasoning(delta) → agent_thought_chunk', () => {
    const u = eventToSessionUpdate({ kind: 'Reasoning', delta: '想' });
    expect(u?.sessionUpdate).toBe('agent_thought_chunk');
  });

  it('ToolCallStarted → tool_call(in_progress) + kind 透传', () => {
    const u = eventToSessionUpdate({ kind: 'ToolCallStarted', id: 't1', name: 'read', toolKind: 'read', summary: '读文件', input: { path: '/a' } });
    expect(u?.sessionUpdate).toBe('tool_call');
    if (u?.sessionUpdate === 'tool_call') {
      expect(u.toolCallId).toBe('t1');
      expect(u.kind).toBe('read');
      expect(u.status).toBe('in_progress');
      expect(u.title).toBe('读文件');
    }
  });

  it('ToolCallOutput → tool_call_update(content)', () => {
    const u = eventToSessionUpdate({ kind: 'ToolCallOutput', id: 't1', chunk: 'out' });
    expect(u?.sessionUpdate).toBe('tool_call_update');
  });

  it('ToolCallCompleted(ok/error) → tool_call_update(completed/failed)', () => {
    const ok = eventToSessionUpdate({ kind: 'ToolCallCompleted', id: 't1', status: 'ok' });
    const err = eventToSessionUpdate({ kind: 'ToolCallCompleted', id: 't1', status: 'error' });
    expect(ok?.sessionUpdate === 'tool_call_update' && ok.status).toBe('completed');
    expect(err?.sessionUpdate === 'tool_call_update' && err.status).toBe('failed');
  });

  it('非翻译事件 → null（SessionStarted / ApprovalRequested / FileChanged / Usage）', () => {
    const skip: AgentEvent[] = [
      { kind: 'SessionStarted', externalId: 's', model: 'm', tools: [], workspacePath: '/w', permissionMode: 'supervised', profile: 'p' },
      { kind: 'ApprovalRequested', requestId: 'r', tool: 'echo', input: {}, risk: 'medium', suggestions: [] },
      { kind: 'FileChanged', path: '/a', changeKind: 'edit' },
      { kind: 'UsageUpdate', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
    ];
    for (const e of skip) expect(eventToSessionUpdate(e)).toBeNull();
  });
});

describe('3F — prompt ContentBlock → text', () => {
  it('text 拼接，resource_link → @uri', () => {
    expect(blocksToText([{ type: 'text', text: 'a' }, { type: 'resource_link', name: 'x', uri: 'file:///x' }])).toBe('a\n@file:///x');
  });
});

describe('3F — fs 守卫（Protected Paths + 逃逸）', () => {
  it('workspace 内普通路径放行', () => {
    expect(() => ensureFsPathAllowed('/work/src/a.ts', '/work')).not.toThrow();
  });
  it('越界路径拒（reason=escape）', () => {
    try {
      ensureFsPathAllowed('/etc/passwd', '/work');
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FsGuardError);
      expect((e as FsGuardError).reason).toBe('escape');
    }
  });
  it('../ 逃逸拒', () => {
    expect(() => ensureFsPathAllowed('/work/../secret', '/work')).toThrow(FsGuardError);
  });
  it('保护路径拒（reason=protected）：.env / .git / .ssh / *.key', () => {
    for (const p of ['/work/.env', '/work/.git/config', '/work/.ssh/id', '/work/deploy.key']) {
      try {
        ensureFsPathAllowed(p, '/work');
        throw new Error(`should throw for ${p}`);
      } catch (e) {
        expect(e).toBeInstanceOf(FsGuardError);
        expect((e as FsGuardError).reason).toBe('protected');
      }
    }
  });
});
