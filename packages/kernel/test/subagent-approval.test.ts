import { describe, expect, it } from 'vitest';
import {
  AgentKernel,
  DefaultSubagentManager,
  HistoryLoopBreaker,
  NoopCondenser,
  WorkerSubagentRunner,
  createInProcessRunner,
} from '@yo-agent/kernel';
import type { SubagentRunSpec } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry, makeSubagentSpawnTool } from '@yo-agent/tools';
import type { RegisteredTool } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { AgentEvent, EventEnvelope } from '@yo-agent/protocol';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

function writeTool(calls: unknown[]): RegisteredTool {
  return {
    descriptor: {
      name: 'write',
      kind: 'edit',
      description: 'w',
      inputSchema: { type: 'object' },
      owner: 'core',
      availability: { always: true },
      approval: 'risk-based',
    },
    executor: {
      async *execute(input) {
        calls.push(input);
        yield { kind: 'output', chunk: 'written' };
      },
    },
  };
}

describe('4.9c — 子代理审批上浮（复刻 feedback/4.8 反馈②场景）', () => {
  it('子代理 ask 档审批浮到父会话（ApprovalRequested），批准后子工具写盘成功', async () => {
    const store = new MemoryEventStore();
    const parentProv = new FakeProvider();
    const childProv = new FakeProvider();
    const registry = new InMemoryToolRegistry();
    const writes: unknown[] = [];
    registry.register(writeTool(writes));

    const parentKernel = new AgentKernel({
      store,
      provider: parentProv,
      tools: registry,
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      model: 'fake',
      cwd: '/work',
      interactiveApproval: true, // TUI/RPC 形态
    });
    const manager = new DefaultSubagentManager({
      host: parentKernel,
      runner: createInProcessRunner({
        store,
        provider: childProv,
        registry,
        loopBreaker: () => new HistoryLoopBreaker(),
        condenser: () => new NoopCondenser(),
        parentApproval: (pid, req) => parentKernel.relayApproval(pid, req), // 4.9c 接缝
      }),
      parentToolsOf: () => ['write'],
      parentModeOf: () => 'supervised', // 子代理派生 supervised → write 走 ask
      cwdOf: () => '/work',
    });
    registry.register(makeSubagentSpawnTool(manager));

    parentProv.script(toolCallTurn('subagent_spawn', 't1', { task: '写文件', mode: 'foreground' }));
    parentProv.script(textTurn('主结束'));
    childProv.script(toolCallTurn('write', 'c1', { path: '/work/a.txt' }));
    childProv.script(textTurn('子写盘完成'));

    const sid = await parentKernel.startSession({ permissionMode: 'autonomous' }); // spawn 本身免审批，聚焦子审批
    const events: AgentEvent[] = [];
    parentKernel.subscribe(sid, null, (env: EventEnvelope) => {
      events.push(env.event);
      // 父会话审批面板行为：见 ApprovalRequested（子代理上浮的 write）即批准。
      if (env.event.kind === 'ApprovalRequested' && env.event.tool === 'write') {
        parentKernel.decideApproval(env.event.requestId, 'allow_once');
      }
    });
    await parentKernel.submitInput(sid, 'go', 'k1');

    const approvals = events.filter((e) => e.kind === 'ApprovalRequested').map((e) => (e as { tool: string }).tool);
    expect(approvals).toContain('write'); // 子代理的审批出现在父会话事件流（TUI 面板零改动接管）
    expect(writes).toEqual([{ path: '/work/a.txt' }]); // 批准后子工具真执行
    const result = events.find((e) => e.kind === 'SubagentResult');
    expect(result && result.kind === 'SubagentResult' && result.summary).toBe('子写盘完成');
  });

  it('无 relay（缺省）→ 子代理 ask 档 noninteractive 归因拒绝，文案不再谎称「用户拒绝」', async () => {
    const store = new MemoryEventStore();
    const childProv = new FakeProvider();
    const registry = new InMemoryToolRegistry();
    registry.register(writeTool([]));
    const runner = createInProcessRunner({
      store,
      provider: childProv,
      registry,
      loopBreaker: () => new HistoryLoopBreaker(),
      condenser: () => new NoopCondenser(),
    });
    childProv.script(toolCallTurn('write', 'c1', { path: 'x' }));
    childProv.script(textTurn('done'));
    const spec: SubagentRunSpec = {
      childSessionId: 'c-1',
      parentSessionId: 'p-1',
      profile: 'default',
      task: 'T',
      model: 'fake',
      maxTurns: 4,
      toolAllowlist: ['write'],
      permissionMode: 'supervised',
      cwd: '/w',
      depth: 1,
    };
    await runner.run(spec);
    const msgs = JSON.stringify(childProv.seen.map((r) => r.messages));
    expect(msgs).toContain('非交互环境自动拒绝');
    expect(msgs).not.toContain('用户拒绝了该工具调用');
  });
});

