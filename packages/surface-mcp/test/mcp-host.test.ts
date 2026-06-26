import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import type { ApprovalGate } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { ToolContext } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  McpHostManager,
  listAllTools,
  mapDiscoveredTools,
  mcpExecutor,
  mcpHealthFlag,
} from '@yo-agent/surface-mcp';
import type { RawMcpTool, ResolvedMcpServer, ToolLister } from '@yo-agent/surface-mcp';

/** 同进程 stub MCP server（echo/add/big/boom）→ 返回 client 端 transport。 */
async function startStubServer(): Promise<Transport> {
  const server = new McpServer({ name: 'stub', version: '0.0.0' });
  server.registerTool('echo', { description: 'echo back', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  server.registerTool(
    'add',
    { description: 'add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  server.registerTool('boom', { description: 'always errors', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'kaboom' }],
    isError: true,
  }));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  return clientT;
}

function stubSpec(): ResolvedMcpServer {
  return { name: 'stub', source: 'user', command: '', args: [], env: {} };
}

async function connectedHost(): Promise<{ host: McpHostManager; registry: InMemoryToolRegistry; ctx: ToolContext }> {
  const registry = new InMemoryToolRegistry();
  const clientT = await startStubServer();
  const host = new McpHostManager({ registry, transportFor: () => clientT });
  await host.addServer(stubSpec());
  const ctx: ToolContext = { sessionId: 's', cwd: '/tmp', flags: new Set(host.flags()) };
  return { host, registry, ctx };
}

describe('McpHostManager —— 发现 / 命名 / availability', () => {
  it('连接后工具经 mcp__{server}__{tool} 命名注册，外部段字典序稳定', async () => {
    const { registry, ctx } = await connectedHost();
    const names = registry.resolveAvailable(ctx).map((d) => d.name);
    expect(names).toEqual(['mcp__stub__add', 'mcp__stub__boom', 'mcp__stub__echo']); // 字典序
  });

  it('availability 绑连接健康：无 flag 时工具不可见（3C 熔断接缝）', async () => {
    const { registry } = await connectedHost();
    const noFlags: ToolContext = { sessionId: 's', cwd: '/tmp' };
    expect(registry.resolveAvailable(noFlags)).toEqual([]); // flag 缺失 → configFlag 求值 false
    expect(mcpHealthFlag('stub')).toBe('mcp:stub');
  });

  it('host 工具 owner=mcp、approval clamp 为 risk-based（绝不 never）、schema 为 object', async () => {
    const { registry, ctx } = await connectedHost();
    const echo = registry.resolveAvailable(ctx).find((d) => d.name === 'mcp__stub__echo')!;
    expect(echo.owner).toBe('mcp');
    expect(echo.approval).toBe('risk-based');
    expect(echo.inputSchema).toMatchObject({ type: 'object' });
  });

  it('closeAll 反注册全部工具 + 撤健康标志', async () => {
    const { host, registry, ctx } = await connectedHost();
    expect(registry.resolveAvailable(ctx)).toHaveLength(3);
    await host.closeAll();
    expect([...host.flags()]).toEqual([]);
    expect(registry.resolveAvailable({ sessionId: 's', cwd: '/tmp', flags: new Set() })).toEqual([]);
    expect(registry.executor('mcp__stub__echo')).toBeUndefined();
  });

  it('规范化名撞名守卫：第二台 server 在 spawn 前被拦（防空载子进程 + 共享健康标志）', async () => {
    const registry = new InMemoryToolRegistry();
    const clientT = await startStubServer();
    let transportCalls = 0;
    const host = new McpHostManager({
      registry,
      transportFor: () => {
        transportCalls++;
        return clientT;
      },
    });
    await host.addServer({ name: 'stub', source: 'user', command: '', args: [], env: {} });
    // 'STUB' sanitize 后与 'stub' 同 → 应在造 transport（spawn）前抛错
    await expect(
      host.addServer({ name: 'STUB', source: 'user', command: '', args: [], env: {} }),
    ).rejects.toThrow(/规范化名.*冲突/);
    expect(transportCalls).toBe(1); // 第二台未造 transport
  });
});

describe('mcpExecutor —— callTool 归一', () => {
  it('text 内容回流为 output chunk', async () => {
    const { registry, ctx } = await connectedHost();
    const ex = registry.executor('mcp__stub__echo')!;
    let out = '';
    for await (const e of ex.execute({ text: 'hi-there' }, ctx)) if (e.kind === 'output') out += e.chunk;
    expect(out).toBe('hi-there');
  });

  it('isError 结果 → throw 携带内容（kernel 据此发 ToolCallCompleted{error}）', async () => {
    const { registry, ctx } = await connectedHost();
    const ex = registry.executor('mcp__stub__boom')!;
    await expect(
      (async () => {
        for await (const _e of ex.execute({}, ctx)) void _e;
      })(),
    ).rejects.toThrow(/kaboom/);
  });

  // 用 fake client 精确驱动归一分支（真实 McpServer 难以构造空 content / 多块 / structuredContent）。
  const fakeClient = (result: unknown): Client => ({ async callTool() { return result; } }) as unknown as Client;
  const drain = async (ex: ReturnType<typeof mcpExecutor>, input: unknown): Promise<string> => {
    let out = '';
    for await (const e of ex.execute(input, { sessionId: 's', cwd: '/tmp' })) if (e.kind === 'output') out += e.chunk;
    return out;
  };

  it('多 text 块成功路径按 \\n 拼接，与 isError 路径一致', async () => {
    const ex = mcpExecutor(fakeClient({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 't');
    expect(await drain(ex, {})).toBe('a\nb');
  });

  it('content 空但有 structuredContent → 回退 JSON（不丢 outputSchema 工具结果）', async () => {
    const ex = mcpExecutor(fakeClient({ content: [], structuredContent: { sum: 3 } }), 't');
    expect(await drain(ex, {})).toBe('{"sum":3}');
  });

  it('image 块有损降级为占位串（非文本承载推迟）', async () => {
    const ex = mcpExecutor(fakeClient({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }), 't');
    expect(await drain(ex, {})).toMatch(/image image\/png.*base64 已省略/);
  });
});

describe('发现逻辑纯函数 —— 分页 / per-tool 隔离', () => {
  it('listAllTools 游标循环全量拉取（首页之后不丢）', async () => {
    const pages: Record<string, { tools: RawMcpTool[]; nextCursor?: string }> = {
      '': { tools: [{ name: 't1' }], nextCursor: 'c1' },
      c1: { tools: [{ name: 't2' }], nextCursor: 'c2' },
      c2: { tools: [{ name: 't3' }] },
    };
    const lister: ToolLister = { async listTools(p) { return pages[p?.cursor ?? '']!; } };
    expect((await listAllTools(lister)).map((t) => t.name)).toEqual(['t1', 't2', 't3']);
  });

  it('mapDiscoveredTools per-tool 隔离：非法/空工具名只跳过自身，不拖垮其余', () => {
    const client = {} as unknown as Client; // executor 构造时不调用 client
    const logs: string[] = [];
    const tools = mapDiscoveredTools(
      'stub',
      client,
      [{ name: 'good' }, { name: '%%%' }, { name: '' }, { name: 'also_good' }],
      (m) => logs.push(m),
    );
    expect(tools.map((t) => t.descriptor.name)).toEqual(['mcp__stub__good', 'mcp__stub__also_good']);
    expect(logs.length).toBe(2); // 两个非法名各记一条跳过
  });
});

describe('MCP 注入链端到端（TST-5）—— 经 kernel 真实审批 + 执行', () => {
  function buildKernel(host: McpHostManager, registry: InMemoryToolRegistry, gate: ApprovalGate) {
    const provider = new FakeProvider();
    const kernel = new AgentKernel({
      store: new MemoryEventStore(),
      provider,
      tools: registry,
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      approvalGate: gate,
      toolFlags: () => host.flags(), // 连接健康 → 工具可见
      model: 'fake-model',
      cwd: '/tmp',
    });
    return { kernel, provider };
  }

  it('owner:mcp 工具必走 ApprovalGate，risk 非 unknown；allow → callTool 输出回流', async () => {
    const { host, registry } = await connectedHost();
    const seen: { tool: string; risk: string }[] = [];
    const gate: ApprovalGate = {
      async request(req) {
        seen.push({ tool: req.tool, risk: req.risk });
        return { decision: 'allow_once' };
      },
    };
    const { kernel, provider } = buildKernel(host, registry, gate);
    provider.script(toolCallTurn('mcp__stub__echo', 'c1', { text: 'hello-mcp' }));
    provider.script(textTurn('完成'));

    const sid = await kernel.startSession({ model: 'fake-model' });
    const out: string[] = [];
    kernel.subscribe(sid, null, (env) => {
      if (env.event.kind === 'ToolCallOutput') out.push(env.event.chunk);
    });
    await kernel.submitInput(sid, '调外部工具', 't1');

    expect(seen).toEqual([{ tool: 'mcp__stub__echo', risk: 'medium' }]); // 外部 other 类 → medium，非 unknown
    expect(out.join('')).toBe('hello-mcp');
  });

  it('无 gate（headless）→ risk-based 外部工具被默认 deny，不静默执行', async () => {
    const registry = new InMemoryToolRegistry();
    const clientT = await startStubServer();
    const host = new McpHostManager({ registry, transportFor: () => clientT });
    await host.addServer(stubSpec());
    const provider = new FakeProvider();
    const kernel = new AgentKernel({
      store: new MemoryEventStore(),
      provider,
      tools: registry,
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      // 不给 approvalGate、非交互 → 默认 reject_once
      toolFlags: () => host.flags(),
      model: 'fake-model',
      cwd: '/tmp',
    });
    provider.script(toolCallTurn('mcp__stub__echo', 'c1', { text: 'should-not-run' }));
    provider.script(textTurn('收尾'));

    const sid = await kernel.startSession({ model: 'fake-model' });
    const completed: { status: string }[] = [];
    kernel.subscribe(sid, null, (env) => {
      if (env.event.kind === 'ToolCallCompleted') completed.push({ status: env.event.status });
    });
    await kernel.submitInput(sid, '调外部工具', 't1');
    // 被拒 → 不产生成功执行的 ToolCallOutput（reject 在 emit ToolCallStarted 前拦截）
    expect(completed).toEqual([]); // 拒绝路径直接 push tool_result，不发 ToolCallCompleted
  });
});
