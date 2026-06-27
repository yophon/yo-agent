import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSubprocessExecBackend } from '@yo-agent/tools';
import type { ExecChunk } from '@yo-agent/tools';

async function collect(stream: AsyncIterable<ExecChunk>): Promise<{ out: string; exitCode?: number }> {
  let out = '';
  let exitCode: number | undefined;
  for await (const c of stream) {
    out += c.chunk;
    if (c.exitCode !== undefined) exitCode = c.exitCode;
  }
  return { out, exitCode };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yo-exec-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('4B — LocalSubprocessExecBackend（L1 子进程隔离）', () => {
  it('流式 stdout + 退出码 0', async () => {
    const be = new LocalSubprocessExecBackend();
    const { out, exitCode } = await collect(be.exec("printf 'a\\nb\\n'", { cwd: dir }));
    expect(out).toBe('a\nb\n');
    expect(exitCode).toBe(0);
  });

  it('非零退出码透传', async () => {
    const be = new LocalSubprocessExecBackend();
    const { exitCode } = await collect(be.exec('exit 3', { cwd: dir }));
    expect(exitCode).toBe(3);
  });

  it('secret 不泄漏给子进程：非白名单 env（如 *_API_KEY）被剥离；PATH 白名单透传', async () => {
    const be = new LocalSubprocessExecBackend({
      baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'SENTINEL_LEAK', YO_DEVICE_KEY: 'SENTINEL2' },
    });
    const { out } = await collect(
      be.exec('echo "key=[$ANTHROPIC_API_KEY]"; echo "dev=[$YO_DEVICE_KEY]"; echo "path=[${PATH:+set}]"', { cwd: dir }),
    );
    expect(out).toContain('key=[]'); // secret 剥离
    expect(out).toContain('dev=[]'); // 设备私钥剥离
    expect(out).toContain('path=[set]'); // PATH 白名单透传
    expect(out).not.toContain('SENTINEL');
  });

  it('cwd 作起点：命令在指定 workspace 内运行', async () => {
    await writeFile(join(dir, 'sentinel.txt'), 'x');
    const be = new LocalSubprocessExecBackend();
    const { out } = await collect(be.exec('ls', { cwd: dir }));
    expect(out).toContain('sentinel.txt');
  });

  it('额外 env 白名单 opt-in：调用方显式透传', async () => {
    const be = new LocalSubprocessExecBackend({ baseEnv: { PATH: process.env.PATH, EXTRA_OK: 'visible' }, envWhitelist: ['EXTRA_OK'] });
    const { out } = await collect(be.exec('echo "[$EXTRA_OK]"', { cwd: dir }));
    expect(out).toContain('[visible]');
  });

  it('abort 立即终止长命令（不挂死、不留迭代器悬挂）', async () => {
    const be = new LocalSubprocessExecBackend();
    const ac = new AbortController();
    const run = (async () => {
      for await (const _ of be.exec('sleep 30', { cwd: dir, signal: ac.signal })) void _;
    })();
    const t = setTimeout(() => ac.abort(new Error('stop')), 120);
    await expect(run).rejects.toThrow();
    clearTimeout(t);
  });

  it('已 abort 的 signal → 立即抛，不起进程', async () => {
    const be = new LocalSubprocessExecBackend();
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    await expect(collect(be.exec('echo hi', { cwd: dir, signal: ac.signal }))).rejects.toThrow();
  });
});
