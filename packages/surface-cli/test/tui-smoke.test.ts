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

/** 记录每次 submitInput 的 prompt（验证 REPL 多轮）。autoComplete=false 时不自动完成（留住 running 态）。 */
class RecordingKernel implements TuiKernel {
  handler: ((env: EventEnvelope) => void) | null = null;
  readonly submitted: string[] = [];
  readonly steered: string[] = [];
  readonly interrupted: Id[] = [];
  constructor(private readonly autoComplete = true) {}
  subscribe(_s: Id, _c: number | null, handler: (env: EventEnvelope) => void): () => void {
    this.handler = handler;
    return () => {};
  }
  async submitInput(_s: Id, prompt: string): Promise<unknown> {
    this.submitted.push(prompt);
    if (this.autoComplete) {
      this.handler?.(ev({ kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }));
    }
    return { turnId: 't' };
  }
  async steer(_s: Id, text: string): Promise<void> {
    this.steered.push(text);
  }
  async interrupt(s: Id): Promise<void> {
    this.interrupted.push(s);
    this.handler?.(ev({ kind: 'TurnCompleted', stopReason: 'interrupted', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }));
  }
  decideApproval(): void {}
}

describe('CliApp REPL（多轮 / 输入框）', () => {
  it('空 prompt：不自动发轮，进输入态；键入回车后提交', async () => {
    const kernel = new RecordingKernel();
    const { lastFrame, stdin, unmount } = render(
      React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }),
    );
    await tick();
    expect(kernel.submitted).toEqual([]); // 空 prompt 不自动发首轮
    expect(lastFrame()).toContain('›'); // 输入提示符在
    stdin.write('hello');
    await tick();
    expect(lastFrame()).toContain('hello'); // 字符回显
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual(['hello']);
    unmount();
  });

  it('多轮：完成一轮后仍可继续提交下一轮（不自动退出）', async () => {
    const kernel = new RecordingKernel();
    const { stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('first');
    stdin.write(ENTER);
    await tick();
    stdin.write('second');
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual(['first', 'second']);
    unmount();
  });

  it('/exit：退出后不再响应输入（不把 /exit 当 prompt 提交）', async () => {
    const kernel = new RecordingKernel();
    const { stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('/exit');
    await tick();
    stdin.write(ENTER);
    await tick();
    // 退出后再键入一轮，应被忽略（useInput 已卸载）。
    stdin.write('ignored');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual([]); // /exit 不提交、退出后输入无效
    unmount();
  });
});

describe('CliApp 4.5（结构化渲染 / 命令 / 中断 / steer）', () => {
  const ESC1 = ESC; // 单独 ESC（无后续）= Escape 键

  it('工具调用：分组渲染 name/summary + 输出预览 + 完成图标', async () => {
    const kernel = new FakeKernel([
      ev({ kind: 'ToolCallStarted', id: 'c1', name: 'read', toolKind: 'read', summary: 'note.txt', input: { path: 'note.txt' } }),
      ev({ kind: 'ToolCallOutput', id: 'c1', chunk: '口令是 PURPLE-42' }),
      ev({ kind: 'ToolCallCompleted', id: 'c1', status: 'ok' }),
      ev({ kind: 'AssistantText', delta: '口令是 PURPLE-42' }),
      ev({ kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }),
    ]);
    const { lastFrame, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'go', model: 'gpt-5.5' }));
    await tick();
    const f = lastFrame()!;
    expect(f).toContain('read'); // 工具名
    expect(f).toContain('note.txt'); // summary
    expect(f).toContain('PURPLE-42'); // 输出预览 + 助手文本
    expect(f).toContain('✓'); // 完成图标
    unmount();
  });

  it('状态栏：累计 token 与 model 反映在底部', async () => {
    const kernel = new FakeKernel([
      ev({ kind: 'UsageUpdate', inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0 }),
      ev({ kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.02 } }),
    ]);
    const { lastFrame, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'go', model: 'gpt-5.5' }));
    await tick();
    const f = lastFrame()!;
    expect(f).toContain('gpt-5.5');
    expect(f).toContain('↑1.2k');
    expect(f).toContain('↓300');
    unmount();
  });

  it('/help：渲染命令帮助；slash 不作为 prompt 提交', async () => {
    const kernel = new RecordingKernel();
    const { lastFrame, stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('/help');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('可用命令');
    expect(kernel.submitted).toEqual([]); // slash 不作为 prompt
    // /clear 被接受且界面仍可用（Static 滚动区历史不可回收属其固有语义，此处验证不崩、不提交）。
    stdin.write('/clear');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('›'); // 输入态仍在
    expect(kernel.submitted).toEqual([]);
    unmount();
  });

  it('Esc 中断运行中的轮（调用 kernel.interrupt）', async () => {
    const kernel = new RecordingKernel(false); // 不自动完成 → 停在 running
    const { stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'long task' }));
    await tick();
    expect(kernel.interrupted).toEqual([]);
    stdin.write(ESC1);
    await tick();
    expect(kernel.interrupted).toEqual(['s']);
    unmount();
  });

  it('运行中回车 → steer（轮内追加引导，不新开轮）', async () => {
    const kernel = new RecordingKernel(false);
    const { stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: 'task' }));
    await tick();
    stdin.write('also handle errors');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(kernel.steered).toEqual(['also handle errors']);
    expect(kernel.submitted).toEqual(['task']); // 仅初始轮，steer 未新开第二轮
    unmount();
  });

  it('输入历史：↑ 召回上一条', async () => {
    const kernel = new RecordingKernel();
    const { lastFrame, stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('alpha');
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual(['alpha']);
    stdin.write(ESC + '[A'); // ↑
    await tick();
    expect(lastFrame()).toContain('alpha'); // 召回到输入行
    unmount();
  });
});