describe('4.9c — 审批语义修正（超时 ≠ 真拒）', () => {
  function harness(opts: { timeoutMs?: number } = {}) {
    const store = new MemoryEventStore();
    const provider = new FakeProvider();
    const tools = new InMemoryToolRegistry();
    const calls: unknown[] = [];
    tools.register(writeTool(calls));
    const kernel = new AgentKernel({
      store,
      provider,
      tools,
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      interactiveApproval: true,
      ...(opts.timeoutMs ? { approvalTimeoutMs: opts.timeoutMs } : {}),
    });
    return { kernel, provider, calls };
  }

  it('审批超时 → tool_result 归因「审批超时…自动拒绝」+ surface Error 提示，不说「用户拒绝」', async () => {
    const { kernel, provider } = harness({ timeoutMs: 30 });
    provider.script(toolCallTurn('write', 't1', { path: 'x' }));
    provider.script(textTurn('end'));
    const sid = await kernel.startSession({ permissionMode: 'supervised' });
    const events: AgentEvent[] = [];
    kernel.subscribe(sid, null, (env: EventEnvelope) => events.push(env.event)); // 不决策 → 超时
    await kernel.submitInput(sid, 'go', 'k1');
    const msgs = JSON.stringify(provider.seen.map((r) => r.messages));
    expect(msgs).toContain('审批超时');
    expect(msgs).not.toContain('用户拒绝了该工具调用');
    expect(events.some((e) => e.kind === 'Error' && e.message.includes('审批超时'))).toBe(true);
  });

  it('用户真拒 → 文案带当前 permissionMode + /mode 引导', async () => {
    const { kernel, provider, calls } = harness();
    provider.script(toolCallTurn('write', 't1', { path: 'x' }));
    provider.script(textTurn('end'));
    const sid = await kernel.startSession({ permissionMode: 'supervised' });
    kernel.subscribe(sid, null, (env: EventEnvelope) => {
      if (env.event.kind === 'ApprovalRequested') kernel.decideApproval(env.event.requestId, 'reject_once');
    });
    await kernel.submitInput(sid, 'go', 'k1');
    const msgs = JSON.stringify(provider.seen.map((r) => r.messages));
    expect(msgs).toContain('用户拒绝了该工具调用（当前权限模式：supervised）');
    expect(msgs).toContain('/mode');
    expect(calls).toHaveLength(0);
  });
});

describe('4.9c — worker 档跨线程审批 RPC', () => {
  const spec: SubagentRunSpec = {
    childSessionId: 'c1',
    parentSessionId: 'p1',
    profile: 'default',
    task: 'T',
    model: 'fake',
    maxTurns: 4,
    toolAllowlist: [],
    permissionMode: 'supervised',
    cwd: '/w',
    depth: 1,
  };

  it('approval relay 往返：worker 发 approval_request → relay 决定送回 worker', async () => {
    const seen: Array<{ tool: string }> = [];
    const runner = new WorkerSubagentRunner({
      entry: fixture('subagent-approval.mjs'),
      approval: async (req) => {
        seen.push({ tool: req.tool });
        return { decision: 'allow_once' };
      },
    });
    const r = await runner.run(spec);
    expect(seen).toEqual([{ tool: 'write' }]);
    expect(r.summary).toBe('decision:allow_once');
  });

  it('无 relay → 回 noninteractive 拒（fail-closed）', async () => {
    const runner = new WorkerSubagentRunner({ entry: fixture('subagent-approval.mjs') });
    const r = await runner.run(spec);
    expect(r.summary).toBe('decision:reject_once:noninteractive');
  });
});
