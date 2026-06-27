import { describe, it, expect } from 'vitest';
import {
  AgentKernel,
  DefaultSubagentManager,
  HistoryLoopBreaker,
  NoopCondenser,
  createInProcessRunner,
} from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry, makeSubagentSpawnTool, readTool } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';

/** 装配：父内核 + 共享 store + 子内核用独立 FakeProvider；subagent_spawn 工具接管理器（host=父内核）。 */
function harness() {
  const store = new MemoryEventStore();
  const parentProv = new FakeProvider();
  const childProv = new FakeProvider();
  const registry = new InMemoryToolRegistry();
  registry.register(readTool);

  const parentKernel = new AgentKernel({
    store,
    provider: parentProv,
    tools: registry,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: 'fake',
    cwd: '/work',
  });

  const manager = new DefaultSubagentManager({
    host: parentKernel,
    runner: createInProcessRunner({
      store,
      provider: childProv,
      registry,
      loopBreaker: () => new HistoryLoopBreaker(),
      condenser: () => new NoopCondenser(),
    }),
    parentToolsOf: () => ['read', 'subagent_spawn'],
    parentModeOf: () => 'autonomous',
    cwdOf: () => '/work',
  });
  registry.register(makeSubagentSpawnTool(manager));

  return { store, parentProv, childProv, parentKernel };
}

describe('4C — 子 agent 端到端（真实内核 host + in-process 子内核）', () => {
  it('foreground：派生子 agent → 主 turn 收 SubagentStarted/Result + 摘要经 tool_result 回灌；主流程继续', async () => {
    const { parentProv, childProv, parentKernel } = harness();
    // 父：调 subagent_spawn（foreground）→ 收尾
    parentProv.script(toolCallTurn('subagent_spawn', 't1', { task: '探索X', mode: 'foreground' }));
    parentProv.script(textTurn('主结束'));
    // 子：直接产出文本摘要
    childProv.script(textTurn('子结果摘要'));

    const sid = await parentKernel.startSession({ permissionMode: 'autonomous' });
    const events: AgentEvent[] = [];
    parentKernel.subscribe(sid, null, (env: EventEnvelope) => events.push(env.event));
    await parentKernel.submitInput(sid, 'go', 'k1');

    const started = events.find((e) => e.kind === 'SubagentStarted');
    const result = events.find((e) => e.kind === 'SubagentResult');
    expect(started).toBeTruthy();
    expect(result).toBeTruthy();
    expect(result && result.kind === 'SubagentResult' && result.summary).toBe('子结果摘要');
    // 摘要经 tool_result 回灌：父第二次推理的消息窗口里能看到子摘要
    expect(JSON.stringify(parentProv.seen.map((r) => r.messages))).toContain('子结果摘要');
    // 主流程继续收尾
    expect(events.some((e) => e.kind === 'TurnCompleted')).toBe(true);
  });

  it('上下文隔离：子 agent 的工具调用细节只进子树，主 session 事件流只见 SubagentStarted/Result', async () => {
    const { store, parentProv, childProv, parentKernel } = harness();
    parentProv.script(toolCallTurn('subagent_spawn', 't1', { task: '探索X', mode: 'foreground' }));
    parentProv.script(textTurn('主结束'));
    // 子：先调 read（落子树 ToolCallStarted）再产出文本
    childProv.script(toolCallTurn('read', 'c1', { path: 'nope.txt' }));
    childProv.script(textTurn('子结果摘要'));

    const sid = await parentKernel.startSession({ permissionMode: 'autonomous' });
    const events: AgentEvent[] = [];
    parentKernel.subscribe(sid, null, (env: EventEnvelope) => events.push(env.event));
    await parentKernel.submitInput(sid, 'go', 'k1');

    // 父事件流的工具调用仅 subagent_spawn —— 子的 read 不污染主 session
    const parentToolNames = events.filter((e) => e.kind === 'ToolCallStarted').map((e) => (e as { name: string }).name);
    expect(parentToolNames).toEqual(['subagent_spawn']);

    // 子树（childSessionId）里能查到 read 的工具调用
    const started = events.find((e) => e.kind === 'SubagentStarted') as { childSessionId: string } | undefined;
    expect(started).toBeTruthy();
    const childEvents: AgentEvent[] = [];
    for await (const env of store.read(started!.childSessionId)) childEvents.push(env.event);
    const childToolNames = childEvents.filter((e) => e.kind === 'ToolCallStarted').map((e) => (e as { name: string }).name);
    expect(childToolNames).toContain('read');
  });

  it('background：子 agent 结果经 steering 在 parent 下一 turn 注入消息窗口', async () => {
    const { parentProv, childProv, parentKernel } = harness();
    // 第一 turn：派生 background → 收尾（不等子 agent）
    parentProv.script(toolCallTurn('subagent_spawn', 't1', { task: '后台X', mode: 'background' }));
    parentProv.script(textTurn('turn1 结束'));
    // 第二 turn：纯文本
    parentProv.script(textTurn('turn2 结束'));
    childProv.script(textTurn('后台子结果'));

    const sid = await parentKernel.startSession({ permissionMode: 'autonomous' });
    const events: AgentEvent[] = [];
    parentKernel.subscribe(sid, null, (env: EventEnvelope) => events.push(env.event));
    await parentKernel.submitInput(sid, 'go1', 'k1');
    await new Promise((r) => setTimeout(r, 30)); // 让后台子 agent 完成 + 结果入 steering 队列
    await parentKernel.submitInput(sid, 'go2', 'k2');

    expect(events.some((e) => e.kind === 'SubagentResult')).toBe(true);
    // 第二 turn 的推理窗口里出现注入的后台子结果
    const lastReq = parentProv.seen[parentProv.seen.length - 1]!;
    expect(JSON.stringify(lastReq.messages)).toContain('后台子结果');
  });
});
