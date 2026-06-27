import { describe, it, expect } from 'vitest';
import { makeSkillActivateTool, SKILL_ACTIVATE_TOOL } from '@yo-agent/tools';
import type { ToolContext, ToolEvent } from '@yo-agent/tools';

async function collect(stream: AsyncIterable<ToolEvent>): Promise<string> {
  let s = '';
  for await (const e of stream) if (e.kind === 'output') s += e.chunk;
  return s;
}

const ctx = (): ToolContext => ({ sessionId: 's', cwd: '/work' });

describe('4D — skill_activate 工具', () => {
  const byName = new Map([['foo', { name: 'foo', body: 'FOO 全文指令' }]]);
  const tool = makeSkillActivateTool(
    (n) => byName.get(n),
    () => [...byName.keys()],
  );

  it('结构契约：approval=never、kind=read、名对齐常量', () => {
    expect(tool.descriptor.name).toBe(SKILL_ACTIVATE_TOOL);
    expect(tool.descriptor.approval).toBe('never');
    expect(tool.descriptor.kind).toBe('read');
  });

  it('激活已知技能 → 回全文', async () => {
    const out = await collect(tool.executor.execute({ name: 'foo' }, ctx()));
    expect(out).toContain('FOO 全文指令');
    expect(out).toContain('技能：foo');
  });

  it('未知技能 → 抛错并列出可用', async () => {
    await expect(collect(tool.executor.execute({ name: 'bar' }, ctx()))).rejects.toThrow(/未找到技能.*foo/);
  });

  it('空 name → 抛错', async () => {
    await expect(collect(tool.executor.execute({}, ctx()))).rejects.toThrow(/name/);
  });
});
