import { describe, expect, it } from 'vitest';
import { makeMemoryWriteTool } from '../src/memory-tool';
import type { ToolContext } from '../src/index';

const ctx: ToolContext = { sessionId: 's1', cwd: '/w' };

async function run(tool: ReturnType<typeof makeMemoryWriteTool>, input: unknown): Promise<string> {
  let out = '';
  for await (const ev of tool.executor.execute(input, ctx)) {
    if (ev.kind === 'output') out += ev.chunk;
  }
  return out;
}

describe('4.9e — memory_write 工具', () => {
  it('写入经注入 writer 落盘，回执含写入行', async () => {
    const written: string[] = [];
    const tool = makeMemoryWriteTool(async (content) => {
      written.push(content);
      return { line: `- ${content}`, deduped: false };
    });
    const out = await run(tool, { content: '用户偏好中文回复' });
    expect(written).toEqual(['用户偏好中文回复']);
    expect(out).toContain('已写入长期记忆：- 用户偏好中文回复');
  });

  it('重复写幂等：deduped 回执明示跳过', async () => {
    const tool = makeMemoryWriteTool(async (content) => ({ line: `- ${content}`, deduped: true }));
    const out = await run(tool, { content: 'x' });
    expect(out).toContain('已存在同内容记忆，跳过');
  });

  it('空 content 报错；writer 抛错原样上抛（可行动信息不丢）', async () => {
    const tool = makeMemoryWriteTool(async () => {
      throw new Error('写入长期记忆失败：EACCES。请检查 /w/MEMORY.md 的写权限与磁盘空间');
    });
    await expect(run(tool, { content: '  ' })).rejects.toThrow('content 不能为空');
    await expect(run(tool, { content: 'x' })).rejects.toThrow(/写权限与磁盘空间/);
  });

  it('descriptor：edit 类 + risk-based（写盘走权限闸门，read-only 档可拒）', () => {
    const tool = makeMemoryWriteTool(async () => ({ line: '-', deduped: false }));
    expect(tool.descriptor.kind).toBe('edit');
    expect(tool.descriptor.approval).toBe('risk-based');
    expect(tool.descriptor.name).toBe('memory_write');
  });
});
