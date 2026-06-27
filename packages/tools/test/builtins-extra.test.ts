import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editTool, grepTool, globTool, todoWriteTool, applyPatchTool } from '@yo-agent/tools';
import type { ToolContext, ToolEvent } from '@yo-agent/tools';

async function collect(stream: AsyncIterable<ToolEvent>): Promise<string> {
  let s = '';
  for await (const e of stream) if (e.kind === 'output') s += e.chunk;
  return s;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yo-extra-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const ctx = (): ToolContext => ({ sessionId: 's', cwd: dir });

describe('4B — edit 工具', () => {
  it('唯一命中替换', async () => {
    await writeFile(join(dir, 'a.txt'), 'foo bar baz');
    await collect(editTool.executor.execute({ path: 'a.txt', old_string: 'bar', new_string: 'BAR' }, ctx()));
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('foo BAR baz');
  });

  it('多处命中且无 replace_all → 抛错（防误改）', async () => {
    await writeFile(join(dir, 'a.txt'), 'x x x');
    await expect(collect(editTool.executor.execute({ path: 'a.txt', old_string: 'x', new_string: 'y' }, ctx()))).rejects.toThrow(/命中 3 处/);
  });

  it('replace_all 全替换', async () => {
    await writeFile(join(dir, 'a.txt'), 'x x x');
    await collect(editTool.executor.execute({ path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx()));
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('y y y');
  });

  it('替换串含 $ 特殊模式按字面处理（不解释 $&）', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello');
    await collect(editTool.executor.execute({ path: 'a.txt', old_string: 'hello', new_string: '$& and $1' }, ctx()));
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('$& and $1');
  });

  it('未找到 → 抛错；越界路径 → 抛错', async () => {
    await writeFile(join(dir, 'a.txt'), 'abc');
    await expect(collect(editTool.executor.execute({ path: 'a.txt', old_string: 'zzz', new_string: 'y' }, ctx()))).rejects.toThrow(/未找到/);
    await expect(collect(editTool.executor.execute({ path: '../escape.txt', old_string: 'a', new_string: 'b' }, ctx()))).rejects.toThrow(/越界/);
  });
});

describe('4B — grep 工具', () => {
  it('递归正则搜索 → file:line:text；跳过 node_modules', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'const x = 1;\nTODO: fix\nconst y = 2;');
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'b.ts'), 'TODO: ignored');
    const out = await collect(grepTool.executor.execute({ pattern: 'TODO' }, ctx()));
    expect(out).toContain('src/a.ts:2:TODO: fix');
    expect(out).not.toContain('node_modules'); // 跳过依赖目录
  });

  it('无匹配 → (无匹配)；无效正则 → 抛错；越界 → 抛错', async () => {
    await writeFile(join(dir, 'a.txt'), 'abc');
    expect(await collect(grepTool.executor.execute({ pattern: 'zzz' }, ctx()))).toBe('(无匹配)');
    await expect(collect(grepTool.executor.execute({ pattern: '[' }, ctx()))).rejects.toThrow(/无效正则/);
    await expect(collect(grepTool.executor.execute({ pattern: 'a', path: '../' }, ctx()))).rejects.toThrow(/越界/);
  });
});

describe('4B — glob 工具', () => {
  it('**/*.ts 递归匹配；* 仅段内', async () => {
    await mkdir(join(dir, 'src', 'sub'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), '');
    await writeFile(join(dir, 'src', 'sub', 'b.ts'), '');
    await writeFile(join(dir, 'src', 'c.js'), '');
    const tsAll = (await collect(globTool.executor.execute({ pattern: '**/*.ts' }, ctx()))).split('\n').sort();
    expect(tsAll).toEqual(['src/a.ts', 'src/sub/b.ts']);
    // 顶层 * 不跨目录
    const top = await collect(globTool.executor.execute({ pattern: '*.ts' }, ctx()));
    expect(top).toBe('(无匹配)');
  });
});

describe('4B — todo_write 工具', () => {
  it('格式化清单（状态标记）；approval=never', async () => {
    expect(todoWriteTool.descriptor.approval).toBe('never');
    const out = await collect(
      todoWriteTool.executor.execute({ todos: [{ content: '做 A', status: 'completed' }, { content: '做 B', status: 'in_progress' }, { content: '做 C' }] }, ctx()),
    );
    expect(out).toBe('[x] 做 A\n[~] 做 B\n[ ] 做 C');
  });
});

describe('4B — apply_patch 工具', () => {
  it('Add / Update（带上下文）/ Delete 三操作', async () => {
    await writeFile(join(dir, 'upd.txt'), 'line1\nline2\nline3');
    await writeFile(join(dir, 'del.txt'), 'bye');
    const patch = [
      '*** Begin Patch',
      '*** Add File: new/created.txt',
      '+hello',
      '+world',
      '*** Update File: upd.txt',
      '@@',
      ' line1',
      '-line2',
      '+line2-modified',
      ' line3',
      '*** Delete File: del.txt',
      '*** End Patch',
    ].join('\n');
    const out = await collect(applyPatchTool.executor.execute({ patch }, ctx()));
    expect(out).toContain('A new/created.txt');
    expect(out).toContain('M upd.txt');
    expect(out).toContain('D del.txt');
    expect(await readFile(join(dir, 'new', 'created.txt'), 'utf8')).toBe('hello\nworld');
    expect(await readFile(join(dir, 'upd.txt'), 'utf8')).toBe('line1\nline2-modified\nline3');
    await expect(readFile(join(dir, 'del.txt'), 'utf8')).rejects.toThrow();
  });

  it('上下文未匹配 → 抛错；空补丁 → 抛错；越界 Add → 抛错', async () => {
    await writeFile(join(dir, 'f.txt'), 'real content');
    const bad = ['*** Update File: f.txt', '@@', ' nonexistent-context', '-x', '+y'].join('\n');
    await expect(collect(applyPatchTool.executor.execute({ patch: bad }, ctx()))).rejects.toThrow(/未匹配/);
    await expect(collect(applyPatchTool.executor.execute({ patch: 'no envelope here' }, ctx()))).rejects.toThrow(/未解析到任何操作/);
    await expect(
      collect(applyPatchTool.executor.execute({ patch: '*** Add File: ../escape.txt\n+x' }, ctx())),
    ).rejects.toThrow(/越界/);
  });
});
