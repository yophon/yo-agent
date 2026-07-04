import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, Id } from '@yo-agent/protocol';
import type { Hooks } from '@yo-agent/kernel';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { ExecBackend, ExecChunk, ExecOpts } from '@yo-agent/tools';
import { ExtensionHost, extensionHealthFlag } from '@yo-agent/extension-host';
import type { ExtensionApi, ExtensionKernel, ExtensionSpec } from '@yo-agent/extension-host';

const fx = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const spec = (name: string, source: 'global' | 'project' = 'global'): ExtensionSpec => ({
  name: name.replace(/\.(ts|mts|mjs)$/, ''),
  modulePath: fx(name),
  source,
});

class FakeKernel implements ExtensionKernel {
  hooks: Hooks[] = [];
  handlers = new Map<Id, Array<(env: EventEnvelope) => void>>();
  steered: Array<{ sessionId: Id; text: string }> = [];
  submitted: Array<{ sessionId: Id; prompt: string; idemKey: string }> = [];
  registerHook(h: Hooks): () => void {
    this.hooks.push(h);
    return () => {
      const i = this.hooks.indexOf(h);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }
  subscribe(sessionId: Id, _from: number | null, handler: (env: EventEnvelope) => void): () => void {
    const list = this.handlers.get(sessionId) ?? [];
    list.push(handler);
    this.handlers.set(sessionId, list);
    return () => {
      const cur = this.handlers.get(sessionId) ?? [];
      const i = cur.indexOf(handler);
      if (i >= 0) cur.splice(i, 1);
    };
  }
  async steer(sessionId: Id, text: string): Promise<void> {
    this.steered.push({ sessionId, text });
  }
  async submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<unknown> {
    this.submitted.push({ sessionId, prompt, idemKey });
    return {};
  }
  emit(sessionId: Id, env: EventEnvelope): void {
    for (const h of this.handlers.get(sessionId) ?? []) h(env);
  }
}

const envelope = (sessionId: Id, event: EventEnvelope['event']): EventEnvelope => ({
  sessionId,
  cursor: 1,
  parentId: null,
  turnId: 't1',
  ts: 1,
  event,
});

class FakeExecBackend implements ExecBackend {
  readonly kind = 'local-subprocess' as const;
  // biome-ignore lint/correctness/useYield: hang 模式挂起到 abort,无 yield 是有意的
  async *exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    if (cmd === 'hang') {
      await new Promise<never>((_res, rej) => {
        opts.signal?.addEventListener('abort', () => rej(opts.signal?.reason ?? new Error('aborted')), { once: true });
      });
      return;
    }
    yield { chunk: `ran:${cmd}@${opts.cwd}` };
    yield { chunk: '', exitCode: 3 };
  }
}

interface Harness {
  host: ExtensionHost;
  kernel: FakeKernel;
  registry: InMemoryToolRegistry;
  logs: string[];
}

function makeHost(): Harness {
  const logs: string[] = [];
  const registry = new InMemoryToolRegistry();
  const kernel = new FakeKernel();
  const host = new ExtensionHost({
    registry,
    execBackend: new FakeExecBackend(),
    defaultCwd: '/ws',
    log: (m) => logs.push(m),
  });
  host.bindKernel(kernel);
  return { host, kernel, registry, logs };
}

async function captureApi(h: Harness): Promise<ExtensionApi> {
  await h.host.load([spec('capture.ts')]);
  const api = (globalThis as Record<string, unknown>).__yoCapturedApi as ExtensionApi;
  delete (globalThis as Record<string, unknown>).__yoCapturedApi;
  return api;
}

