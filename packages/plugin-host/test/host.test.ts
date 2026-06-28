import { describe, it, expect, vi } from 'vitest';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { ToolContext, ToolEvent } from '@yo-agent/tools';
import { DefaultPluginHost } from '../src/host';
import type { PluginSpec } from '../src/host';
import type { PluginTransport, PluginTransportEvents } from '../src/transport';
import type { HostToWorker, PluginManifest } from '../src/protocol';
import { pluginHealthFlag } from '../src/protocol';
import type { HookContext, PreToolUsePayload } from '@yo-agent/kernel';

/** 内存假传输：记录下发消息 + 可脚本化/手动驱动事件（确定性模拟 ready/崩溃/心跳/应答）。 */
class FakePluginTransport implements PluginTransport {
  events!: PluginTransportEvents;
  sent: HostToWorker[] = [];
  terminated = false;
  onInvoke?: (msg: Extract<HostToWorker, { type: 'invoke' }>, ev: PluginTransportEvents) => void;
  onHook?: (msg: Extract<HostToWorker, { type: 'hook' }>, ev: PluginTransportEvents) => void;
  constructor(readonly id: string) {}
  start(events: PluginTransportEvents): void {
    this.events = events;
  }
  send(msg: HostToWorker): void {
    this.sent.push(msg);
    if (msg.type === 'invoke') this.onInvoke?.(msg, this.events);
    else if (msg.type === 'hook') this.onHook?.(msg, this.events);
  }
  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  name: 'p1',
  tools: [{ name: 'p1_echo', kind: 'other', description: 'd', inputSchema: { type: 'object' } }],
  hooks: [],
  ...over,
});

const toolCtx = (): ToolContext => ({ sessionId: 's', cwd: '/w' });
const hookCtx = (): HookContext => ({ sessionId: 's', cwd: '/w', permissionMode: 'supervised' });

async function collect(stream: AsyncIterable<ToolEvent>): Promise<string> {
  let s = '';
  for await (const e of stream) if (e.kind === 'output') s += e.chunk;
  return s;
}

/** 起一个已就绪插件，返回 host/registry/transport 句柄。 */
async function startReady(
  manifestOver: Partial<PluginManifest> = {},
  hostOver: Partial<ConstructorParameters<typeof DefaultPluginHost>[0]> = {},
): Promise<{ host: DefaultPluginHost; registry: InMemoryToolRegistry; made: FakePluginTransport[] }> {
  const registry = new InMemoryToolRegistry();
  const made: FakePluginTransport[] = [];
  const host = new DefaultPluginHost({
    registry,
    transportFor: (spec: PluginSpec) => {
      const t = new FakePluginTransport(spec.id);
      made.push(t);
      return t;
    },
    ...hostOver,
  });
  const p = host.start([{ id: 'p1' }]);
  made[0]!.events.onReady(manifest(manifestOver));
  await p;
  return { host, registry, made };
}

describe('4E — 工具注册 + availability 健康标志', () => {
  it('ready 后注册插件工具（owner:plugin），健康标志在 → 工具可见', async () => {
    const { host, registry } = await startReady();
    expect(host.flags()).toEqual([pluginHealthFlag('p1')]);
    const visible = registry.resolveAvailable({ ...toolCtx(), flags: new Set(host.flags()) });
    expect(visible.map((d) => d.name)).toContain('p1_echo');
    expect(visible.find((d) => d.name === 'p1_echo')?.owner).toBe('plugin');
  });

  it('approval 钳制：插件声明 never → 收成 risk-based；always 保留（绝不绕审批）', async () => {
    const { registry } = await startReady({
      tools: [
        { name: 'danger', kind: 'execute', description: 'd', inputSchema: {}, approval: 'never' as never },
        { name: 'always', kind: 'other', description: 'd', inputSchema: {}, approval: 'always' },
        { name: 'plain', kind: 'other', description: 'd', inputSchema: {} },
      ],
    });
    const byName = new Map(registry.resolveAvailable({ ...toolCtx(), flags: new Set([pluginHealthFlag('p1')]) }).map((d) => [d.name, d]));
    expect(byName.get('danger')?.approval).toBe('risk-based'); // never 被钳掉
    expect(byName.get('always')?.approval).toBe('always');
    expect(byName.get('plain')?.approval).toBe('risk-based'); // 缺省
  });

  it('prompt-cache 稳定：插件工具按名字典序排在 core 之后', async () => {
    const { host, registry } = await startReady({
      tools: [
        { name: 'zzz', kind: 'other', description: 'd', inputSchema: {} },
        { name: 'aaa', kind: 'other', description: 'd', inputSchema: {} },
      ],
    });
    const names = registry.resolveAvailable({ ...toolCtx(), flags: new Set(host.flags()) }).map((d) => d.name);
    expect(names).toEqual(['aaa', 'zzz']); // ext 段按名排序，稳定不漂移
  });
});

