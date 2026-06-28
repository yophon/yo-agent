import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool, writeTool } from '@yo-agent/tools';
import type { ToolContext, ToolEvent } from '@yo-agent/tools';

async function collect(stream: AsyncIterable<ToolEvent>): Promise<string> {
  let s = '';
  for await (const e of stream) if (e.kind === 'output') s += e.chunk;
  return s;
}

/** 审查 4B-H1 回归：confine 须用 realpath 解析符号链接，cwd 内指向外部的软链不得逃逸。 */
describe('4B 收口 — confine 符号链接逃逸防护', () => {
  let work: string;
  let outside: string;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'yo-confine-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'yo-confine-out-'));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({ sessionId: 's', cwd: work });

  it('read 经 cwd 内软链读取 cwd 外机密 → 拒绝', async () => {
    await writeFile(join(outside, 'secret'), 'TOP-SECRET-CREDENTIALS');
    await symlink(join(outside, 'secret'), join(work, 'creds')); // work/creds -> outside/secret
    await expect(collect(readTool.executor.execute({ path: 'creds' }, ctx()))).rejects.toThrow(/越界|逃逸/);
  });

  it('write 经 cwd 内目录软链写到 cwd 外 → 拒绝', async () => {
    await symlink(outside, join(work, 'link')); // work/link -> outside（目录软链）
    await expect(
      collect(writeTool.executor.execute({ path: 'link/evil.txt', content: 'x' }, ctx())),
    ).rejects.toThrow(/越界|逃逸/);
  });

  it('cwd 内真实文件正常读写（不误伤）', async () => {
    await mkdir(join(work, 'sub'), { recursive: true });
    await writeFile(join(work, 'sub', 'a.txt'), 'hello');
    expect(await collect(readTool.executor.execute({ path: 'sub/a.txt' }, ctx()))).toBe('hello');
    await collect(writeTool.executor.execute({ path: 'sub/b.txt', content: 'world' }, ctx()));
    expect(await collect(readTool.executor.execute({ path: 'sub/b.txt' }, ctx()))).toBe('world');
  });
});
