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
  CircuitBreaker,
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

// ───────────────────────── 3C 韧性 ─────────────────────────

describe('CircuitBreaker —— 阈值 / 冷却 / 半开（纯时钟驱动）', () => {
  it('连续失败达阈值才打开；冷却期内 open，冷却满转闭', () => {
    const b = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    b.recordFailure(0);
    b.recordFailure(0);
    expect(b.isOpen(0)).toBe(false); // 2 < 3
    b.recordFailure(0);
    expect(b.isOpen(0)).toBe(true); // 第 3 次 → openUntil=1000
    expect(b.isOpen(999)).toBe(true);
    expect(b.isOpen(1000)).toBe(false); // 冷却满（严格 >）
  });

  it('半开：冷却后单次失败立即重开（试探失败即回退）', () => {
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
    b.recordFailure(0);
    b.recordFailure(0); // open until 100
    expect(b.isOpen(150)).toBe(false); // 半开
    b.recordFailure(150); // failures=3 ≥ 2 → 立即重开 until 250
    expect(b.isOpen(150)).toBe(true);
    expect(b.isOpen(250)).toBe(false);
  });

  it('成功清零：失败累积后成功 → 需重新累积到阈值才打开', () => {
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
    b.recordFailure(0);
    b.recordSuccess(0);
    b.recordFailure(0);
    expect(b.isOpen(0)).toBe(false); // 仅 1 次（成功已清零）
  });

  it('冷却窗口内的成功不缩短固定冷却期（半开前不提前闭合，审查 BRK-4）', () => {
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    b.recordFailure(0);
    b.recordFailure(0); // open until 1000
    expect(b.isOpen(500)).toBe(true);
    b.recordSuccess(500); // 冷却窗口内成功 → 不清 openUntil
    expect(b.isOpen(500)).toBe(true); // 仍熔断，honor 固定冷却
    expect(b.isOpen(1000)).toBe(false); // 冷却满才闭合
  });

  it('半开后成功彻底闭合（冷却已过）', () => {
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
    b.recordFailure(0);
    b.recordFailure(0); // open until 100
    b.recordSuccess(150); // 半开（冷却已过）成功 → 彻底闭合
    expect(b.isOpen(150)).toBe(false);
    b.recordFailure(150); // failures 已清零 → 仅 1 次 < 2，不重开
    expect(b.isOpen(150)).toBe(false);
  });
});

describe('McpHostManager —— 熔断显隐 / statusSnapshot', () => {
  it('连续失败达阈值 → flags 撤下、工具从 resolveAvailable 消失；冷却后恢复', async () => {
    let clock = 1000;
    const registry = new InMemoryToolRegistry();
    const clientT = await startStubServer();
    const statuses: { server: string; status: string }[] = [];
    const host = new McpHostManager({
      registry,
      transportFor: () => clientT,
      now: () => clock,
      breaker: { threshold: 2, cooldownMs: 500 },
      onStatus: (s) => statuses.push({ server: s.server, status: s.status }),
    });
    await host.addServer(stubSpec());
    const visible = () =>
      registry.resolveAvailable({ sessionId: 's', cwd: '/tmp', flags: new Set(host.flags()) }).map((d) => d.name);
    expect(visible()).toHaveLength(3); // 健康：3 工具可见

    const conn = host.connection('stub')!;
    conn.noteTransportFailure(clock);
    conn.noteTransportFailure(clock); // 第 2 次 → 熔断打开 until 1500
    expect([...host.flags()]).toEqual([]); // 健康标志撤下
    expect(visible()).toEqual([]); // 工具经 configFlag 消失
    expect(host.statusSnapshot()[0]).toMatchObject({ server: 'stub', status: 'failed' });
    expect(statuses.some((s) => s.status === 'failed')).toBe(true); // 打开瞬间 onStatus failed

    clock = 1500; // 冷却满
    expect([...host.flags()]).toEqual([mcpHealthFlag('stub')]); // 恢复
    expect(visible()).toHaveLength(3);
    expect(host.statusSnapshot()[0]).toMatchObject({ status: 'connected' });
  });
});

