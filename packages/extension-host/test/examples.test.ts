import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Hooks } from '@yo-agent/kernel';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { ExecBackend, ExecChunk, ExecOpts, ToolEvent } from '@yo-agent/tools';
import { ExtensionHost } from '@yo-agent/extension-host';
import type { ExtensionKernel, ExtensionSpec } from '@yo-agent/extension-host';

/** 仓库内示例扩展（examples/extensions/，不自动加载）兼作集成测试 fixture——示例坏了测试红。 */
const example = (file: string): ExtensionSpec => ({
  name: file.replace(/\.ts$/, ''),
  modulePath: fileURLToPath(new URL(`../../../examples/extensions/${file}`, import.meta.url)),
  source: 'global',
});

/** git status 可脚本化的 exec 后端。 */
class GitStatusBackend implements ExecBackend {
  readonly kind = 'local-subprocess' as const;
  constructor(private porcelain: string) {}
  async *exec(cmd: string, _opts: ExecOpts): AsyncIterable<ExecChunk> {
    if (cmd !== 'git status --porcelain') throw new Error(`意外命令：${cmd}`);
    yield { chunk: this.porcelain };
    yield { chunk: '', exitCode: 0 };
  }
}

function hostWith(backend: ExecBackend): { host: ExtensionHost; kernel: { hooks: Hooks[] }; registry: InMemoryToolRegistry } {
  const registry = new InMemoryToolRegistry();
  const kernel = {
    hooks: [] as Hooks[],
    registerHook(h: Hooks) {
      kernel.hooks.push(h);
      return () => {};
    },
    subscribe: () => () => {},
    steer: async () => {},
    submitInput: async () => ({}),
  } satisfies ExtensionKernel & { hooks: Hooks[] };
  const host = new ExtensionHost({ registry, execBackend: backend, defaultCwd: '/ws', log: () => {} });
  host.bindKernel(kernel);
  return { host, kernel, registry };
}

const ctx = { sessionId: 's1', cwd: '/ws', permissionMode: 'supervised' } as const;

describe('5.2c — 示例扩展集成（examples/extensions/）', () => {
  it('dirty-repo-guard：脏工作区拦破坏性 git 命令；干净放行；非破坏命令不查', async () => {
    const dirty = hostWith(new GitStatusBackend(' M a.ts\n?? b.ts\n'));
    expect(await dirty.host.load([example('dirty-repo-guard.ts')])).toEqual(['dirty-repo-guard']);
    const hook = dirty.kernel.hooks.find((h) => h.onPreToolUse)!;
    const denied = await hook.onPreToolUse!(ctx, { tool: 'bash', kind: 'execute', input: { command: 'git checkout main' } });
    expect(denied).toMatchObject({ decision: 'deny' });
    expect((denied as { reason?: string }).reason).toContain('2 个未提交文件');
    // 非破坏命令 / 非 bash 工具：直接放行（返回 undefined），不触发 exec。
    expect(await hook.onPreToolUse!(ctx, { tool: 'bash', kind: 'execute', input: { command: 'git status' } })).toBeUndefined();
    expect(await hook.onPreToolUse!(ctx, { tool: 'read', kind: 'read', input: {} })).toBeUndefined();

    const clean = hostWith(new GitStatusBackend(''));
    await clean.host.load([example('dirty-repo-guard.ts')]);
    const cleanHook = clean.kernel.hooks.find((h) => h.onPreToolUse)!;
    expect(await cleanHook.onPreToolUse!(ctx, { tool: 'bash', kind: 'execute', input: { command: 'git reset --hard' } })).toBeUndefined();
  });

  it('word-count：工具可调（钳制后可见）+ 命令注册 + system 段', async () => {
    const h = hostWith(new GitStatusBackend(''));
    await h.host.load([example('word-count.ts')]);
    const desc = h.registry
      .resolveAvailable({ sessionId: 's1', cwd: '/ws', flags: h.host.flags() })
      .find((d) => d.name === 'word_count');
    expect(desc).toMatchObject({ owner: 'plugin', approval: 'risk-based' });
    const out: string[] = [];
    for await (const ev of h.registry.executor('word_count')!.execute({ text: '你好 world' }, { sessionId: 's1', cwd: '/ws' })) {
      out.push((ev as ToolEvent & { chunk: string }).chunk);
    }
    expect(out.join('')).toBe('字符数 8，词数 2');
    expect(h.host.commands().map((c) => c.name)).toEqual(['/exthello']);
    expect(h.host.renderSystemSections({ model: 'm', cwd: '/ws', permissionMode: 'supervised' }).join('')).toContain('word_count');
  });

  it('queue-and-nudge：/queue 入队 followUp、/nudge 直通 steer', async () => {
    const registry = new InMemoryToolRegistry();
    const steered: string[] = [];
    const submitted: string[] = [];
    const handlers: Array<(env: Parameters<Parameters<ExtensionKernel['subscribe']>[2]>[0]) => void> = [];
    const kernel: ExtensionKernel = {
      registerHook: () => () => {},
      subscribe: (_sid, _c, h) => {
        handlers.push(h);
        return () => {};
      },
      steer: async (_sid, text) => {
        steered.push(text);
      },
      submitInput: async (_sid, prompt) => {
        submitted.push(prompt);
        return {};
      },
    };
    const host = new ExtensionHost({ registry, defaultCwd: '/ws', log: () => {} });
    host.bindKernel(kernel);
    await host.load([example('queue-and-nudge.ts')]);

    const notices: string[] = [];
    const cmdCtx = { sessionId: 's1' as const, notice: (t: string) => notices.push(t) };
    const byName = new Map(host.commands().map((c) => [c.name, c]));
    await byName.get('/queue')!.run(cmdCtx, '继续下一步');
    expect(submitted).toHaveLength(0); // 入队不立发
    handlers[0]!({
      sessionId: 's1',
      cursor: 1,
      parentId: null,
      turnId: 't1',
      ts: 1,
      event: { kind: 'TurnCompleted', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
    });
    expect(submitted).toEqual(['继续下一步']);

    await byName.get('/nudge')!.run(cmdCtx, '注意边界条件');
    expect(steered).toEqual(['注意边界条件']);
    expect(notices.some((n) => n.includes('已排队'))).toBe(true);
  });
});
