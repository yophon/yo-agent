import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool, writeTool, lsTool, InMemoryToolRegistry } from '@yo-agent/tools';
import type { ToolContext, ToolEvent, RegisteredTool, AvailabilityExpr } from '@yo-agent/tools';

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
  const mkTool = (
    name: string,
    owner: 'core' | 'plugin' | 'mcp' = 'mcp',
    availability: AvailabilityExpr = { always: true },
  ): RegisteredTool => ({
    descriptor: { name, kind: 'other', description: name, inputSchema: { type: 'object' }, owner, availability, approval: 'risk-based' },
    executor: {
      async *execute() {
        yield { kind: 'output', chunk: name };
      },
    },
  });

  it('内置按注册序稳定（§15.4，保 prompt cache 前缀）', () => {
    const reg = new InMemoryToolRegistry();
    reg.register(writeTool);
    reg.register(readTool);
    reg.register(lsTool);
    const names = reg.resolveAvailable({ sessionId: 's', cwd: dir }).map((d) => d.name);
    expect(names).toEqual(['write', 'read', 'ls']); // 注册序，非字典序
    expect(reg.executor('read')).toBe(readTool.executor);
    expect(reg.executor('nope')).toBeUndefined();
  });

  it('撞名 register 抛错（禁静默覆盖）；unregister 后可重注册', () => {
    const reg = new InMemoryToolRegistry();
    reg.register(readTool);
    expect(() => reg.register(readTool)).toThrow(/冲突/);
    expect(() => reg.register(mkTool('read'))).toThrow(/冲突/); // 外部与内置撞名也拒
    // 抛错路径不污染注册表：executor 仍指向原工具、version 不增（审查 TST-4）
    expect(reg.executor('read')).toBe(readTool.executor);
    const v = reg.toolsetVersion();
    try {
      reg.register(mkTool('read'));
    } catch {
      /* expected */
    }
    expect(reg.toolsetVersion()).toBe(v);
    reg.unregister('read');
    expect(() => reg.register(mkTool('read'))).not.toThrow();
  });

  it('toolsetVersion 随注册/反注册自增，未命中不增', () => {
    const reg = new InMemoryToolRegistry();
    const v0 = reg.toolsetVersion();
    reg.register(readTool);
    expect(reg.toolsetVersion()).toBe(v0 + 1);
    reg.unregister('read');
    expect(reg.toolsetVersion()).toBe(v0 + 2);
    reg.unregister('nope');
    expect(reg.toolsetVersion()).toBe(v0 + 2);
  });

  it('MCP/plugin 工具不挤动内置 prompt 前缀（§15.4 两段排序）', () => {
    const reg = new InMemoryToolRegistry();
    reg.register(writeTool);
    reg.register(readTool);
    reg.register(lsTool);
    reg.register(mkTool('mcp__z__a'));
    reg.register(mkTool('mcp__a__b'));
    const names = reg.resolveAvailable({ sessionId: 's', cwd: dir }).map((d) => d.name);
    expect(names).toEqual(['write', 'read', 'ls', 'mcp__a__b', 'mcp__z__a']);
  });

  it('configFlag 谓词：flags 控制工具显隐（3C 熔断接缝）', () => {
    const reg = new InMemoryToolRegistry();
    reg.register(mkTool('gated', 'mcp', { configFlag: 'srv:healthy' }));
    expect(reg.resolveAvailable({ sessionId: 's', cwd: dir }).map((d) => d.name)).toEqual([]);
    expect(
      reg.resolveAvailable({ sessionId: 's', cwd: dir, flags: new Set(['srv:healthy']) }).map((d) => d.name),
    ).toEqual(['gated']);
  });
});
