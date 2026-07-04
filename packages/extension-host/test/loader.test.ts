import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverExtensions,
  extensionTrustPath,
  loadTrustedExtensions,
  saveTrustedExtension,
} from '@yo-agent/extension-host';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'yo-ext-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('5.2b — 扩展发现（discoverExtensions）', () => {
  it('单文件式（.ts/.mts/.mjs）与目录式（<name>/extension.ts）都被发现', async () => {
    const dir = join(base, 'exts');
    await mkdir(join(dir, 'boxed'), { recursive: true });
    await writeFile(join(dir, 'single.ts'), '');
    await writeFile(join(dir, 'modern.mts'), '');
    await writeFile(join(dir, 'plain.mjs'), '');
    await writeFile(join(dir, 'ignored.txt'), '');
    await writeFile(join(dir, 'boxed', 'extension.ts'), '');
    const specs = await discoverExtensions([{ dir, source: 'global' }]);
    expect(specs.map((s) => s.name).sort()).toEqual(['boxed', 'modern', 'plain', 'single']);
    expect(specs.find((s) => s.name === 'boxed')?.modulePath).toBe(join(dir, 'boxed', 'extension.ts'));
  });

  it('project 同名覆盖 global（后目录优先）；目录不存在跳过不抛', async () => {
    const g = join(base, 'g');
    const p = join(base, 'p');
    await mkdir(g, { recursive: true });
    await mkdir(p, { recursive: true });
    await writeFile(join(g, 'dup.ts'), '');
    await writeFile(join(p, 'dup.ts'), '');
    const specs = await discoverExtensions([
      { dir: g, source: 'global' },
      { dir: p, source: 'project' },
      { dir: join(base, 'nope'), source: 'project' },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ name: 'dup', source: 'project', modulePath: join(p, 'dup.ts') });
    // 审查 MED-3：被遮蔽的 global spec 挂在 shadowedGlobal——project 版未过信任门时 host 回落加载。
    expect(specs[0]?.shadowedGlobal).toMatchObject({ name: 'dup', source: 'global', modulePath: join(g, 'dup.ts') });
  });
});

describe('5.2b — 项目信任门（extension-trust.json，照 mcp-trust 形制）', () => {
  it('清单不存在 → 空信任集；save 后可读回且幂等', async () => {
    expect(await loadTrustedExtensions(base, '/proj')).toEqual(new Set());
    await saveTrustedExtension(base, '/proj', 'foo');
    await saveTrustedExtension(base, '/proj', 'foo'); // 幂等不重复
    await saveTrustedExtension(base, '/proj', 'bar');
    await saveTrustedExtension(base, '/other', 'baz');
    expect(await loadTrustedExtensions(base, '/proj')).toEqual(new Set(['foo', 'bar']));
    expect(await loadTrustedExtensions(base, '/other')).toEqual(new Set(['baz']));
    const raw = JSON.parse(await readFile(extensionTrustPath(base), 'utf8')) as Record<string, string[]>;
    expect(raw['/proj']).toEqual(['foo', 'bar']);
  });

  it('清单损坏 → load 抛错（调用方 fail-closed 按空集）；save 重建不炸', async () => {
    await mkdir(join(base, '.yo-agent'), { recursive: true });
    await writeFile(extensionTrustPath(base), '{broken');
    await expect(loadTrustedExtensions(base, '/proj')).rejects.toThrow(/解析失败/);
    await saveTrustedExtension(base, '/proj', 'foo'); // 损坏文件被重建
    expect(await loadTrustedExtensions(base, '/proj')).toEqual(new Set(['foo']));
  });

  it('顶层非对象 / 条目非数组 → 空信任集（不抛 TypeError）', async () => {
    await mkdir(join(base, '.yo-agent'), { recursive: true });
    await writeFile(extensionTrustPath(base), JSON.stringify([1, 2]));
    expect(await loadTrustedExtensions(base, '/proj')).toEqual(new Set());
    await writeFile(extensionTrustPath(base), JSON.stringify({ '/proj': 'not-array' }));
    expect(await loadTrustedExtensions(base, '/proj')).toEqual(new Set());
  });
});
