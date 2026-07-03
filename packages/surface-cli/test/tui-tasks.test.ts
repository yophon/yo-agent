/** 4.10c — 子代理任务面板:model 层状态机 / tasks 纯函数 / keymap 层 / Ink 冒烟。 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { CliApp, initialState, reduce, routeKey } from '@yo-agent/surface-cli';
import type { TuiKernel, UiAction, UiState } from '@yo-agent/surface-cli';
import { formatChildEvents, taskLooksFailed } from '../src/tui/tasks';
import type { AgentEvent, ApprovalDecision, EventEnvelope, Id } from '@yo-agent/protocol';

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ENTER = '\r';

const s0 = () => initialState({ banner: 'b' });
const ev = (state: UiState, event: AgentEvent, ts?: number) => reduce(state, { type: 'event', event, ts });
const act = (state: UiState, a: UiAction) => reduce(state, a);

const started = (id: string, label = 'explorer', model = 'fake-model'): AgentEvent => ({
  kind: 'SubagentStarted',
  childSessionId: id,
  label,
  model,
});
const resolved = (id: string, summary = '结论摘要'): AgentEvent => ({ kind: 'SubagentResult', childSessionId: id, summary });

describe('model — 子代理任务登记', () => {
  it('Started 登记 running,Result 回填 done + summary + 时戳', () => {
    let s = ev(s0(), started('c1'), 1000);
    expect(s.subagentTasks).toEqual([{ childId: 'c1', label: 'explorer', model: 'fake-model', status: 'running', startedTs: 1000 }]);
    s = ev(s, resolved('c1'), 2000);
    expect(s.subagentTasks[0]).toMatchObject({ status: 'done', summary: '结论摘要', endedTs: 2000 });
  });

  it('重复 Started(回放)幂等,不重复登记', () => {
    let s = ev(s0(), started('c1'));
    s = ev(s, started('c1'));
    expect(s.subagentTasks).toHaveLength(1);
  });

  it('多任务并行登记;Result 只命中对应 childId', () => {
    let s = ev(s0(), started('c1'));
    s = ev(s, started('c2', 'writer'));
    s = ev(s, resolved('c2', 'w 完成'));
    expect(s.subagentTasks.map((t) => t.status)).toEqual(['running', 'done']);
  });
});

describe('model — 任务面板状态机', () => {
  it('open → move 环绕 → detail → detail-close → close', () => {
    let s = ev(ev(s0(), started('c1')), started('c2'));
    s = act(s, { type: 'tasks-open' });
    expect(s.tasks).toEqual({ selected: 0, detail: null });
    s = act(s, { type: 'tasks-move', delta: -1 }); // 环绕到末位
    expect(s.tasks?.selected).toBe(1);
    s = act(s, { type: 'tasks-detail', childId: 'c2', lines: ['⏺ read'] });
    expect(s.tasks?.detail).toEqual({ childId: 'c2', lines: ['⏺ read'] });
    s = act(s, { type: 'tasks-move', delta: 1 }); // 详情态不动列表选择
    expect(s.tasks?.selected).toBe(1);
    s = act(s, { type: 'tasks-detail-close' });
    expect(s.tasks).toEqual({ selected: 1, detail: null });
    s = act(s, { type: 'tasks-close' });
    expect(s.tasks).toBeNull();
  });

  it('空任务表:open 可用(空态提示),move 不动', () => {
    let s = act(s0(), { type: 'tasks-open' });
    s = act(s, { type: 'tasks-move', delta: 1 });
    expect(s.tasks).toEqual({ selected: 0, detail: null });
  });
});

describe('tasks 纯函数', () => {
  it('formatChildEvents:流式增量折叠单行,工具/错误/轮界各成行', () => {
    const lines = formatChildEvents([
      { kind: 'AssistantText', delta: '你好' },
      { kind: 'AssistantText', delta: '世界' },
      { kind: 'ToolCallStarted', id: 't1', name: 'read', toolKind: 'read', summary: 'read', input: {} },
      { kind: 'ToolCallCompleted', id: 't1', status: 'error' },
      { kind: 'Error', message: '炸了' },
      { kind: 'AssistantText', delta: '继续' },
      { kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
    ] as AgentEvent[]);
    expect(lines).toEqual(['💬 你好世界', '⏺ read', '  ⎿ 出错', '✗ 炸了', '💬 继续', '— 轮结束(end_turn)']);
  });

  it('taskLooksFailed:manager 拒绝/失败前缀识别为失败', () => {
    const base = { childId: 'c', label: 'l', model: 'm', status: 'done' as const };
    expect(taskLooksFailed({ ...base, summary: '[子 agent 拒绝] 未知画像' })).toBe(true);
    expect(taskLooksFailed({ ...base, summary: '正常结论' })).toBe(false);
    expect(taskLooksFailed({ ...base, status: 'running' })).toBe(false);
  });
});

describe('keymap — tasks 层', () => {
  const ctx = {
    approvalOpen: false,
    pickerOpen: false,
    tasksOpen: true,
    menuOpen: false,
    guideActive: false,
    running: false,
    bufferEmpty: true,
    cursorAtFirstRow: true,
    cursorAtLastRow: true,
  };
  it('↑↓/Enter/Esc → tasks 命令;可见字符被吞;审批层仍最高优先', () => {
    expect(routeKey('', { upArrow: true }, ctx)).toEqual({ type: 'tasks-up' });
    expect(routeKey('', { downArrow: true }, ctx)).toEqual({ type: 'tasks-down' });
    expect(routeKey('', { return: true }, ctx)).toEqual({ type: 'tasks-confirm' });
    expect(routeKey('', { escape: true }, ctx)).toEqual({ type: 'tasks-back' });
    expect(routeKey('x', {}, ctx)).toBeNull();
    expect(routeKey('', { return: true }, { ...ctx, approvalOpen: true })).toEqual({ type: 'approval-confirm' });
  });
});

// ── Ink 冒烟:/tasks 面板开合与详情 ───────────────────────────────────────
function env(event: AgentEvent): EventEnvelope {
  return { sessionId: 's', cursor: 0, parentId: null, turnId: null, ts: 0, event };
}

/** 脚本化 fake 内核:submitInput 推事件;events.read 返回子会话事件流(详情视图数据源)。 */
class TasksFakeKernel implements TuiKernel {
  private handler: ((e: EventEnvelope) => void) | null = null;
  constructor(
    private readonly script: EventEnvelope[],
    private readonly childEvents: Record<string, AgentEvent[]> = {},
  ) {}
  subscribe(_s: Id, _c: number | null, handler: (e: EventEnvelope) => void): () => void {
    this.handler = handler;
    return () => {};
  }
  async submitInput(): Promise<unknown> {
    for (const e of this.script) this.handler?.(e);
    return { turnId: 't' };
  }
  decideApproval(_r: Id, _d: ApprovalDecision): void {}
  events = {
    read: (sessionId: Id): AsyncIterable<EventEnvelope> => {
      const evs = this.childEvents[String(sessionId)] ?? [];
      return (async function* () {
        for (const e of evs) yield { ...env(e), sessionId };
      })();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('CliApp — /tasks 面板(Ink 冒烟)', () => {
  it('打开列表 → Enter 详情(读子事件流)→ Esc 返回 → Esc 关闭', async () => {
    const kernel = new TasksFakeKernel(
      [
        env(started('c1', 'explorer', 'gpt-5.5')),
        env(resolved('c1', '探索完成')),
        env({ kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } }),
      ],
      { c1: [{ kind: 'AssistantText', delta: 'hi' } as AgentEvent] },
    );
    const { lastFrame, stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'go' }));
    await tick();
    stdin.write('/tasks');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('子代理任务');
    expect(lastFrame()).toContain('explorer(gpt-5.5)');
    expect(lastFrame()).toContain('探索完成');
    stdin.write(ENTER); // 进详情
    await tick();
    expect(lastFrame()).toContain('子代理事件流:explorer(gpt-5.5)');
    expect(lastFrame()).toContain('💬 hi');
    stdin.write(ESC); // 返回列表
    await tick();
    expect(lastFrame()).toContain('↑↓ 选择');
    stdin.write(ESC); // 关闭面板
    await tick();
    expect(lastFrame()).not.toContain('↑↓ 选择 · Enter 查看事件流');
    unmount();
  });

  it('空任务表:/tasks 仍可开面板,显示空态提示', async () => {
    const kernel = new TasksFakeKernel([]);
    const { lastFrame, stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('/tasks');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('尚无子代理任务');
    unmount();
  });

  it('DOWN 在多任务间移动选择(高亮跟随)', async () => {
    const kernel = new TasksFakeKernel([
      env(started('c1', 'alpha')),
      env(started('c2', 'beta')),
      env({ kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } }),
    ]);
    const { lastFrame, stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'go' }));
    await tick();
    stdin.write('/tasks');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('❯ ● alpha');
    stdin.write(DOWN);
    await tick();
    expect(lastFrame()).toContain('❯ ● beta');
    unmount();
  });
});
