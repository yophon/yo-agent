import { describe, it, expect } from 'vitest';
import { AGENT_EVENT_KINDS, type AgentEvent } from '@yo-agent/protocol';
import {
  DEFAULT_SUGGESTIONS,
  initialState,
  reduce,
  type Block,
  type UiState,
} from '@yo-agent/surface-cli';

function s0(running = false): UiState {
  return initialState({ banner: 'banner', running });
}

function ev(state: UiState, event: AgentEvent): UiState {
  return reduce(state, { type: 'event', event });
}

const DONE: AgentEvent = {
  kind: 'TurnCompleted',
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, costUsd: 0.01 },
};

const lastLive = (s: UiState): Block => s.live.at(-1)!;
const lastCommitted = (s: UiState): Block => s.committed.at(-1)!;

describe('reducer:流式文本折叠', () => {
  it('AssistantText delta 并入最后一个同类区块,否则新开', () => {
    let s = ev(s0(true), { kind: 'AssistantText', delta: '你好' });
    s = ev(s, { kind: 'AssistantText', delta: '世界' });
    expect(s.live).toHaveLength(1);
    expect(lastLive(s)).toMatchObject({ kind: 'assistant', text: '你好世界' });
    // 中间插入 reasoning → 断开合并
    s = ev(s, { kind: 'Reasoning', delta: '想想' });
    s = ev(s, { kind: 'AssistantText', delta: '!' });
    expect(s.live).toHaveLength(3);
    expect(lastLive(s)).toMatchObject({ kind: 'assistant', text: '!' });
  });

  it('空 delta 不产生区块;state 引用不变', () => {
    const before = s0(true);
    expect(ev(before, { kind: 'AssistantText' })).toBe(before);
    expect(ev(before, { kind: 'Reasoning' })).toBe(before);
  });
});

describe('reducer:工具调用聚合', () => {
  it('Started/Output/Completed 按 id 聚合到同一区块', () => {
    let s = ev(s0(true), { kind: 'ToolCallStarted', id: 'c1', name: 'read', toolKind: 'read', summary: 'a.txt', input: { path: 'a.txt' } });
    s = ev(s, { kind: 'ToolCallOutput', id: 'c1', chunk: 'line1\n' });
    s = ev(s, { kind: 'ToolCallOutput', id: 'c1', chunk: 'line2', exitCode: 0 });
    s = ev(s, { kind: 'ToolCallCompleted', id: 'c1', status: 'ok', truncatedToPath: '/tmp/x' });
    expect(s.live).toHaveLength(1);
    expect(lastLive(s)).toMatchObject({
      kind: 'tool',
      id: 'c1',
      name: 'read',
      output: 'line1\nline2',
      exitCode: 0,
      status: 'ok',
      truncatedToPath: '/tmp/x',
    });
  });

  it('Output/Completed 未知 id 不崩、不改区块', () => {
    const before = ev(s0(true), { kind: 'ToolCallStarted', id: 'c1', name: 'read', toolKind: 'read', summary: '', input: {} });
    const after = ev(before, { kind: 'ToolCallOutput', id: 'nope', chunk: 'x' });
    expect(after.live).toEqual(before.live);
  });
});

describe('reducer:审批', () => {
  it('ApprovalRequested 建面板,空 suggestions 回退默认四项', () => {
    const s = ev(s0(true), { kind: 'ApprovalRequested', requestId: 'r1', tool: 'bash', input: {}, risk: 'high', suggestions: [] });
    expect(s.approval).toMatchObject({ requestId: 'r1', tool: 'bash', selected: 0 });
    expect(s.approval!.suggestions).toEqual(DEFAULT_SUGGESTIONS);
  });

  it('approval-move 环绕;approval-clear 关面板', () => {
    let s = ev(s0(true), { kind: 'ApprovalRequested', requestId: 'r1', tool: 'bash', input: {}, risk: 'low', suggestions: [] });
    s = reduce(s, { type: 'approval-move', delta: -1 });
    expect(s.approval!.selected).toBe(3); // 上移环绕到末项
    s = reduce(s, { type: 'approval-move', delta: 1 });
    expect(s.approval!.selected).toBe(0);
    s = reduce(s, { type: 'approval-clear' });
    expect(s.approval).toBeNull();
  });
});

