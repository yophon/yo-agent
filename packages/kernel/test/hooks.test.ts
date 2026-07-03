import { describe, it, expect } from 'vitest';
import { HookBus } from '@yo-agent/kernel';
import type { HookContext, HookPoint } from '@yo-agent/kernel';

const ctx: HookContext = { sessionId: 's', cwd: '/w', permissionMode: 'supervised' };

describe('4A — HookBus 注册/反注册', () => {
  it('register 返回反注册函数，size 反映当前数', () => {
    const bus = new HookBus();
    expect(bus.size).toBe(0);
    const off1 = bus.register({});
    const off2 = bus.register({});
    expect(bus.size).toBe(2);
    off1();
    expect(bus.size).toBe(1);
    off2();
    expect(bus.size).toBe(0);
    off1(); // 重复反注册无副作用
    expect(bus.size).toBe(0);
  });
});

describe('4A — 各 hook 点触发', () => {
  it('SessionStart / UserPromptSubmit / PostToolUse / PreCompact / Stop / OnApproval / Subagent* 均被触发且带正确载荷', async () => {
    const log: string[] = [];
    const bus = new HookBus();
    bus.register({
      onSessionStart: () => void log.push('session'),
      onUserPromptSubmit: (_c, p) => void log.push(`prompt:${p}`),
      onPostToolUse: (_c, p) => void log.push(`post:${p.tool}:${p.isError}`),
      onPreCompact: () => void log.push('compact'),
      onStop: (_c, r) => void log.push(`stop:${r}`),
      onApproval: (_c, p) => void log.push(`approval:${p.tool}:${p.decision}`),
      onSubagentStart: (_c, l) => void log.push(`sub-start:${l}`),
      onSubagentStop: (_c, sm) => void log.push(`sub-stop:${sm}`),
    });
    await bus.fireSessionStart(ctx);
    await bus.fireUserPromptSubmit(ctx, 'hi');
    await bus.firePostToolUse(ctx, { tool: 'read', kind: 'read', input: {}, output: 'x', isError: false });
    await bus.firePreCompact(ctx);
    await bus.fireStop(ctx, 'end_turn');
    await bus.fireApproval(ctx, { tool: 'bash', risk: 'high', decision: 'allow_once' });
    await bus.fireSubagentStart(ctx, 'explorer');
    await bus.fireSubagentStop(ctx, '完成');
    expect(log).toEqual([
      'session',
      'prompt:hi',
      'post:read:false',
      'compact',
      'stop:end_turn',
      'approval:bash:allow_once',
      'sub-start:explorer',
      'sub-stop:完成',
    ]);
  });
});

describe('4A — PreToolUse 三态', () => {
  it('无 hook → allow + input 原样', async () => {
    const bus = new HookBus();
    const r = await bus.firePreToolUse(ctx, { tool: 'echo', kind: 'other', input: { a: 1 } });
    expect(r.decision).toBe('allow');
    expect(r.input).toEqual({ a: 1 });
  });

  it('改写 input：链式——第二个 hook 见第一个改写值，最终值回传', async () => {
    const bus = new HookBus();
    const seen: unknown[] = [];
    bus.register({ onPreToolUse: () => ({ decision: 'allow', input: { a: 2 } }) });
    bus.register({
      onPreToolUse: (_c, p) => {
        seen.push(p.input);
        return { decision: 'allow', input: { a: 3 } };
      },
    });
    const r = await bus.firePreToolUse(ctx, { tool: 'echo', kind: 'other', input: { a: 1 } });
    expect(seen).toEqual([{ a: 2 }]); // 第二个 hook 见到第一个的改写
    expect(r.decision).toBe('allow');
    expect(r.input).toEqual({ a: 3 });
  });

  it('拒：任一 hook deny 立即短路（后续 hook 不跑），带 reason', async () => {
    const bus = new HookBus();
    let ran2 = false;
    bus.register({ onPreToolUse: () => ({ decision: 'deny', reason: '危险命令' }) });
    bus.register({
      onPreToolUse: () => {
        ran2 = true;
        return undefined;
      },
    });
    const r = await bus.firePreToolUse(ctx, { tool: 'bash', kind: 'execute', input: {} });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('危险命令');
    expect(ran2).toBe(false);
  });

  it('fail-closed：PreToolUse hook 抛错 → deny（reason=错误信息），不向上抛', async () => {
    const bus = new HookBus();
    bus.register({
      onPreToolUse: () => {
        throw new Error('hook 内部崩了');
      },
    });
    const r = await bus.firePreToolUse(ctx, { tool: 'bash', kind: 'execute', input: { x: 1 } });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('hook 内部崩了');
    expect(r.input).toEqual({ x: 1 }); // 保留进入时的 input
  });

  it('返回 void/无返回 → 视为放行不改写', async () => {
    const bus = new HookBus();
    bus.register({ onPreToolUse: () => undefined });
    const r = await bus.firePreToolUse(ctx, { tool: 'echo', kind: 'other', input: { a: 1 } });
    expect(r.decision).toBe('allow');
    expect(r.input).toEqual({ a: 1 });
  });
});

describe('4A — 观测型 hook 异常不吞不拖垮', () => {
  it('单 hook 抛错 → onError 收到 (point, err)，其余 hook 仍跑，fire 不抛', async () => {
    const bus = new HookBus();
    const errors: Array<[HookPoint, string]> = [];
    let secondRan = false;
    bus.register({
      onStop: () => {
        throw new Error('观测崩了');
      },
    });
    bus.register({
      onStop: () => {
        secondRan = true;
      },
    });
    await expect(
      bus.fireStop(ctx, 'end_turn', (point, err) => {
        errors.push([point, err instanceof Error ? err.message : String(err)]);
      }),
    ).resolves.toBeUndefined();
    expect(errors).toEqual([['Stop', '观测崩了']]);
    expect(secondRan).toBe(true); // 异常隔离，后续 hook 照跑
  });

  it('无 onError 时抛错被吞但不拖垮（fire 正常 resolve）', async () => {
    const bus = new HookBus();
    bus.register({
      onSessionStart: () => {
        throw new Error('x');
      },
    });
    await expect(bus.fireSessionStart(ctx)).resolves.toBeUndefined();
  });
});