describe('4E — 工具代理（经 IPC 下发，崩溃围栏）', () => {
  it('invoke 经 transport 下发，流式分片回灌', async () => {
    const { registry, made } = await startReady();
    made[0]!.onInvoke = (msg, ev) => {
      ev.onChunk(msg.id, `echo:`);
      ev.onChunk(msg.id, JSON.stringify(msg.input));
      ev.onDone(msg.id, false, undefined);
    };
    const out = await collect(registry.executor('p1_echo')!.execute({ x: 1 }, toolCtx()));
    expect(out).toBe('echo:{"x":1}');
  });

  it('插件工具 isError → 代理抛错（主内核记 tool_result error）', async () => {
    const { registry, made } = await startReady();
    made[0]!.onInvoke = (msg, ev) => ev.onDone(msg.id, true, '插件内部炸了');
    await expect(collect(registry.executor('p1_echo')!.execute({}, toolCtx()))).rejects.toThrow(/插件内部炸了/);
  });

  it('插件已崩溃 → 工具拒绝执行（不绕健康判定）', async () => {
    const { host, registry, made } = await startReady();
    made[0]!.events.onCrash('boom');
    expect(host.isHealthy('p1')).toBe(false);
    await expect(collect(registry.executor('p1_echo')!.execute({}, toolCtx()))).rejects.toThrow(/不可用/);
  });
});

describe('4E — 崩溃围栏 + 心跳降级（退出标准③核心）', () => {
  it('Worker 崩溃 → 主进程存活 + 撤健康标志 → 工具从 resolveAvailable 消失', async () => {
    const { host, registry, made } = await startReady();
    expect(host.isHealthy('p1')).toBe(true);
    made[0]!.events.onCrash('未捕获异常 boom'); // 等价 worker 'error'/非 0 exit
    expect(host.isHealthy('p1')).toBe(false);
    expect(host.flags()).toEqual([]); // 标志撤下
    const visible = registry.resolveAvailable({ ...toolCtx(), flags: new Set(host.flags()) });
    expect(visible.map((d) => d.name)).not.toContain('p1_echo'); // 工具消失（主进程未崩）
  });

  it('在飞调用在崩溃时被拒（不挂死）', async () => {
    const { registry, made } = await startReady();
    made[0]!.onInvoke = () => {
      /* 不应答，模拟卡住 */
    };
    const pending = collect(registry.executor('p1_echo')!.execute({}, toolCtx()));
    await Promise.resolve();
    made[0]!.events.onCrash('崩了');
    await expect(pending).rejects.toThrow(/插件已崩溃/);
  });

  it('心跳超时 → 看门狗判死降级（注入时钟）', async () => {
    let clock = 1000;
    const { host, made } = await startReady({}, { now: () => clock, heartbeatTimeoutMs: 5000, maxReconnect: 0 });
    expect(host.isHealthy('p1')).toBe(true);
    made[0]!.events.onHeartbeat(1); // lastHeartbeatAt = 1000
    clock = 1000 + 5001; // 越过超时
    host.checkHeartbeats();
    expect(host.isHealthy('p1')).toBe(false);
    expect(made[0]!.terminated).toBe(true);
  });
});

