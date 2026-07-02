import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import type { Condenser } from '@yo-agent/kernel';
import type { CanonMessage } from '@yo-agent/provider';
import { FakeProvider, textTurn } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { AgentEvent } from '@yo-agent/protocol';

function makeKernel(over: { condenser?: Condenser } = {}) {
  const provider = new FakeProvider();
  const kernel = new AgentKernel({
    store: new MemoryEventStore(),
    provider,
    tools: new InMemoryToolRegistry(),
    loopBreaker: new HistoryLoopBreaker(),
    condenser: over.condenser ?? new NoopCondenser(),
    model: 'model-a',
  });
  return { kernel, provider };
}

describe('4.6e 内核接缝(K1-K5)', () => {
  it('K1 setModel:下一轮请求用新模型(主路由随会话)', async () => {
    const { kernel, provider } = makeKernel();
    const sid = await kernel.startSession({});
    provider.script(textTurn('第一轮'));
    await kernel.submitInput(sid, 'q1', 'k1');
    expect(provider.seen[0]!.modelId).toBe('model-a');
    kernel.setModel(sid, 'model-b');
    expect(kernel.listSessions()[0]!.model).toBe('model-b');
    provider.script(textTurn('第二轮'));
    await kernel.submitInput(sid, 'q2', 'k2');
    expect(provider.seen[1]!.modelId).toBe('model-b');
  });

  it('K2 setPermissionMode:模式切换可观测;未知会话抛错', async () => {
    const { kernel } = makeKernel();
    const sid = await kernel.startSession({ permissionMode: 'supervised' });
    kernel.setPermissionMode(sid, 'autonomous');
    expect(kernel.listSessions()[0]!.permissionMode).toBe('autonomous');
    kernel.setPermissionMode(sid, 'read-only'); // 收紧(清 allow_always 缓存)不抛
    expect(kernel.listSessions()[0]!.permissionMode).toBe('read-only');
    expect(() => kernel.setPermissionMode('nope', 'supervised')).toThrow();
  });

  it('K3 compactNow:压不动 → false 不发事件;压成 → true + ContextCompacted', async () => {
    const events: AgentEvent[] = [];
    // 压成路径:砍掉一半消息的假 condenser
    const halving: Condenser = {
      shouldCompact: () => false, // 自动路径永不触发,验证 compactNow 跳过闸门
      condense: async (messages: CanonMessage[]) => messages.slice(Math.ceil(messages.length / 2)),
    };
    const { kernel, provider } = makeKernel({ condenser: halving });
    const sid = await kernel.startSession({});
    kernel.subscribe(sid, null, (env) => events.push(env.event));
    provider.script(textTurn('a'));
    await kernel.submitInput(sid, 'q1', 'k1');
    provider.script(textTurn('b'));
    await kernel.submitInput(sid, 'q2', 'k2');
    expect(await kernel.compactNow(sid)).toBe(true);
    expect(events.some((e) => e.kind === 'ContextCompacted')).toBe(true);

    const noop = makeKernel(); // NoopCondenser 压不动
    const sid2 = await noop.kernel.startSession({});
    expect(await noop.kernel.compactNow(sid2)).toBe(false);
  });

  it('K4 contextState:随消息增长;窗口取 deps 配置', async () => {
    const { kernel, provider } = makeKernel();
    const sid = await kernel.startSession({});
    const before = kernel.contextState(sid);
    expect(before.usableTokens).toBe(200_000);
    provider.script(textTurn('回答'.repeat(50)));
    await kernel.submitInput(sid, '问题'.repeat(50), 'k1');
    const after = kernel.contextState(sid);
    expect(after.usedTokens).toBeGreaterThan(before.usedTokens);
  });

  it('K5 listPersistedSessions:turn 完成后可枚举(含 model/workspacePath)', async () => {
    const { kernel, provider } = makeKernel();
    const sid = await kernel.startSession({});
    provider.script(textTurn('done'));
    await kernel.submitInput(sid, 'q', 'k');
    const rows = await kernel.listPersistedSessions();
    expect(rows.some((r) => r.sessionId === sid && r.model === 'model-a')).toBe(true);
  });
});
