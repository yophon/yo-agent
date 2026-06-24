import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool, writeTool, lsTool, InMemoryToolRegistry } from '@yo-agent/tools';
import type { ToolContext, ToolEvent } from '@yo-agent/tools';

async function collect(stream: AsyncIterable<ToolEvent>): Promise<string> {
  let s = '';
  for await (const e of stream) if (e.kind === 'output') s += e.chunk;
  return s;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yo-tools-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('内置工具', () => {
  it('write → read round-trip（限 cwd）', async () => {
    const ctx: ToolContext = { sessionId: 's', cwd: dir };
    await collect(writeTool.executor.execute({ path: 'a.txt', content: 'hello' }, ctx));
    expect(await collect(readTool.executor.execute({ path: 'a.txt' }, ctx))).toBe('hello');
  });

  it('ls 列出文件', async () => {
    const ctx: ToolContext = { sessionId: 's', cwd: dir };
    await collect(writeTool.executor.execute({ path: 'b.txt', content: 'x' }, ctx));
    expect((await collect(lsTool.executor.execute({ path: '.' }, ctx))).split('\n')).toContain('b.txt');
  });

  it('confine 拒绝越界路径', async () => {
    const ctx: ToolContext = { sessionId: 's', cwd: dir };
    await expect(collect(readTool.executor.execute({ path: '../escape' }, ctx))).rejects.toThrow(/越界/);
  });
});

describe('InMemoryToolRegistry', () => {
  it('按名稳定排序（保 prompt cache）', () => {
    const reg = new InMemoryToolRegistry();
    reg.register(writeTool);
    reg.register(readTool);
    reg.register(lsTool);
    const names = reg.resolveAvailable({ sessionId: 's', cwd: dir }).map((d) => d.name);
    expect(names).toEqual(['ls', 'read', 'write']);
    expect(reg.executor('read')).toBe(readTool.executor);
    expect(reg.executor('nope')).toBeUndefined();
  });
});
