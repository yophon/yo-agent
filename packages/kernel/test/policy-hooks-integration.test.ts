import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool, ToolApproval } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { AgentEvent, PermissionMode, ToolKind } from '@yo-agent/protocol';

function recTool(name: string, kind: ToolKind, approval: ToolApproval, calls: unknown[]): RegisteredTool {
  return {
    descriptor: { name, kind, description: name, inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval },
    executor: {
      async *execute(input) {
        calls.push(input);
        yield { kind: 'output', chunk: 'ok' };
      },
    },
  };
}

function makeKernel(tool?: RegisteredTool) {
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  if (tool) tools.register(tool);
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: 'fake',
    cwd: '/work',
    interactiveApproval: true,
  });
  return { kernel, provider };
}

/** 起会话 + 收事件 + 跑一轮 prompt；autoApprove=true 时遇 ApprovalRequested 自动 allow_once。 */
async function runOnce(
  kernel: AgentKernel,
  provider: FakeProvider,
  opts: { mode?: PermissionMode; tc: { name: string; input: unknown }; autoApprove?: boolean } = { tc: { name: '', input: {} } },
) {
  provider.script(toolCallTurn(opts.tc.name, 't1', opts.tc.input));
  provider.script(textTurn('done'));
  const sid = await kernel.startSession(opts.mode ? { permissionMode: opts.mode } : {});
  const events: AgentEvent[] = [];
  kernel.subscribe(sid, null, (env) => {
    events.push(env.event);
    if (opts.autoApprove && env.event.kind === 'ApprovalRequested') {
      kernel.decideApproval(env.event.requestId, 'allow_once');
    }
  });
  await kernel.submitInput(sid, 'go', 'k1');
  return { sid, events };
}

const asked = (events: AgentEvent[]) => events.some((e) => e.kind === 'ApprovalRequested');
const started = (events: AgentEvent[]) => events.some((e) => e.kind === 'ToolCallStarted');
const completed = (events: AgentEvent[]) => events.some((e) => e.kind === 'TurnCompleted');

describe('4A — PreToolUse hook 接线（内核端到端）', () => {
  it('deny：工具不执行、不发 ToolCallStarted，turn 正常收尾', async () => {
    const calls: unknown[] = [];
    const { kernel, provider } = makeKernel(recTool('echo', 'other', 'never', calls));
    kernel.registerHook({ onPreToolUse: () => ({ decision: 'deny', reason: '危险' }) });
    const { events } = await runOnce(kernel, provider, { tc: { name: 'echo', input: { a: 1 } } });
    expect(calls).toEqual([]);
    expect(started(events)).toBe(false);
    expect(completed(events)).toBe(true);
  });

  it('改写 input：executor 收到改写后的值', async () => {
    const calls: unknown[] = [];
    const { kernel, provider } = makeKernel(recTool('echo', 'other', 'never', calls));
    kernel.registerHook({ onPreToolUse: () => ({ decision: 'allow', input: { a: 999 } }) });
    await runOnce(kernel, provider, { tc: { name: 'echo', input: { a: 1 } } });
    expect(calls).toEqual([{ a: 999 }]);
  });
});

