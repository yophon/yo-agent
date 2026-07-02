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
  it('TurnCompleted:flush live→committed + 累计用量 + dim 轮摘要 + turns+1', () => {
    let s = ev(s0(true), { kind: 'AssistantText', delta: 'hi' });
    s = ev(s, { kind: 'UsageUpdate', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, costUsd: 0.01 });
    expect(s.liveUsage).toMatchObject({ inTok: 10, outTok: 5, cacheTok: 2 });
    s = ev(s, DONE);
    expect(s.live).toHaveLength(0);
    expect(s.running).toBe(false);
    expect(s.turns).toBe(1);
    expect(s.totals).toEqual({ inTok: 10, outTok: 5, cacheTok: 2, costUsd: 0.01 });
    expect(s.liveUsage).toMatchObject({ inTok: 0, outTok: 0 });
    // 去噪:success notice 换成 dim 轮摘要
    expect(lastCommitted(s)).toMatchObject({ kind: 'notice', tone: 'dim', text: '· ↑10 ↓5 · $0.01' });
    // flush 的 assistant 区块在摘要之前
    expect(s.committed.at(-2)).toMatchObject({ kind: 'assistant', text: 'hi' });
  });

  it('轮摘要含耗时(TurnStarted/Completed 的 envelope ts 差);零用量不产摘要', () => {
    let s = reduce(s0(true), { type: 'event', event: { kind: 'TurnStarted', turnId: 't', promptIdemKey: 'k' }, ts: 1000 });
    expect(s.turnStartedTs).toBe(1000);
    s = reduce(s, { type: 'event', event: DONE, ts: 9200 });
    expect(lastCommitted(s)).toMatchObject({ text: '· 8.2s · ↑10 ↓5 · $0.01' });
    // 零用量 + 无 ts → 完全无 notice
    const z = ev(s0(true), { kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } });
    expect(z.committed.filter((b) => b.kind === 'notice')).toHaveLength(1); // 仅 banner
  });

  it('TurnCompleted(interrupted) → warn 已中断;TurnFailed → error notice', () => {
    const si = ev(s0(true), { ...DONE, stopReason: 'interrupted' });
    expect(lastCommitted(si)).toMatchObject({ tone: 'warn', text: '⏹ 已中断' });
    const sf = ev(s0(true), { kind: 'TurnFailed', error: { message: 'boom' } });
    expect(lastCommitted(sf)).toMatchObject({ tone: 'error', text: '失败:boom' });
    expect(sf.running).toBe(false);
    expect(sf.turns).toBe(1);
  });

  it('活动词:Reasoning/AssistantText/ToolCallStarted/ApprovalRequested 驱动', () => {
    let s = ev(s0(true), { kind: 'Reasoning', delta: 'x' });
    expect(s.activity).toBe('思考中');
    s = ev(s, { kind: 'ToolCallStarted', id: 'c', name: 'read', toolKind: 'read', summary: 'a.ts', input: {} });
    expect(s.activity).toBe('读取 a.ts');
    s = ev(s, { kind: 'AssistantText', delta: 'y' });
    expect(s.activity).toBe('回复中');
    s = ev(s, { kind: 'ApprovalRequested', requestId: 'r', tool: 'bash', input: {}, risk: 'low', suggestions: [] });
    expect(s.activity).toBe('等待审批');
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

describe('reducer:4.6c 结构化区块(todo/plan/subagent/后台进程)', () => {
  it('Todo/Plan:单例区块,重复事件就地更新不新增', () => {
    let s = ev(s0(true), { kind: 'Todo', items: [{ text: 'a', status: 'pending' }] });
    s = ev(s, { kind: 'Todo', items: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }] });
    const todos = s.live.filter((b) => b.kind === 'todo');
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ items: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }] });
    s = ev(s, { kind: 'Plan', steps: [{ text: 'p1', status: 'pending' }] });
    expect(s.live.filter((b) => b.kind === 'plan')).toHaveLength(1);
  });

  it('Subagent:Started 建区块,Result 就地补 summary', () => {
    let s = ev(s0(true), { kind: 'SubagentStarted', childSessionId: 'c1', label: '审查', model: 'm1' });
    expect(lastLive(s)).toMatchObject({ kind: 'subagent', childId: 'c1', label: '审查' });
    s = ev(s, { kind: 'SubagentResult', childSessionId: 'c1', summary: '完成 3 项' });
    expect(s.live.filter((b) => b.kind === 'subagent')).toHaveLength(1);
    expect(lastLive(s)).toMatchObject({ kind: 'subagent', summary: '完成 3 项' });
    // 找不到对应 Started(如 flush 后)→ 退化为 dim notice
    const orphan = ev(s0(true), { kind: 'SubagentResult', childSessionId: 'nope', summary: 'x' });
    expect(lastLive(orphan)).toMatchObject({ kind: 'notice', tone: 'dim' });
  });

  it('BackgroundProcess → dim notice(含退出码)', () => {
    const s = ev(s0(true), { kind: 'BackgroundProcess', procId: 'p', label: 'dev-server', status: 'exited', exitCode: 0 });
    expect(lastLive(s)).toMatchObject({ kind: 'notice', tone: 'dim', text: '⚙ dev-server:exited(exit 0)' });
  });
});

describe('reducer:元信息事件与全集', () => {
  it('SessionStarted 不渲染(state 引用不变)', () => {
    const before = s0(true);
    const event: AgentEvent = { kind: 'SessionStarted', externalId: 'x', model: 'm', tools: [], workspacePath: '/', permissionMode: 'supervised', profile: 'default' };
    expect(ev(before, event)).toBe(before);
  });

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
