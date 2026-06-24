import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { McpServerSurface, autoApproveGate } from '@yo-agent/surface-mcp';

async function setup() {
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  const calls: unknown[] = [];
  const echo: RegisteredTool = {
    descriptor: { name: 'echo', kind: 'other', description: 'echo', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval: 'always' },
    executor: { async *execute(input) { calls.push(input); yield { kind: 'output', chunk: 'echoed' }; } },
  };
  tools.register(echo);
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: 'fake-model',
    cwd: '/tmp',
    approvalGate: autoApproveGate, // autonomous 节点：放行所有工具
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const surface = new McpServerSurface({ transport: serverT });
  await surface.start(kernel);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientT);
  return { client, provider, calls };
}

function firstText(res: unknown): string {
  const content = (res as { content: Array<{ type: string; text?: string }> }).content;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

describe('McpServerSurface（yo-agent 作 MCP server）', () => {
  it('tools/list 暴露 run 工具', async () => {
    const { client } = await setup();
    const tools = await client.listTools();
    const run = tools.tools.find((t) => t.name === 'run');
    expect(run).toBeDefined();
    expect(run!.inputSchema).toMatchObject({ type: 'object' });
  });

  it('run 委派文本 turn → 返回最终回答', async () => {
    const { client, provider } = await setup();
    provider.script(textTurn('委派完成'));
    const res = await client.callTool({ name: 'run', arguments: { prompt: '介绍一下自己' } });
    expect(firstText(res)).toContain('委派完成');
    expect((res as { isError?: boolean }).isError).toBeFalsy();
  });

  it('run 委派工具 turn：autoApproveGate 放行 → 工具执行 + 活动摘要', async () => {
    const { client, provider, calls } = await setup();
    provider.script(toolCallTurn('echo', 'c1', { x: 1 }));
    provider.script(textTurn('做完了'));
    const res = await client.callTool({ name: 'run', arguments: { prompt: '跑个工具' } });
    expect(calls).toEqual([{ x: 1 }]); // 审批被 autoApproveGate 放行
    const text = firstText(res);
    expect(text).toContain('做完了');
    expect(text).toContain('echo'); // 工具活动摘要
  });

  it('未知工具 → isError 结果', async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: 'no-such', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it('run 委派触发熔断（TurnCompleted{loop_detected}）→ isError:true（失败语义不被吞）', async () => {
    const { client, provider } = await setup();
    // 反复同调用 → HistoryLoopBreaker 第 3 次 break，走 TurnCompleted{loop_detected}（非 TurnFailed）
    provider.script(toolCallTurn('echo', 'c1', { same: 1 }));
    provider.script(toolCallTurn('echo', 'c2', { same: 1 }));
    provider.script(toolCallTurn('echo', 'c3', { same: 1 }));
    const res = await client.callTool({ name: 'run', arguments: { prompt: '死循环' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(firstText(res)).toContain('loop_detected');
  });
});
