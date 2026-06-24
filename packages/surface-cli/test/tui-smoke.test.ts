import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { CliApp } from '@yo-agent/surface-cli';
import type { TuiKernel } from '@yo-agent/surface-cli';
import type { ApprovalDecision, AgentEvent, EventEnvelope, Id } from '@yo-agent/protocol';

const ESC = String.fromCharCode(27);
const DOWN = ESC + '[B';
const ENTER = '\r';

function ev(event: AgentEvent): EventEnvelope {
  return { sessionId: 's', cursor: 0, parentId: null, turnId: null, ts: 0, event };
}

/** 脚本化 fake 内核：submitInput 时把预置事件推给订阅者。 */
class FakeKernel implements TuiKernel {
  private handler: ((env: EventEnvelope) => void) | null = null;
  readonly decided: Array<{ requestId: Id; decision: ApprovalDecision }> = [];
  constructor(private readonly events: EventEnvelope[]) {}
  subscribe(_s: Id, _c: number | null, handler: (env: EventEnvelope) => void): () => void {
    this.handler = handler;
    return () => {};
  }
  async submitInput(): Promise<unknown> {
    for (const e of this.events) this.handler?.(e);
    return { turnId: 't' };
  }
  decideApproval(requestId: Id, decision: ApprovalDecision): void {
    this.decided.push({ requestId, decision });
  }
}

const SUGGESTIONS = [
  { decision: 'allow_once' as const, label: '允许一次' },
  { decision: 'allow_always' as const, label: '总是允许' },
  { decision: 'reject_once' as const, label: '拒绝一次' },
  { decision: 'reject_always' as const, label: '总是拒绝' },
];

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('CliApp（Ink 冒烟）', () => {
  it('渲染流式助手文本 + 完成态', async () => {
    const kernel = new FakeKernel([
      ev({ kind: 'AssistantText', delta: '你好世界' }),
      ev({ kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }),
    ]);
    const { lastFrame, unmount } = render(
      React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'hi', autoExit: false }),
    );
    await tick();
    expect(lastFrame()).toContain('你好世界');
    expect(lastFrame()).toContain('完成');
    unmount();
  });

  it('交互审批：渲染 4 选项；Enter 裁决 allow_once', async () => {
    const kernel = new FakeKernel([
      ev({ kind: 'ApprovalRequested', requestId: 'req-1', tool: 'write', input: { path: 'a.ts' }, risk: 'high', suggestions: SUGGESTIONS }),
    ]);
    const { lastFrame, stdin, unmount } = render(
      React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'go', autoExit: false }),
    );
    await tick();
    expect(lastFrame()).toContain('审批请求');
    expect(lastFrame()).toContain('write');
    expect(lastFrame()).toContain('允许一次');
    stdin.write(ENTER); // 默认选中第 0 项 → allow_once
    await tick();
    expect(kernel.decided).toEqual([{ requestId: 'req-1', decision: 'allow_once' }]);
    unmount();
  });

  it('交互审批：↓↓ 移动后 Enter → reject_once（第 3 项）', async () => {
    const kernel = new FakeKernel([
      ev({ kind: 'ApprovalRequested', requestId: 'req-2', tool: 'bash', input: {}, risk: 'high', suggestions: SUGGESTIONS }),
    ]);
    const { stdin, unmount } = render(
      React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'go', autoExit: false }),
    );
    await tick();
    stdin.write(DOWN); // index 1
    await tick();
    stdin.write(DOWN); // index 2 (reject_once)
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(kernel.decided).toEqual([{ requestId: 'req-2', decision: 'reject_once' }]);
    unmount();
  });
});