describe('5.2b — 加载与围栏', () => {
  it('good 扩展全注册面生效：工具钳制 + 命令 + system 段 + hook 直通', async () => {
    const { host, kernel, registry } = makeHost();
    const loaded = await host.load([spec('good.ts')]);
    expect(loaded).toEqual(['good']);
    expect(host.flags()).toEqual(new Set([extensionHealthFlag('good')]));

    // 工具钳制：owner→plugin、approval never→risk-based、availability 绑 ext:good 健康 flag。
    const tool = registry
      .resolveAvailable({ sessionId: 's1', cwd: '/ws', flags: host.flags() })
      .find((d) => d.name === 'fixture_tool');
    expect(tool).toMatchObject({ owner: 'plugin', approval: 'risk-based', availability: { configFlag: 'ext:good' } });
    // flag 缺失（扩展降级）→ 工具从 resolveAvailable 消失（复用 3C 熔断显隐）。
    expect(
      registry.resolveAvailable({ sessionId: 's1', cwd: '/ws', flags: new Set() }).some((d) => d.name === 'fixture_tool'),
    ).toBe(false);

    // 命令归一带 / 前缀。
    expect(host.commands().map((c) => c.name)).toEqual(['/fixture']);
    // system 段：静态 + 函数（喂会话事实）。
    expect(host.renderSystemSections({ model: 'm1', cwd: '/ws', permissionMode: 'supervised' })).toEqual([
      '# 固定段',
      '# 动态段 model=m1',
    ]);
    // hook 直通内核（1 个 host 内部 SessionStart 桥接 + 1 个扩展 hook）。
    const preToolHooks = kernel.hooks.filter((h) => h.onPreToolUse);
    expect(preToolHooks).toHaveLength(1);
    const decision = await preToolHooks[0]!.onPreToolUse!(
      { sessionId: 's1', cwd: '/ws', permissionMode: 'supervised' },
      { tool: 'blocked_tool', kind: 'execute', input: {} },
    );
    expect(decision).toEqual({ decision: 'deny', reason: 'fixture 拦截' });
  });

  it('崩溃围栏（审查 HIGH-1）：setup 抛错 → hook/system 段/命令/onEvent 全部回滚，工具经健康 flag 不可见；不拖垮同批其它扩展', async () => {
    const { host, kernel, registry, logs } = makeHost();
    const loaded = await host.load([spec('bad-throw.ts'), spec('good.ts')]);
    expect(loaded).toEqual(['good']); // bad-throw 跳过，good 照常
    expect(logs.join('\n')).toContain('bad-throw 加载失败');
    // bad_tool 已进 registry，但 ext:bad-throw flag 不在 host.flags() → 不可见（无需回滚反注册）。
    expect(
      registry.resolveAvailable({ sessionId: 's1', cwd: '/ws', flags: host.flags() }).some((d) => d.name === 'bad_tool'),
    ).toBe(false);
    // staging 回滚：坏扩展的半初始化 PreToolUse（会 fail-closed deny 一切）已从 HookBus 摘除——
    // 只剩 good 的那个，且对普通工具放行。
    const preToolHooks = kernel.hooks.filter((h) => h.onPreToolUse);
    expect(preToolHooks).toHaveLength(1);
    expect(await preToolHooks[0]!.onPreToolUse!(
      { sessionId: 's1', cwd: '/ws', permissionMode: 'supervised' },
      { tool: 'bash', kind: 'execute', input: {} },
    )).toBeUndefined();
    // system 段/命令只剩 good 的；坏监听未挂上（发事件不出「onEvent 回调抛错」告警）。
    expect(host.renderSystemSections({ model: 'm', cwd: '/ws', permissionMode: 'supervised' }).join('')).not.toContain('坏扩展');
    expect(host.commands().map((c) => c.name)).toEqual(['/fixture']);
    const sessionStart = kernel.hooks.find((x) => x.onSessionStart)!;
    await sessionStart.onSessionStart!({ sessionId: 's1', cwd: '/ws', permissionMode: 'supervised' });
    kernel.emit('s1', envelope('s1', { kind: 'Error', message: 'x' }));
    expect(logs.join('\n')).not.toContain('onEvent 回调抛错');
  });

  it('信任门回落（审查 MED-3）：未信任 project 同名扩展不能拆掉 global 守卫——回落加载被遮蔽的 global 版', async () => {
    const h = makeHost();
    const projectSpec: ExtensionSpec = { ...spec('bad-export.ts', 'project'), name: 'good', shadowedGlobal: spec('good.ts') };
    const loaded = await h.host.load([projectSpec]);
    expect(loaded).toEqual(['good']); // project 版被信任门拒 → global 版照常生效
    expect(h.logs.join('\n')).toContain('回落加载');
    expect(h.host.commands().map((c) => c.name)).toEqual(['/fixture']);
  });

  it('订阅换挂（审查 MED-4）：resume 会话经 UserPromptSubmit 接上；endSession 重建后换挂刷新死订阅', async () => {
    const h = makeHost();
    const api = await captureApi(h);
    const seen: string[] = [];
    api.onEvent((env) => seen.push(env.event.kind));
    // resume 会话不 fire SessionStart——首条续聊输入（UserPromptSubmit）即接上订阅。
    const bridge = h.kernel.hooks.find((x) => x.onUserPromptSubmit)!;
    await bridge.onUserPromptSubmit!({ sessionId: 'r1', cwd: '/ws', permissionMode: 'supervised' }, 'hi');
    h.kernel.emit('r1', envelope('r1', { kind: 'Error', message: 'a' }));
    expect(seen).toEqual(['Error']);
    // 每次提交换挂（先摘旧再订新）→ handler 恒只有一份，不重复 fan-out。
    await bridge.onUserPromptSubmit!({ sessionId: 'r1', cwd: '/ws', permissionMode: 'supervised' }, 'again');
    expect(h.kernel.handlers.get('r1')).toHaveLength(1);
    h.kernel.emit('r1', envelope('r1', { kind: 'Error', message: 'b' }));
    expect(seen).toEqual(['Error', 'Error']);
  });

  it('default export 非 defineExtension 产物 → 跳过 + 可行动告警', async () => {
    const { host, logs } = makeHost();
    expect(await host.load([spec('bad-export.ts')])).toEqual([]);
    expect(logs.join('\n')).toContain('不是 defineExtension');
  });

  it('信任门：project 未信任缺 confirm → 跳过 + onSkippedUntrusted；confirm 通过 → 加载', async () => {
    const skipped: string[] = [];
    const a = makeHost();
    expect(
      await a.host.load([spec('good.ts', 'project')], { onSkippedUntrusted: (n) => skipped.push(n) }),
    ).toEqual([]);
    expect(skipped).toEqual(['good']);

    const b = makeHost();
    expect(
      await b.host.load([spec('good.ts', 'project')], { confirmTrust: async () => true }),
    ).toEqual(['good']);

    // confirm 抛错按拒绝处理（fail-closed）。
    const c = makeHost();
    expect(
      await c.host.load([spec('good.ts', 'project')], {
        confirmTrust: async () => {
          throw new Error('tty 断了');
        },
      }),
    ).toEqual([]);
    expect(c.logs.join('\n')).toContain('按拒绝处理');
  });

  it('mcp__ 保留前缀工具被拒；扩展间命令撞名先到先得', async () => {
    const h = makeHost();
    const api = await captureApi(h);
    api.registerTool({
      descriptor: {
        name: 'mcp__x__y',
        kind: 'other',
        description: '',
        inputSchema: {},
        owner: 'plugin',
        availability: { always: true },
        approval: 'risk-based',
      },
      executor: { async *execute() {} },
    });
    expect(h.registry.executor('mcp__x__y')).toBeUndefined();
    expect(h.logs.join('\n')).toContain('mcp__');

    api.registerCommand({ name: 'dup', desc: 'A', run: async () => {} });
    api.registerCommand({ name: '/dup', desc: 'B', run: async () => {} });
    expect(h.host.commands().map((c) => c.desc)).toEqual(['A']);
    expect(h.logs.join('\n')).toContain('撞名');
  });
});