describe('McpHostManager —— 空闲 TTL 断连 + in-flight 守卫', () => {
  it('超 TTL 断连回收（反注册 + 撤标志 + onStatus disconnected）', async () => {
    let clock = 0;
    const registry = new InMemoryToolRegistry();
    const clientT = await startStubServer();
    const statuses: string[] = [];
    const host = new McpHostManager({
      registry,
      transportFor: () => clientT,
      now: () => clock,
      idleTtlMs: 1000,
      onStatus: (s) => statuses.push(s.status),
    });
    await host.addServer(stubSpec()); // lastUsed = 0
    clock = 500;
    expect(await host.sweepIdle()).toEqual([]); // 未超 TTL
    clock = 2000;
    expect(await host.sweepIdle()).toEqual(['stub']); // 超 TTL → 断连
    expect([...host.flags()]).toEqual([]);
    expect(registry.executor('mcp__stub__echo')).toBeUndefined();
    expect(statuses).toContain('disconnected');
  });

  it('TTL 到期遇 in-flight 调用 → 推迟断连，完成后再扫才断（防竞态）', async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 自建带 hang 工具的 stub（外部门控，模拟在飞调用）。
    const server = new McpServer({ name: 'stub', version: '0.0.0' });
    server.registerTool('hang', { description: 'blocks', inputSchema: {} }, async () => {
      await gate;
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);

    const registry = new InMemoryToolRegistry();
    const host = new McpHostManager({ registry, transportFor: () => clientT, now: () => clock, idleTtlMs: 1000 });
    await host.addServer(stubSpec());

    const ex = registry.executor('mcp__stub__hang')!;
    const callDone = (async () => {
      for await (const _e of ex.execute({}, { sessionId: 's', cwd: '/tmp' })) void _e;
    })();
    await new Promise((r) => setTimeout(r, 20)); // 让 execute 跑到 callTool（in-flight++）

    clock = 5000; // 远超 TTL
    expect(await host.sweepIdle()).toEqual([]); // in-flight>0 → 推迟，不断连
    expect([...host.flags()]).toEqual([mcpHealthFlag('stub')]); // 仍连接

    release();
    await callDone; // 调用完成（in-flight--）
    clock = 999_999;
    expect(await host.sweepIdle()).toEqual(['stub']); // 完成后再扫 → 断连
  });
});

