import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConventionFiles, dirChain } from '@yo-agent/kernel';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'yo-conv-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadConventionFiles（DESIGN §5.2）', () => {
  it('从根到 cwd 逐级合并（更具体在后）+ 兼容 AGENTS.md', async () => {
    await writeFile(join(root, 'yo.md'), 'ROOT 规则');
    const sub = join(root, 'app');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'AGENTS.md'), 'APP 规则');
    const merged = await loadConventionFiles(sub);
    expect(merged).toContain('ROOT 规则');
    expect(merged).toContain('APP 规则');
    expect(merged.indexOf('ROOT 规则')).toBeLessThan(merged.indexOf('APP 规则'));
  });

  it('每目录只取第一个存在的文件（yo.md 优先于 AGENTS.md）', async () => {
    const d = join(root, 'p2');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'yo.md'), 'YOFILE');
    await writeFile(join(d, 'AGENTS.md'), 'AGENTSFILE');
    const merged = await loadConventionFiles(d, { filenames: ['yo.md', 'AGENTS.md'] });
    expect(merged).toContain('YOFILE');
    expect(merged).not.toContain('AGENTSFILE');
  });

  it('maxBytes 截断', async () => {
    const d = join(root, 'p3');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'yo.md'), 'x'.repeat(100));
    const merged = await loadConventionFiles(d, { maxBytes: 10 });
    expect(merged.length).toBeLessThanOrEqual(10);
  });

  it('dirChain：根在前、cwd 在后', () => {
    const chain = dirChain(root);
    expect(chain[chain.length - 1]).toBe(root);
    expect(chain.length).toBeGreaterThan(1);
  });
});
