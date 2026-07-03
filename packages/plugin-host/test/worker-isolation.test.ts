import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { ToolContext, ToolEvent } from '@yo-agent/tools';
import { DefaultPluginHost } from '../src/host';
import type { PluginSpec } from '../src/host';
import { WorkerPluginTransport, workerEntryUrl, } from '../src';

/**
 * 退出标准③离线达成（真 worker_threads）：故意崩溃/越权插件 → 主进程存活 + 心跳检测 + 工具降级 +
 * 插件读不到主进程 secret。用纯 .mjs fixture 经通用 worker-entry.mjs 加载（绕开 4C 记录的 worker+tsx 脆弱性）。
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const toolCtx = (): ToolContext => ({ sessionId: 's', cwd: '/w' });

async function collect(stream: AsyncIterable<ToolEvent>): Promise<string> {
  let s = '';
  for await (const e of stream) if (e.kind === 'output') s += e.chunk;
  return s;
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let host: DefaultPluginHost | undefined;
afterEach(async () => {
  await host?.closeAll();
  host = undefined;
});

function makeHost(fixture: string, over: Partial<ConstructorParameters<typeof DefaultPluginHost>[0]> = {}): {
  host: DefaultPluginHost;
  registry: InMemoryToolRegistry;
} {
  const registry = new InMemoryToolRegistry();
  const entry = workerEntryUrl();
  const h = new DefaultPluginHost({
    registry,
    transportFor: (spec: PluginSpec) =>
      new WorkerPluginTransport({
        id: spec.id,
        entry,
        workerData: { id: spec.id, modulePath: pathToFileURL(join(FIX, fixture)).href },
      }),
    maxReconnect: 0,
    ...over,
  });
  host = h;
  return { host: h, registry };
}

describe('4E — 真 worker_threads 隔离', () => {
  it('正常插件：经真 Worker 往返 invoke → 回声输出', async () => {
    const { host: h, registry } = makeHost('plugin-ok.mjs');
    const ok = await h.start([{ id: 'ok' }]);
    expect(ok).toEqual(['ok']);
    const out = await collect(registry.executor('ok_echo')!.execute({ a: 1 }, toolCtx()));
    expect(out).toBe('echo:{"a":1}');
  });

  it('secret 隔离：插件 Worker 读不到 YO_SECRET_SENTINEL，但有 PATH', async () => {
    process.env.YO_SECRET_SENTINEL = 'TOP-SECRET';
    try {
      const { host: h, registry } = makeHost('plugin-env.mjs');
      await h.start([{ id: 'env' }]);
      const out = await collect(registry.executor('env_probe')!.execute({}, toolCtx()));
      const probe = JSON.parse(out);
      expect(probe.hasSecret).toBe(false); // secret 被白名单剥离
      expect(probe.hasPath).toBe(true);
    } finally {
      delete process.env.YO_SECRET_SENTINEL;
    }
  });

  it('故意崩溃插件（未捕获异常）→ 主进程存活 + 检测到崩溃 + 工具降级不可见（退出标准③）', async () => {
    const { host: h, registry } = makeHost('plugin-crash.mjs');
    await h.start([{ id: 'crash' }]);
    expect(h.isHealthy('crash')).toBe(true); // 握手成功
    await waitFor(() => !h.isHealthy('crash')); // worker 30ms 后抛 → onCrash 降级
    expect(h.flags()).toEqual([]); // 健康标志撤下
    const visible = registry.resolveAvailable({ ...toolCtx(), flags: new Set(h.flags()) });
    expect(visible.map((d) => d.name)).not.toContain('crash_noop'); // 工具消失
    // 主进程仍可正常工作（断言到此即证明未被拖垮）
    expect(true).toBe(true);
  });

  it('越权/主动退出插件（process.exit）→ invoke 被围栏收敛为错误，主进程存活', async () => {
    const { host: h, registry } = makeHost('plugin-exit.mjs');
    await h.start([{ id: 'exit' }]);
    await expect(collect(registry.executor('exit_now')!.execute({}, toolCtx()))).rejects.toThrow();
    await waitFor(() => !h.isHealthy('exit')); // 非 0 exit → onCrash 降级
    expect(h.isHealthy('exit')).toBe(false);
  });
});
