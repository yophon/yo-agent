import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConventionFiles,
  dirChain,
  expandImports,
  capMemoryIndex,
  safeTruncateBytes,
  parseRememberDirective,
  appendMemoryLine,
  memoryKeyFor,
  findWorkspaceRoot,
} from '@yo-agent/kernel';

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

describe('3E — auto-memory workspace 隔离（MEMORY.md）', () => {
  it('MEMORY.md 仅从 workspaceRoot 读：A 的记忆在 B 不可见', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-mem-'));
    try {
      const wsA = join(base, 'a');
      const wsB = join(base, 'b');
      await mkdir(wsA, { recursive: true });
      await mkdir(wsB, { recursive: true });
      await writeFile(join(wsA, 'MEMORY.md'), 'A-MEMORY-FACT');
      await writeFile(join(wsB, 'MEMORY.md'), 'B-MEMORY-FACT');
      const aOut = await loadConventionFiles(wsA, { workspaceRoot: wsA });
      const bOut = await loadConventionFiles(wsB, { workspaceRoot: wsB });
      expect(aOut).toContain('A-MEMORY-FACT');
      expect(aOut).not.toContain('B-MEMORY-FACT');
      expect(bOut).toContain('B-MEMORY-FACT');
      expect(bOut).not.toContain('A-MEMORY-FACT');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('不传 workspaceRoot → 不加载 MEMORY.md（向后兼容）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-mem-'));
    try {
      await writeFile(join(base, 'MEMORY.md'), 'NAKED-MEM');
      expect(await loadConventionFiles(base)).not.toContain('NAKED-MEM');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('MEMORY.md 不沿 dirChain 上溯：父目录 MEMORY.md 不泄漏到子 workspace', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-mem-'));
    try {
      const child = join(base, 'repo');
      await mkdir(child, { recursive: true });
      await writeFile(join(base, 'MEMORY.md'), 'PARENT-MEM');
      await writeFile(join(child, 'MEMORY.md'), 'CHILD-MEM');
      const out = await loadConventionFiles(child, { workspaceRoot: child });
      expect(out).toContain('CHILD-MEM');
      expect(out).not.toContain('PARENT-MEM');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('3E — @import 展开（expandImports）', () => {
  it('展开 @相对路径（相对引用文件位置，非 cwd）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-imp-'));
    try {
      const sub = join(base, 'sub');
      await mkdir(sub, { recursive: true });
      await writeFile(join(sub, 'b.md'), 'B sees @c.md'); // 相对 sub/
      await writeFile(join(sub, 'c.md'), 'C-CONTENT');
      await writeFile(join(base, 'a.md'), 'A imports @sub/b.md');
      const out = await expandImports('@a.md', base, base);
      expect(out).toContain('C-CONTENT'); // a→sub/b→sub/c 各自相对解析
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('拒越界：@../secret.md 落在 workspace 外被拒，内容不内联', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-imp-'));
    try {
      const ws = join(base, 'ws');
      await mkdir(ws, { recursive: true });
      await writeFile(join(base, 'secret.md'), 'SECRET-CONTENT'); // ws 之外
      const out = await expandImports('@../secret.md', ws, ws);
      expect(out).not.toContain('SECRET-CONTENT');
      expect(out).toContain('越界');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('防循环：A↔B 互导不死循环（visited 拦）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-imp-'));
    try {
      await writeFile(join(base, 'a.md'), 'A @b.md');
      await writeFile(join(base, 'b.md'), 'B @a.md');
      const out = await expandImports('@a.md', base, base);
      expect(out).toContain('循环');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('深度上限兜底：超过 maxDepth 注入占位、不内联深层内容', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-imp-'));
    try {
      await writeFile(join(base, 'd0.md'), '@d1.md');
      await writeFile(join(base, 'd1.md'), '@d2.md');
      await writeFile(join(base, 'd2.md'), '@d3.md');
      await writeFile(join(base, 'd3.md'), 'DEEP-CONTENT');
      const out = await expandImports('@d0.md', base, base, 2);
      expect(out).toContain('超过最大深度');
      expect(out).not.toContain('DEEP-CONTENT');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('缺失目标 → 占位标记，不抛错', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-imp-'));
    try {
      const out = await expandImports('see @nope.md done', base, base);
      expect(out).toContain('未找到');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('字节预算兜底：超大 @import 被截断、不无限内联（审查 M1 DoS）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-imp-'));
    try {
      // 写一个 > 256KB 预算的大文件，确保被截断标记。
      await writeFile(join(base, 'huge.md'), 'X'.repeat(300 * 1024));
      const out = await expandImports('@huge.md', base, base);
      expect(out).toContain('超出展开预算');
      expect(out.length).toBeLessThan(300 * 1024); // 未全量内联
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('3E — 截断安全（capMemoryIndex / safeTruncateBytes）', () => {
  it('capMemoryIndex 截前 200 行', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
    const capped = capMemoryIndex(text);
    expect(capped.split('\n').length).toBeLessThanOrEqual(200);
    expect(capped).toContain('line0');
    expect(capped).not.toContain('line300');
  });

  it('safeTruncateBytes 不切断多字节 UTF-8 字符（round-trip 无损）', () => {
    const text = '你好世界'.repeat(100); // 每字 3 字节
    const out = safeTruncateBytes(text, 10);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(10);
    expect(out).toBe(Buffer.from(out, 'utf8').toString('utf8')); // 无半个码点
    expect([...out].every((ch) => '你好世界'.includes(ch))).toBe(true);
  });

  it('safeTruncateBytes 回退到空白边界，不切断标识符 token', () => {
    const out = safeTruncateBytes('aaa bbb ccc-ddd-eee', 9);
    expect(out).toBe('aaa bbb');
    expect(out.endsWith('-')).toBe(false);
  });
});

describe('3E — 手动 #remember 落盘主路', () => {
  it('parseRememberDirective 解析 #remember 指令，非指令 → null', () => {
    expect(parseRememberDirective('#remember 用户偏好中文')).toEqual({ content: '用户偏好中文' });
    expect(parseRememberDirective('  #remember   有前后空白  ')).toEqual({ content: '有前后空白' });
    expect(parseRememberDirective('普通提问')).toBeNull();
    expect(parseRememberDirective('#remember')).toBeNull(); // 无内容
    expect(parseRememberDirective('请 #remember 这不是指令前缀')).toBeNull(); // 非行首
  });

  it('appendMemoryLine 落盘 MEMORY.md，可被 loadConventionFiles 读回', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-rem-'));
    try {
      await appendMemoryLine(base, '事实一');
      await appendMemoryLine(base, '事实二\n含换行');
      const out = await loadConventionFiles(base, { workspaceRoot: base });
      expect(out).toContain('事实一');
      expect(out).toContain('事实二 含换行'); // 换行被压平为单行条目
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('appendMemoryLine 幂等（4.9e）：重复写同内容不堆行，deduped=true；再写新内容照常追加读回', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-dedupe-'));
    try {
      const first = await appendMemoryLine(base, '同一条事实');
      expect(first.deduped).toBe(false);
      const again = await appendMemoryLine(base, '同一条事实');
      expect(again).toEqual({ line: '- 同一条事实', deduped: true });
      await appendMemoryLine(base, '另一条');
      const out = await loadConventionFiles(base, { workspaceRoot: base });
      expect(out.split('- 同一条事实').length - 1).toBe(1); // 不重复堆行
      expect(out).toContain('- 另一条'); // 下会话读回（loadConventionFiles 即会话加载路）
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('memoryKeyFor 幂等：同内容同键、不同内容不同键', () => {
    expect(memoryKeyFor('abc')).toBe(memoryKeyFor('abc'));
    expect(memoryKeyFor('abc')).not.toBe(memoryKeyFor('abd'));
    expect(memoryKeyFor('x')).toMatch(/^m_/);
  });

  it('findWorkspaceRoot 命中含 .git 的最近祖先', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yo-ws-'));
    try {
      const repo = join(base, 'repo');
      const deep = join(repo, 'a', 'b');
      await mkdir(deep, { recursive: true });
      await mkdir(join(repo, '.git'), { recursive: true });
      expect(findWorkspaceRoot(deep)).toBe(repo); // 上溯到 .git 所在目录
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