describe('McpHostManager —— tools/list_changed 显式重建（非热换）', () => {
  it('远端新增工具 → 重建工具集 + toolsetVersion 自增', async () => {
    const server = new McpServer({ name: 'stub', version: '0.0.0' });
    server.registerTool('echo', { description: 'e', inputSchema: { text: z.string() } }, async ({ text }) => ({
      content: [{ type: 'text', text }],
    }));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);

    const registry = new InMemoryToolRegistry();
    let rebuilt!: () => void;
    const rebuiltP = new Promise<void>((r) => {
      rebuilt = r;
    });
    const host = new McpHostManager({ registry, transportFor: () => clientT, onToolsChanged: () => rebuilt() });
    await host.addServer(stubSpec());
    const ctx = { sessionId: 's', cwd: '/tmp', flags: new Set(host.flags()) };
    expect(registry.resolveAvailable(ctx).map((d) => d.name)).toEqual(['mcp__stub__echo']);
    const v0 = registry.toolsetVersion();

    // 连接后动态注册新工具 → McpServer 自动 sendToolListChanged → host.rebuild。
    server.registerTool('added', { description: 'a', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    await rebuiltP;

    const after = { sessionId: 's', cwd: '/tmp', flags: new Set(host.flags()) };
    expect(registry.resolveAvailable(after).map((d) => d.name)).toEqual(['mcp__stub__added', 'mcp__stub__echo']);
    expect(registry.toolsetVersion()).toBeGreaterThan(v0); // 版本自增可观测
  });
});

describe('McpHostManager —— 跨进程 resume 重连不漂移', () => {
  it('新进程（新 registry/host）重连同 spec → 工具集与重启前一致', async () => {
    // 进程 A：连接并记录可见工具集。
    const clientT1 = await startStubServer();
    const reg1 = new InMemoryToolRegistry();
    const host1 = new McpHostManager({ registry: reg1, transportFor: () => clientT1 });
    await host1.addServer(stubSpec());
    const names1 = reg1
      .resolveAvailable({ sessionId: 's', cwd: '/tmp', flags: new Set(host1.flags()) })
      .map((d) => d.name);

    // 进程 B（模拟重启）：全新 registry + host + transport，同 spec 重连。
    const clientT2 = await startStubServer();
    const reg2 = new InMemoryToolRegistry();
    const host2 = new McpHostManager({ registry: reg2, transportFor: () => clientT2 });
    await host2.addServer(stubSpec());
    const names2 = reg2
      .resolveAvailable({ sessionId: 's', cwd: '/tmp', flags: new Set(host2.flags()) })
      .map((d) => d.name);

    expect(names2).toEqual(names1); // 重连后命名/排序一致 → 工具集不漂移、不破 cache
  });
});

describe('McpHostManager —— 空闲断连后按需重连（ensureConnected，懒加载收口）', () => {
  it('idle 断连 → ensureConnected 重连 → 工具集恢复、健康标志回归（specs 转活）', async () => {
    let clock = 0;
    const registry = new InMemoryToolRegistry();
    const transports = [await startStubServer(), await startStubServer()]; // 断连会关旧 transport，重连需新的
    let ti = 0;
    const host = new McpHostManager({
      registry,
      transportFor: () => transports[ti++]!,
      now: () => clock,
      idleTtlMs: 1000,
    });
    await host.addServer(stubSpec());
    const before = registry
      .resolveAvailable({ sessionId: 's', cwd: '/tmp', flags: new Set(host.flags()) })
      .map((d) => d.name);
    const epochBefore = host.statusSnapshot()[0]!.epoch!;

    clock = 5000;
    expect(await host.sweepIdle()).toEqual(['stub']); // 空闲断连
    expect(registry.executor('mcp__stub__echo')).toBeUndefined();
    expect([...host.flags()]).toEqual([]);

    await host.ensureConnected(); // 按需重连（读取保留的 spec）
    const after = registry
      .resolveAvailable({ sessionId: 's', cwd: '/tmp', flags: new Set(host.flags()) })
      .map((d) => d.name);
    expect(after).toEqual(before); // 工具集恢复一致、不漂移
    expect([...host.flags()]).toEqual([mcpHealthFlag('stub')]);
    // 重连后 epoch 严格增大（跨 disconnect 不重置）→ kernel 据此失效审批缓存，堵重连期 rug-pull。
    expect(host.statusSnapshot()[0]!.epoch!).toBeGreaterThan(epochBefore);
  });

  it('并发 ensureConnected 对同一 server 去重 → 只重连一次（CONC-RECONN-1，防双连接/子进程泄漏）', async () => {
    let clock = 0;
    const registry = new InMemoryToolRegistry();
    const transports = [await startStubServer(), await startStubServer()];
    let calls = 0;
    const host = new McpHostManager({
      registry,
      transportFor: () => transports[calls++]!,
      now: () => clock,
      idleTtlMs: 1000,
    });
    await host.addServer(stubSpec()); // calls=1
    clock = 5000;
    await host.sweepIdle(); // 断连
    // 两个会话并发起 turn → 并发 ensureConnected（共享同一 host）
    await Promise.all([host.ensureConnected(), host.ensureConnected()]);
    expect(calls).toBe(2); // 初次 + 仅 1 次重连（去重，非 3）→ 无双 spawn
    expect(host.connectedServers()).toEqual(['stub']); // 单连接，无覆盖泄漏
    expect(
      registry.resolveAvailable({ sessionId: 's', cwd: '/tmp', flags: new Set(host.flags()) }),
    ).toHaveLength(3); // 工具完整注册、无孤儿
  });

  it('ensureConnected 不重连仍在册的 server（已连接 → 跳过，不重复 spawn）', async () => {
    let calls = 0;
    const registry = new InMemoryToolRegistry();
    const clientT = await startStubServer();
    const host = new McpHostManager({
      registry,
      transportFor: () => {
        calls++;
        return clientT;
      },
    });
    await host.addServer(stubSpec());
    expect(calls).toBe(1);
    await host.ensureConnected(); // 仍连接 → 跳过
    expect(calls).toBe(1);
  });
});

describe('mcpExecutor —— per-call 超时 + 熔断归因', () => {
  const drainSig = async (
    ex: ReturnType<typeof mcpExecutor>,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string> => {
    let out = '';
    for await (const e of ex.execute(input, { sessionId: 's', cwd: '/tmp', signal })) if (e.kind === 'output') out += e.chunk;
    return out;
  };
  const okClient = (result: unknown): Client => ({ async callTool() { return result; } }) as unknown as Client;
  /** 永挂直到 signal abort 才 reject（模拟真实 SDK：尊重 signal）。 */
  const hangClient = (): Client =>
    ({
      callTool: (_p: unknown, _s: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => {
          opts.signal?.addEventListener('abort', () => rej(opts.signal?.reason ?? new Error('aborted')));
        }),
    }) as unknown as Client;

  it('超时（server 挂死）→ 抛超时错 + onTransportFail（计入熔断）', async () => {
    let fail = 0;
    let ok = 0;
    const ex = mcpExecutor(hangClient(), 't', { onTransportFail: () => fail++, onTransportOk: () => ok++ }, 20);
    await expect(drainSig(ex, {})).rejects.toThrow(/超时/);
    expect(fail).toBe(1);
    expect(ok).toBe(0);
  });

  it('成功 → onTransportOk，不计失败', async () => {
    let fail = 0;
    let ok = 0;
    const ex = mcpExecutor(okClient({ content: [{ type: 'text', text: 'hi' }] }), 't', {
      onTransportOk: () => ok++,
      onTransportFail: () => fail++,
    });
    expect(await drainSig(ex, {})).toBe('hi');
    expect(ok).toBe(1);
    expect(fail).toBe(0);
  });

  it('isError（tool 级错误）→ onTransportOk（连接健康，不计熔断）', async () => {
    let fail = 0;
    let ok = 0;
    const ex = mcpExecutor(okClient({ content: [{ type: 'text', text: 'boom' }], isError: true }), 't', {
      onTransportOk: () => ok++,
      onTransportFail: () => fail++,
    });
    await expect(drainSig(ex, {})).rejects.toThrow(/boom/);
    expect(ok).toBe(1);
    expect(fail).toBe(0);
  });

  it('用户中断（ctx.signal abort，非超时）→ 中性不计熔断', async () => {
    let fail = 0;
    const ctrl = new AbortController();
    const ex = mcpExecutor(hangClient(), 't', { onTransportFail: () => fail++ }, 0); // 无内部超时
    const p = drainSig(ex, {}, ctrl.signal);
    ctrl.abort(new Error('turn interrupted'));
    await expect(p).rejects.toThrow();
    expect(fail).toBe(0); // 用户中断不计入熔断
  });

  it('kernel 级超时 abort（reason.name=TimeoutError）→ 计入熔断，不被误判为用户中断（审查 ATTR-3）', async () => {
    let fail = 0;
    const ctrl = new AbortController();
    const ex = mcpExecutor(hangClient(), 't', { onTransportFail: () => fail++ }, 0); // 无本地超时，依赖外部 signal
    const p = drainSig(ex, {}, ctrl.signal);
    const reason = new Error('工具调用超时（X ms）');
    reason.name = 'TimeoutError';
    ctrl.abort(reason); // 模拟 kernel callSignal 超时（双层超时叠加时挂死 server 仍须计入熔断）
    await expect(p).rejects.toThrow();
    expect(fail).toBe(1);
  });

  it('in-flight 计数：onCallStart/onCallEnd 成对（成功与抛错都 onCallEnd）', async () => {
    const seq: string[] = [];
    const hooks = { onCallStart: () => seq.push('start'), onCallEnd: () => seq.push('end') };
    const ex = mcpExecutor(okClient({ content: [{ type: 'text', text: 'x' }] }), 't', hooks);
    await drainSig(ex, {});
    expect(seq).toEqual(['start', 'end']);
    // 抛错路径也 onCallEnd
    seq.length = 0;
    const exErr = mcpExecutor(okClient({ content: [{ type: 'text', text: 'e' }], isError: true }), 't', hooks);
    await expect(drainSig(exErr, {})).rejects.toThrow();
    expect(seq).toEqual(['start', 'end']);
  });
});