describe('5.2b — 行动面（exec / steer / followUp / onEvent）', () => {
  it('exec 收敛 AsyncIterable 为整段 output + exitCode；缺省 cwd 用装配值', async () => {
    const h = makeHost();
    const api = await captureApi(h);
    expect(await api.exec('echo hi')).toEqual({ output: 'ran:echo hi@/ws', exitCode: 3 });
    expect(await api.exec('echo hi', { cwd: '/elsewhere' })).toEqual({ output: 'ran:echo hi@/elsewhere', exitCode: 3 });
  });

  it('exec timeoutMs 超时中断（挂死命令不悬挂）', async () => {
    const h = makeHost();
    const api = await captureApi(h);
    await expect(api.exec('hang', { timeoutMs: 20 })).rejects.toThrow(/超时/);
  });

  it('steer 直通内核', async () => {
    const h = makeHost();
    const api = await captureApi(h);
    await api.steer('s1', '往东走');
    expect(h.kernel.steered).toEqual([{ sessionId: 's1', text: '往东走' }]);
  });

  it('followUp 只在 end_turn 出队（interrupted/failed 保留）；逐条出队与 TUI 判据一致', async () => {
    const h = makeHost();
    const api = await captureApi(h);
    api.followUp('s1', '第一条');
    api.followUp('s1', '第二条');
    expect(h.kernel.submitted).toHaveLength(0); // 入队不立发

    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    h.kernel.emit('s1', envelope('s1', { kind: 'TurnCompleted', stopReason: 'interrupted', usage }));
    expect(h.kernel.submitted).toHaveLength(0); // 中断不触发

    h.kernel.emit('s1', envelope('s1', { kind: 'TurnCompleted', stopReason: 'end_turn', usage }));
    expect(h.kernel.submitted.map((s) => s.prompt)).toEqual(['第一条']); // 一次只出一条
    h.kernel.emit('s1', envelope('s1', { kind: 'TurnCompleted', stopReason: 'end_turn', usage }));
    expect(h.kernel.submitted.map((s) => s.prompt)).toEqual(['第一条', '第二条']);
    expect(new Set(h.kernel.submitted.map((s) => s.idemKey)).size).toBe(2); // idemKey 不重复
  });

  it('onEvent：SessionStart hook 自动接订阅、全量事件 fan-out、单回调抛错围栏', async () => {
    const h = makeHost();
    const api = await captureApi(h);
    const seen: string[] = [];
    api.onEvent(() => {
      throw new Error('坏回调');
    });
    api.onEvent((env) => seen.push(env.event.kind));

    // 内核 fireSessionStart → host 内部 hook ensureSubscribed。
    const sessionStart = h.kernel.hooks.find((x) => x.onSessionStart);
    expect(sessionStart).toBeDefined();
    await sessionStart!.onSessionStart!({ sessionId: 's9', cwd: '/ws', permissionMode: 'supervised' });

    h.kernel.emit('s9', envelope('s9', { kind: 'Error', message: 'x' }));
    expect(seen).toEqual(['Error']); // 坏回调不影响后续监听者
    expect(h.logs.join('\n')).toContain('onEvent 回调抛错');
  });
});
