import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool, makeBashTool, BASH_UNTRUSTED_MARKER, BASH_OUTPUT_CAP_BYTES, UnconfiguredExecBackend } from '@yo-agent/tools';
import type { ToolContext, ToolEvent } from '@yo-agent/tools';

async function collect(stream: AsyncIterable<ToolEvent>): Promise<string> {
  let s = '';
  for await (const e of stream) if (e.kind === 'output') s += e.chunk;
  return s;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yo-bash-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({ sessionId: 's', cwd: dir });

describe('4B — bash 工具', () => {
  it('结构契约：approval 必为 risk-based（绝不 never，必经审批门）、kind=execute', () => {
    expect(bashTool.descriptor.approval).toBe('risk-based');
    expect(bashTool.descriptor.approval).not.toBe('never');
    expect(bashTool.descriptor.kind).toBe('execute');
    expect(bashTool.descriptor.owner).toBe('core');
  });

  it('执行命令：输出带不可信数据标注（注入防护）+ 命令结果', async () => {
    const out = await collect(bashTool.executor.execute({ command: 'echo hello-bash' }, ctx()));
    expect(out).toContain(BASH_UNTRUSTED_MARKER); // 注入防护标注
    expect(out).toContain('hello-bash');
  });

  it('非零退出码标注', async () => {
    const out = await collect(bashTool.executor.execute({ command: 'exit 2' }, ctx()));
    expect(out).toContain('[退出码 2]');
  });

  it('command 缺失/空 → 抛错', async () => {
    await expect(collect(bashTool.executor.execute({}, ctx()))).rejects.toThrow(/command/);
    await expect(collect(bashTool.executor.execute({ command: '   ' }, ctx()))).rejects.toThrow(/command/);
  });

  it('大输出截断：回灌限额 + 完整输出写盘只回路径', async () => {
    const out = await collect(bashTool.executor.execute({ command: "head -c 60000 /dev/zero | tr '\\0' 'a'" }, ctx()));
    expect(out).toContain('已截断');
    const m = out.match(/完整输出见 (\S+)\]/);
    expect(m).not.toBeNull();
    const full = await readFile(m![1]!, 'utf8');
    expect(full.length).toBe(60000); // 写盘的是完整输出
    await rm(m![1]!, { force: true });
    // 回灌内容（去掉标注与截断提示）远小于完整输出，约束在阈值附近。
    expect(out.length).toBeLessThan(BASH_OUTPUT_CAP_BYTES + 2048);
  });

  it('makeBashTool 可换后端（ADR-19 透明切档）：未配置后端被调即抛', async () => {
    const t = makeBashTool(new UnconfiguredExecBackend('docker'));
    await expect(collect(t.executor.execute({ command: 'echo x' }, ctx()))).rejects.toThrow(/未配置/);
  });
});
