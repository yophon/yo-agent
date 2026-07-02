import { describe, it, expect } from 'vitest';
import { md, diffRender, toolView, lineText, type ToolBlock } from '@yo-agent/surface-cli';

const texts = (lines: ReturnType<typeof md.renderMarkdown>): string[] => lines.map(lineText);

describe('markdown 渲染', () => {
  it('标题加粗(1-2 级带下划线),行内样式解析', () => {
    const [h1] = md.renderMarkdown('# 标题');
    expect(lineText(h1!)).toBe('标题');
    expect(h1![0]).toMatchObject({ bold: true, underline: true });
    const [h3] = md.renderMarkdown('### 小标题');
    expect(h3![0]).toMatchObject({ bold: true });
    expect(h3![0]!.underline).toBeFalsy();

    const [line] = md.renderMarkdown('有 **粗** 和 `code` 与 *斜*');
    expect(lineText(line!)).toBe('有 粗 和 code 与 斜');
    const spans = line!;
    expect(spans.find((s) => s.text === '粗')).toMatchObject({ bold: true });
    expect(spans.find((s) => s.text === 'code')).toMatchObject({ color: 'cyan' });
    expect(spans.find((s) => s.text === '斜')).toMatchObject({ italic: true });
  });

  it('围栏代码块:边框 + 语言标签 + 内容青色;流式未闭合兜底', () => {
    const lines = md.renderMarkdown('```ts\nconst a = 1;\n```');
    expect(texts(lines)).toEqual(['╭─ ts', '│ const a = 1;', '╰─']);
    expect(lines[1]![1]).toMatchObject({ color: 'cyan' });
    // 未闭合(流式中)也补 ╰─
    expect(texts(md.renderMarkdown('```\nx'))).toEqual(['╭─', '│ x', '╰─']);
  });

  it('列表 / 引用 / 分隔线 / 链接', () => {
    expect(texts(md.renderMarkdown('- a\n  - b\n1. c'))).toEqual(['• a', '  • b', '1. c']);
    const [q] = md.renderMarkdown('> 引用');
    expect(lineText(q!)).toBe('│ 引用');
    const [hr] = md.renderMarkdown('---');
    expect(lineText(hr!)).toMatch(/^─+$/);
    const [link] = md.renderMarkdown('[文档](https://x.dev)');
    expect(lineText(link!)).toBe('文档 (https://x.dev)');
  });

  it('表格:按显示宽度对齐(含 CJK),表头加粗 + 分隔', () => {
    const lines = md.renderMarkdown('| 名 | value |\n|---|---|\n| 中文 | 1 |');
    const t = texts(lines);
    expect(t[0]).toBe('名    value');
    expect(t[1]).toMatch(/^─+ {2}─+$/);
    expect(t[2]).toBe('中文  1    ');
    expect(lines[0]![0]).toMatchObject({ bold: true });
  });
});

describe('diff 渲染', () => {
  it('diffStrings:LCS 行级 diff + diffStat', () => {
    const d = diffRender.diffStrings('a\nb\nc', 'a\nB\nc');
    expect(d).toEqual([
      { kind: 'ctx', text: 'a', newNo: 1 },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B', newNo: 2 },
      { kind: 'ctx', text: 'c', newNo: 3 },
    ]);
    expect(diffRender.diffStat(d)).toEqual({ add: 1, del: 1 });
  });

  it('collapseContext:长上下文折叠为「跳过 N 行」', () => {
    const ctx = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'ctx', text: `l${i}`, newNo: i + 1 }) as const);
    const lines = [...ctx(10), { kind: 'del' as const, text: 'x' }];
    const out = diffRender.collapseContext(lines, 2);
    const meta = out.find((l) => l.kind === 'meta');
    expect(meta?.text).toContain('跳过 8 行');
    expect(out.at(-1)).toMatchObject({ kind: 'del' });
  });

  it('toStyled:着色 + 新侧行号;parsePatchText 识别信封', () => {
    const styled = diffRender.toStyled([
      { kind: 'add', text: 'new', newNo: 3 },
      { kind: 'del', text: 'old' },
    ]);
    expect(lineText(styled[0]!)).toBe('3 + new');
    expect(styled[0]![1]).toMatchObject({ color: 'green' });
    expect(lineText(styled[1]!)).toBe('  - old');
    expect(styled[1]![1]).toMatchObject({ color: 'red' });

    const parsed = diffRender.parsePatchText('*** Update File: a.ts\n+x\n-y\n z');
    expect(parsed.map((l) => l.kind)).toEqual(['meta', 'add', 'del', 'ctx']);
  });
});

describe('工具视图', () => {
  const tool = (over: Partial<ToolBlock>): ToolBlock => ({
    kind: 'tool',
    id: 'c1',
    name: 'read',
    summary: '',
    input: {},
    output: '',
    ...over,
  });

  it('read:行数尾;bash:命令头 + 末行预览 + 非零退出码', () => {
    const r = toolView(tool({ name: 'read', input: { path: 'a.ts' }, output: 'x\ny\nz\n', status: 'ok' }), { verbose: false });
    expect(r.head).toBe('read(a.ts)');
    expect(lineText(r.body[0]!)).toBe('3 行');

    const b = toolView(
      tool({ name: 'bash', input: { command: 'pnpm test\n第二行' }, output: 'ok\nfail', exitCode: 1, status: 'error' }),
      { verbose: false },
    );
    expect(b.head).toBe('bash(pnpm test)');
    expect(lineText(b.body.at(-1)!)).toBe('exit 1');
  });

  it('edit:折叠 +n -m,verbose 展开彩色 diff', () => {
    const blk = tool({ name: 'edit', input: { path: 'a.ts', old_string: 'a\nb', new_string: 'a\nc' } });
    const folded = toolView(blk, { verbose: false });
    expect(folded.head).toBe('edit(a.ts)');
    expect(lineText(folded.body[0]!)).toBe('+1 -1');
    const expanded = toolView(blk, { verbose: true });
    expect(expanded.body.length).toBeGreaterThan(1);
    expect(expanded.body.some((l) => lineText(l).includes('+ c'))).toBe(true);
  });

  it('grep:命中数 + 截断说明;mcp 工具名归一显示', () => {
    const g = toolView(
      tool({ name: 'grep', input: { pattern: 'foo' }, output: 'a:1:x\nb:2:y\nc:3:z\nd:4:w', status: 'ok' }),
      { verbose: false },
    );
    expect(g.head).toBe('grep("foo")');
    expect(lineText(g.body[0]!)).toBe('4 处命中');
    expect(lineText(g.body.at(-1)!)).toContain('共 4 处命中');

    const m = toolView(tool({ name: 'mcp__github__list_prs', summary: 'org/repo' }), { verbose: false });
    expect(m.head).toBe('github:list_prs(org/repo)');
  });

  it('todo_write:☐◐☑ 清单', () => {
    const t = toolView(
      tool({
        name: 'todo_write',
        input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }] },
      }),
      { verbose: false },
    );
    expect(t.body.map(lineText)).toEqual(['☑ A', '◐ B', '☐ C']);
  });
});
