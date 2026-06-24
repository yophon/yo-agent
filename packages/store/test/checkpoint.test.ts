import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowGitCheckpointer } from '@yo-agent/store';

describe('ShadowGitCheckpointer（isomorphic-git 影子快照）', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yo-cp-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('snapshot → 修改 → rollback 还原文件内容', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1', 'utf8');
    const cp = new ShadowGitCheckpointer({ dir });
    const s1 = await cp.snapshot('初始');
    expect(s1.ref).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(dir, 'a.txt'), 'v2-修改', 'utf8');
    await cp.snapshot('改动');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('v2-修改');

    await cp.rollback(s1.ref);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('v1');
  });

  it('rollback 移除快照后新增的文件', async () => {
    await writeFile(join(dir, 'a.txt'), 'a', 'utf8');
    const cp = new ShadowGitCheckpointer({ dir });
    const s1 = await cp.snapshot('只有 a');

    await writeFile(join(dir, 'b.txt'), 'b', 'utf8');
    await cp.snapshot('a + b');
    expect(existsSync(join(dir, 'b.txt'))).toBe(true);

    await cp.rollback(s1.ref);
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
  });

  it('忽略 node_modules / .git / .yo-agent，不纳入快照', async () => {
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'big.js'), 'x', 'utf8');
    await writeFile(join(dir, 'src.ts'), 'code', 'utf8');
    const cp = new ShadowGitCheckpointer({ dir });
    await cp.snapshot('s');
    const log = await cp.list();
    expect(log.length).toBe(1);
    expect(log[0]!.message).toBe('s');
    // node_modules 应仍在（不被影子库管理；rollback 也不动它）。
    expect(existsSync(join(dir, 'node_modules', 'big.js'))).toBe(true);
  });

  it('rollback 清理"快照后新建、从未被快照"的 untracked 文件（精确恢复）', async () => {
    await writeFile(join(dir, 'a.txt'), 'a', 'utf8');
    const cp = new ShadowGitCheckpointer({ dir });
    const s1 = await cp.snapshot('只有 a');
    // 写一个从未被 snapshot 的新文件（untracked），再回滚到 s1。
    await writeFile(join(dir, 'evil.txt'), 'danger', 'utf8');
    await cp.rollback(s1.ref);
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false); // untracked 危险写入被清掉
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a');
  });

  it('list 返回快照提交（最新在前）', async () => {
    await writeFile(join(dir, 'a.txt'), '1', 'utf8');
    const cp = new ShadowGitCheckpointer({ dir });
    await cp.snapshot('cp1');
    await writeFile(join(dir, 'a.txt'), '2', 'utf8');
    await cp.snapshot('cp2');
    const log = await cp.list();
    expect(log.map((c) => c.message)).toEqual(['cp2', 'cp1']);
  });
});