describe('CliApp 4.6b(多行输入 / 粘贴 / 退出保护)', () => {
  it('括号粘贴:含换行的粘贴不提交、整段入 buffer;提交发送全文', async () => {
    const kernel = new RecordingKernel();
    const { lastFrame, stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('[200~第一行\n第二行\x1b[201~'); // ink 剥首 ESC 后的形态
    await tick();
    expect(kernel.submitted).toEqual([]); // 粘贴不触发提交
    expect(lastFrame()).toContain('第一行');
    expect(lastFrame()).toContain('第二行');
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual(['第一行\n第二行']);
    unmount();
  });

  it('大段粘贴折叠为占位符,提交时展开原文', async () => {
    const kernel = new RecordingKernel();
    const { lastFrame, stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    const big = Array.from({ length: 12 }, (_, i) => `L${i}`).join('\n');
    stdin.write(`[200~${big}\x1b[201~`);
    await tick();
    expect(lastFrame()).toContain('[粘贴 #1 · 12 行]');
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual([big]);
    unmount();
  });

  it('Ctrl+J 换行成多行;行尾反斜杠 + Enter 续行不提交', async () => {
    const kernel = new RecordingKernel();
    const { stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('a');
    stdin.write('\n'); // Ctrl+J
    stdin.write('b\\');
    await tick();
    stdin.write(ENTER); // 行尾反斜杠 → 换行,不提交
    await tick();
    expect(kernel.submitted).toEqual([]);
    stdin.write('c');
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual(['a\nb\nc']);
    unmount();
  });

  it('空闲 Ctrl+C 双击才退出:第一次提示,任意键解除;双击退出', async () => {
    const kernel = new RecordingKernel();
    const { lastFrame, stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('\x03'); // Ctrl+C ①
    await tick();
    expect(lastFrame()).toContain('再按一次退出');
    stdin.write('x'); // 任意键解除确认态
    await tick();
    expect(lastFrame()).not.toContain('再按一次退出');
    stdin.write('\x03');
    await tick();
    stdin.write('\x03'); // 双击 → 退出
    await tick();
    stdin.write('should-be-ignored');
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual([]); // 已退出,后续输入无效(首条 x 被解除逻辑消费前已入 buffer,但未提交)
    unmount();
  });

  it('CJK 光标编辑:← 后退格删除整个汉字', async () => {
    const kernel = new RecordingKernel();
    const { stdin, unmount } = render(React.createElement(CliApp, { kernel, sessionId: 's', prompt: '' }));
    await tick();
    stdin.write('中文字');
    await tick();
    stdin.write(ESC + '[D'); // ← 光标到「字」前
    await tick();
    stdin.write('\x7f'); // 退格删「文」
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(kernel.submitted).toEqual(['中字']);
    unmount();
  });
});