describe('4A — permissionMode 闸门接线（内核端到端）', () => {
  it('read-only：编辑类工具被拒、不弹审批、不执行（不可绕过）', async () => {
    const calls: unknown[] = [];
    const { kernel, provider } = makeKernel(recTool('writer', 'edit', 'risk-based', calls));
    const { events } = await runOnce(kernel, provider, { mode: 'read-only', tc: { name: 'writer', input: { path: '/work/a.ts' } } });
    expect(calls).toEqual([]);
    expect(asked(events)).toBe(false); // 直接 deny，绝不弹审批
    expect(started(events)).toBe(false);
    expect(completed(events)).toBe(true);
  });

  it('read-only：读类工具放行、不弹审批、直接执行', async () => {
    const calls: unknown[] = [];
    const { kernel, provider } = makeKernel(recTool('reader', 'read', 'risk-based', calls));
    const { events } = await runOnce(kernel, provider, { mode: 'read-only', tc: { name: 'reader', input: { path: '/work/a.ts' } } });
    expect(calls).toEqual([{ path: '/work/a.ts' }]);
    expect(asked(events)).toBe(false);
  });

  it('supervised（默认）：风险工具仍走审批（等价既有行为）；OnApproval hook 收到裁决', async () => {
    const calls: unknown[] = [];
    const approvals: string[] = [];
    const { kernel, provider } = makeKernel(recTool('writer', 'edit', 'risk-based', calls));
    kernel.registerHook({ onApproval: (_c, p) => void approvals.push(`${p.tool}:${p.decision}`) });
    const { events } = await runOnce(kernel, provider, { tc: { name: 'writer', input: { path: '/work/a.ts' } }, autoApprove: true });
    expect(asked(events)).toBe(true); // 仍弹审批 → PolicyEngine 未改 supervised 行为
    expect(calls).toEqual([{ path: '/work/a.ts' }]); // 批准后执行
    expect(approvals).toEqual(['writer:allow_once']);
  });

  it('accept-edits：编辑类自动放行、不弹审批、直接执行', async () => {
    const calls: unknown[] = [];
    const { kernel, provider } = makeKernel(recTool('writer', 'edit', 'risk-based', calls));
    const { events } = await runOnce(kernel, provider, { mode: 'accept-edits', tc: { name: 'writer', input: { path: '/work/a.ts' } } });
    expect(asked(events)).toBe(false);
    expect(calls).toEqual([{ path: '/work/a.ts' }]);
  });

  it('autonomous：高风险执行类仍弹审批；低风险读类自动放行', async () => {
    // 高风险（execute kind → assessRisk=high）→ ask
    {
      const calls: unknown[] = [];
      const { kernel, provider } = makeKernel(recTool('runner', 'execute', 'risk-based', calls));
      const { events } = await runOnce(kernel, provider, { mode: 'autonomous', tc: { name: 'runner', input: { command: 'ls' } }, autoApprove: true });
      expect(asked(events)).toBe(true);
      expect(calls).toEqual([{ command: 'ls' }]);
    }
    // 低风险读类 → 自动放行
    {
      const calls: unknown[] = [];
      const { kernel, provider } = makeKernel(recTool('reader', 'read', 'risk-based', calls));
      const { events } = await runOnce(kernel, provider, { mode: 'autonomous', tc: { name: 'reader', input: { path: '/work/a.ts' } } });
      expect(asked(events)).toBe(false);
      expect(calls).toEqual([{ path: '/work/a.ts' }]);
    }
  });
});

describe('4A — 生命周期 hook 在真实 turn 中触发', () => {
  it('SessionStart / UserPromptSubmit / PostToolUse / Stop 均触发', async () => {
    const calls: unknown[] = [];
    const { kernel, provider } = makeKernel(recTool('echo', 'other', 'never', calls));
    const log: string[] = [];
    kernel.registerHook({
      onSessionStart: () => void log.push('session'),
      onUserPromptSubmit: () => void log.push('prompt'),
      onPostToolUse: (_c, p) => void log.push(`post:${p.tool}`),
      onStop: (_c, r) => void log.push(`stop:${r}`),
    });
    await runOnce(kernel, provider, { tc: { name: 'echo', input: { a: 1 } } });
    expect(log).toContain('session');
    expect(log).toContain('prompt');
    expect(log).toContain('post:echo');
    expect(log).toContain('stop:end_turn');
  });

  it('观测型 hook 抛错不拖垮 turn，且 emit Error 落事件流（不吞掉）', async () => {
    const calls: unknown[] = [];
    const { kernel, provider } = makeKernel(recTool('echo', 'other', 'never', calls));
    kernel.registerHook({
      onPostToolUse: () => {
        throw new Error('hook 崩了');
      },
    });
    const { events } = await runOnce(kernel, provider, { tc: { name: 'echo', input: { a: 1 } } });
    expect(calls).toEqual([{ a: 1 }]); // 工具照常执行
    expect(completed(events)).toBe(true); // turn 照常收尾
    expect(events.some((e) => e.kind === 'Error' && e.message.includes('PostToolUse'))).toBe(true); // 不吞掉
  });
});