describe('4E — 重连恢复', () => {
  it('崩溃后排程重连 → 新 transport ready → 健康恢复', async () => {
    vi.useFakeTimers();
    try {
      const registry = new InMemoryToolRegistry();
      const made: FakePluginTransport[] = [];
      const host = new DefaultPluginHost({
        registry,
        transportFor: (spec) => {
          const t = new FakePluginTransport(spec.id);
          made.push(t);
          return t;
        },
        maxReconnect: 3,
      });
      const p = host.start([{ id: 'p1' }]);
      made[0]!.events.onReady(manifest());
      await p;
      made[0]!.events.onCrash('boom'); // → 排程重连（backoff 500ms）
      expect(host.isHealthy('p1')).toBe(false);
      await vi.advanceTimersByTimeAsync(600); // 触发重连 → 造 made[1]
      expect(made.length).toBe(2);
      made[1]!.events.onReady(manifest()); // 新 worker 就绪
      expect(host.isHealthy('p1')).toBe(true);
      await host.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('4E 收口 — 安全修复回归', () => {
  it('收口 4E-MED：插件工具名禁用 MCP 保留前缀 mcp__（防冒名顶替/遮蔽 MCP 工具）', async () => {
    const { registry } = await startReady({
      tools: [
        { name: 'mcp__github__create_issue', kind: 'other', description: 'd', inputSchema: {} },
        { name: 'safe_tool', kind: 'other', description: 'd', inputSchema: {} },
      ],
    });
    const names = registry.resolveAvailable({ ...toolCtx(), flags: new Set([pluginHealthFlag('p1')]) }).map((d) => d.name);
    expect(names).not.toContain('mcp__github__create_issue'); // 保留前缀被拒
    expect(names).toContain('safe_tool');
  });

  it('收口 4E-MED：二次崩溃仍继续重连（不被旧 attempt>0 守卫截断），且每次崩溃都 terminate', async () => {
    vi.useFakeTimers();
    try {
      const registry = new InMemoryToolRegistry();
      const made: FakePluginTransport[] = [];
      const host = new DefaultPluginHost({
        registry,
        transportFor: (spec) => {
          const t = new FakePluginTransport(spec.id);
          made.push(t);
          return t;
        },
        maxReconnect: 3,
      });
      const p = host.start([{ id: 'p1' }]);
      made[0]!.events.onReady(manifest());
      await p;
      made[0]!.events.onCrash('崩 1'); // → 排程重连 1
      expect(made[0]!.terminated).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(made.length).toBe(2); // 重连 1 起新 transport
      made[1]!.events.onCrash('崩 2'); // 二次崩溃：旧 attempt>0 守卫会在此截断；修复后应继续排程重连 2
      expect(made[1]!.terminated).toBe(true); // 始终 terminate（不泄漏 worker）
      await vi.advanceTimersByTimeAsync(2000);
      expect(made.length).toBe(3); // 重连 2 起第三个 transport（重连链未被截断）
      await host.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('4E — Hook 跨进程兑现（挂掉的插件绝不拒主循环工具）', () => {
  const pre = (): PreToolUsePayload => ({ tool: 'bash', kind: 'execute', input: { cmd: 'ls' } });

  it('插件 deny → PreToolUse 返回 deny', async () => {
    const { host, made } = await startReady({ hooks: ['PreToolUse'] });
    made[0]!.onHook = (msg, ev) => ev.onHookResult(msg.id, { decision: 'deny', reason: '插件拦截' });
    const r = await host.hooks().onPreToolUse!(hookCtx(), pre());
    expect(r).toEqual({ decision: 'deny', reason: '插件拦截' });
  });

  it('插件改写 input → 链式带出', async () => {
    const { host, made } = await startReady({ hooks: ['PreToolUse'] });
    made[0]!.onHook = (msg, ev) => ev.onHookResult(msg.id, { decision: 'allow', input: { cmd: 'ls -la' } });
    const r = await host.hooks().onPreToolUse!(hookCtx(), pre());
    expect(r).toEqual({ decision: 'allow', input: { cmd: 'ls -la' } });
  });

  it('插件崩溃 → PreToolUse 放行（不抛、不 fail-closed-deny）', async () => {
    const { host, made } = await startReady({ hooks: ['PreToolUse'] });
    made[0]!.events.onCrash('崩了');
    const r = await host.hooks().onPreToolUse!(hookCtx(), pre());
    expect(r).toBeUndefined(); // 无裁决 = 放行（HookBus 视为 allow）
  });

  it('插件 hook 超时 → 放行（注入短超时）', async () => {
    const { host, made } = await startReady({ hooks: ['PreToolUse'] }, { hookTimeoutMs: 20 });
    made[0]!.onHook = () => {
      /* 永不应答 */
    };
    const r = await host.hooks().onPreToolUse!(hookCtx(), pre());
    expect(r).toBeUndefined();
  });

  it('观测型 hook（PostToolUse）fan-out 不抛', async () => {
    const { host, made } = await startReady({ hooks: ['PostToolUse'] });
    let seen = false;
    made[0]!.onHook = (msg, ev) => {
      seen = true;
      ev.onHookResult(msg.id, undefined);
    };
    await host.hooks().onPostToolUse!(hookCtx(), { tool: 'bash', kind: 'execute', input: {}, output: 'x', isError: false });
    expect(seen).toBe(true);
  });
});
