import { describe, expect, it } from 'vitest';
import {
  MemoryFileSystem,
  appendMemoryLine,
  dirnamePath,
  expandImports,
  joinPath,
  loadConventionFiles,
  loadRecipes,
  loadSkills,
  normalizePath,
  resolvePath,
} from '@yo-agent/kernel/core';

describe('5.2a — 纯路径助手（POSIX，core 禁 node:path）', () => {
  it('normalizePath：折叠重复分隔符、消解 ./..、绝对路径越根钳制', () => {
    expect(normalizePath('/a//b/./c')).toBe('/a/b/c');
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
    expect(normalizePath('/../..')).toBe('/'); // 越根钳制
    expect(normalizePath('a/../../b')).toBe('../b'); // 相对保留前导 ..
    expect(normalizePath('')).toBe('.');
  });

  it('joinPath / dirnamePath / resolvePath 对齐 node path 语义', () => {
    expect(joinPath('/a', 'b', 'c.md')).toBe('/a/b/c.md');
    expect(joinPath('/a', '../x')).toBe('/x');
    expect(dirnamePath('/a/b')).toBe('/a');
    expect(dirnamePath('/a')).toBe('/');
    expect(dirnamePath('/')).toBe('/');
    expect(dirnamePath('a')).toBe('.');
    expect(resolvePath('/base', 'rel/f.md')).toBe('/base/rel/f.md');
    expect(resolvePath('/base', '/abs/f.md')).toBe('/abs/f.md'); // 右侧绝对段获胜
  });
});

describe('5.2a — MemoryFileSystem', () => {
  it('读写/列目录/stat/exists/realpath 基本面；目录由文件路径隐式派生', async () => {
    const fs = new MemoryFileSystem({ '/a/one.md': 'ONE', '/a/sub/two.md': 'TWO' });
    expect(await fs.readTextFile('/a/one.md')).toBe('ONE');
    expect(await fs.listDir('/a')).toEqual(['one.md', 'sub']);
    expect((await fs.stat('/a/one.md')).isFile).toBe(true);
    expect((await fs.stat('/a/sub')).isDirectory).toBe(true);
    expect(await fs.exists('/a/sub')).toBe(true);
    expect(await fs.exists('/nope')).toBe(false);
    expect(await fs.realpath('/a/../a/one.md')).toBe('/a/one.md'); // 规范化
    await fs.writeTextFile('/b/new.md', 'NEW');
    expect(await fs.readTextFile('/b/new.md')).toBe('NEW');
  });

  it('缺失路径抛错（read/listDir/stat/realpath——调用方靠 try/catch 走跳过/fail-closed 分支）', async () => {
    const fs = new MemoryFileSystem();
    await expect(fs.readTextFile('/x')).rejects.toThrow(/ENOENT/);
    await expect(fs.listDir('/x')).rejects.toThrow(/ENOENT/);
    await expect(fs.stat('/x')).rejects.toThrow(/ENOENT/);
    await expect(fs.realpath('/x')).rejects.toThrow(/ENOENT/);
    expect(await fs.listDir('/')).toEqual([]); // 根恒存在
  });
});

describe('5.2a — 纯逻辑模块喂 MemoryFileSystem（浏览器面等价能力）', () => {
  it('loadConventionFiles：发现链 + MEMORY.md + @import（workspaceRoot="/" 边界不误拒）', async () => {
    const fs = new MemoryFileSystem({
      '/yo.md': 'ROOT 规则',
      '/app/AGENTS.md': 'APP 规则',
      '/MEMORY.md': '索引 @notes/fact.md',
      '/notes/fact.md': 'FACT-CONTENT',
    });
    const out = await loadConventionFiles(fs, '/app', { workspaceRoot: '/' });
    expect(out).toContain('ROOT 规则');
    expect(out).toContain('APP 规则');
    expect(out).toContain('FACT-CONTENT'); // @import 在根 workspace 下正常展开（'//' 前缀边界修正）
  });

  it('expandImports：越界目标在 MemoryFileSystem 上同样被拒', async () => {
    const fs = new MemoryFileSystem({ '/secret.md': 'SECRET', '/ws/a.md': 'A' });
    const out = await expandImports(fs, '@../secret.md', '/ws', '/ws');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('越界');
  });

  it('loadSkills / loadRecipes：单文件与目录式技能、recipe 解析全走虚拟 FS', async () => {
    const fs = new MemoryFileSystem({
      '/.yo-agent/skills/foo.md': '---\nname: foo\ndescription: 单文件技能\n---\nFOO 全文',
      '/.yo-agent/skills/bar/SKILL.md': '---\ndescription: 目录式\n---\nBAR 全文',
      '/.yo-agent/agents/researcher.md': '---\nname: researcher\ntools: read\n---\nPROMPT',
    });
    const skills = await loadSkills(fs, [{ dir: '/.yo-agent/skills', source: 'web' }]);
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get('foo')?.body).toBe('FOO 全文');
    expect(byName.get('bar')?.description).toBe('目录式');
    const recipes = await loadRecipes(fs, [{ dir: '/.yo-agent/agents' }]);
    expect(recipes.get('researcher')?.tools).toEqual(['read']);
  });

  it('appendMemoryLine：写虚拟 FS + 幂等查重', async () => {
    const fs = new MemoryFileSystem();
    const first = await appendMemoryLine(fs, '/', '事实一');
    expect(first.deduped).toBe(false);
    const again = await appendMemoryLine(fs, '/', '事实一');
    expect(again.deduped).toBe(true);
    expect(await fs.readTextFile('/MEMORY.md')).toContain('- 事实一');
  });
});