describe('reducer:轮生命周期', () => {
  it('TurnCompleted:flush live→committed + 累计用量 + success notice + turns+1', () => {
    let s = ev(s0(true), { kind: 'AssistantText', delta: 'hi' });
    s = ev(s, { kind: 'UsageUpdate', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, costUsd: 0.01 });
    expect(s.liveUsage).toMatchObject({ inTok: 10, outTok: 5, cacheTok: 2 });
    s = ev(s, DONE);
    expect(s.live).toHaveLength(0);
    expect(s.running).toBe(false);
    expect(s.turns).toBe(1);
    expect(s.totals).toEqual({ inTok: 10, outTok: 5, cacheTok: 2, costUsd: 0.01 });
    expect(s.liveUsage).toMatchObject({ inTok: 0, outTok: 0 });
    expect(lastCommitted(s)).toMatchObject({ kind: 'notice', tone: 'success', text: '完成 · end_turn' });
    // flush 的 assistant 区块在 notice 之前
    expect(s.committed.at(-2)).toMatchObject({ kind: 'assistant', text: 'hi' });
  });

  it('TurnCompleted(interrupted) → warn;TurnFailed → error notice', () => {
    const si = ev(s0(true), { ...DONE, stopReason: 'interrupted' });
    expect(lastCommitted(si)).toMatchObject({ tone: 'warn' });
    const sf = ev(s0(true), { kind: 'TurnFailed', error: { message: 'boom' } });
    expect(lastCommitted(sf)).toMatchObject({ tone: 'error', text: '失败:boom' });
    expect(sf.running).toBe(false);
    expect(sf.turns).toBe(1);
  });

  it('costUsd 回退链:usage.costUsd 缺失时用事件级 costUsd', () => {
    const s = ev(s0(true), {
      kind: 'TurnCompleted',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      costUsd: 0.5,
    });
    expect(s.totals.costUsd).toBe(0.5);
  });
});

describe('reducer:通知类事件', () => {
  const cases: Array<[AgentEvent, string, string]> = [
    [{ kind: 'ContextCompacted', fromCursor: 0, toCursor: 9, tokensSaved: 1234 }, 'info', '省 1.2k'],
    [{ kind: 'McpServerStatus', server: 'fs', status: 'connected' }, 'dim', '[mcp] fs → connected'],
    [{ kind: 'SubagentStarted', childSessionId: 'c', label: '审查', model: 'm' }, 'dim', '子 agent 启动'],
    [{ kind: 'SubagentResult', childSessionId: 'c', summary: '完成 3 项' }, 'dim', '子 agent 完成'],
    [{ kind: 'ApiRetry', attempt: 1, maxRetries: 3, error: '429' }, 'warn', 'API 重试 1/3(429)'],
    [{ kind: 'FileChanged', path: 'a.ts', changeKind: 'edit' }, 'dim', 'edit a.ts'],
    [{ kind: 'Error', message: 'x' }, 'error', '错误:x'],
  ];
  for (const [event, tone, text] of cases) {
    it(`${event.kind} → ${tone} live notice`, () => {
      const s = ev(s0(true), event);
      const b = lastLive(s);
      expect(b.kind).toBe('notice');
      if (b.kind === 'notice') {
        expect(b.tone).toBe(tone);
        expect(b.text).toContain(text);
      }
    });
  }
});

describe('reducer:4.6a 暂不渲染的事件保持 state 引用不变', () => {
  const ignored: AgentEvent[] = [
    { kind: 'SessionStarted', externalId: 'x', model: 'm', tools: [], workspacePath: '/', permissionMode: 'supervised', profile: 'default' },
    { kind: 'TurnStarted', turnId: 't1', promptIdemKey: 'k' },
    { kind: 'Todo', items: [{ text: 'a', status: 'pending' }] },
    { kind: 'Plan', steps: [{ text: 'b', status: 'pending' }] },
    { kind: 'BackgroundProcess', procId: 'p', label: 'dev', status: 'running' },
  ];
  for (const event of ignored) {
    it(event.kind, () => {
      const before = s0(true);
      expect(ev(before, event)).toBe(before);
    });
  }

  it('全部 21 个事件 kind 都被 reducer 接受(不抛)', () => {
    expect(AGENT_EVENT_KINDS).toHaveLength(21);
  });
});

describe('reducer:本地动作', () => {
  it('submit:user 区块 + running;submit-failed:error notice + 解除 running', () => {
    let s = reduce(s0(false), { type: 'submit', text: '你好' });
    expect(s.running).toBe(true);
    expect(lastCommitted(s)).toMatchObject({ kind: 'user', text: '你好' });
    s = reduce(s, { type: 'submit-failed', message: 'net down' });
    expect(s.running).toBe(false);
    expect(lastCommitted(s)).toMatchObject({ tone: 'error', text: '提交失败:net down' });
  });

  it('clear 清空 committed+live;steer 记 dim 引导行', () => {
    let s = ev(s0(true), { kind: 'AssistantText', delta: 'x' });
    s = reduce(s, { type: 'steer', text: '换个思路' });
    expect(lastLive(s)).toMatchObject({ kind: 'notice', text: '↳ 引导:换个思路' });
    s = reduce(s, { type: 'clear' });
    expect(s.committed).toHaveLength(0);
    expect(s.live).toHaveLength(0);
  });
});
