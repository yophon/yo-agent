/**
 * 工具专属视图(4.6c):tool 区块 → { head, body } 两段。head 由 blocks.ts 加 ⏺ 与状态色;
 * body 为折叠尾(默认)或展开体(verbose / Ctrl+O)。未注册工具走通用视图(输出末行预览)。
 * mcp__{server}__{tool} 显示为 server:tool。纯函数。
 */
import type { Block } from '../model';
import { renderDiff, diffStat, diffStrings, parsePatchText, collapseContext, toStyled } from './diff';
import { plainLine, span, type StyledLine } from './spans';

export type ToolBlock = Extract<Block, { kind: 'tool' }>;

export interface ToolView {
  /** 如 `read(src/a.ts)`。 */
  head: string;
  body: StyledLine[];
}

interface ViewOpts {
  verbose: boolean;
}

const str = (input: unknown, field: string, fallback = ''): string => {
  const v = (input as Record<string, unknown> | null)?.[field];
  return typeof v === 'string' ? v : fallback;
};

const firstLine = (text: string, max = 60): string => {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const outputLines = (b: ToolBlock): string[] => {
  const t = b.output.replace(/\s+$/, '');
  return t ? t.split('\n') : [];
};

const tailPreview = (b: ToolBlock, n: number): StyledLine[] =>
  outputLines(b)
    .slice(-n)
    .map((l) => plainLine(l, { dim: true }));

const countLine = (n: number, unit: string): StyledLine[] => [plainLine(`${n} ${unit}`, { dim: true })];

type Renderer = (b: ToolBlock, o: ViewOpts) => ToolView;

const RENDERERS: Record<string, Renderer> = {
  read: (b) => ({
    head: `read(${str(b.input, 'path') || b.summary})`,
    body: b.status === 'ok' ? countLine(outputLines(b).length, '行') : tailPreview(b, 3),
  }),

  ls: (b, o) => listView(b, o, str(b.input, 'path', '.'), '项'),
  glob: (b, o) => listView(b, o, str(b.input, 'pattern'), '个文件'),
  grep: (b, o) => listView(b, o, `"${str(b.input, 'pattern')}"`, '处命中'),

  write: (b, o) => {
    const content = str(b.input, 'content');
    const lines = content ? content.split('\n') : [];
    const body: StyledLine[] = [plainLine(`写入 ${lines.length} 行`, { dim: true })];
    if (o.verbose) body.push(...lines.slice(0, 20).map((l) => plainLine(l, { dim: true })));
    if (o.verbose && lines.length > 20) body.push(plainLine(`··· 共 ${lines.length} 行`, { dim: true }));
    return { head: `write(${str(b.input, 'path') || b.summary})`, body };
  },

  edit: (b, o) => {
    const oldS = str(b.input, 'old_string');
    const newS = str(b.input, 'new_string');
    const { add, del } = diffStat(diffStrings(oldS, newS));
    const body = o.verbose ? renderDiff(oldS, newS) : ([[span(`+${add} `, { color: 'green' }), span(`-${del}`, { color: 'red' })]] as StyledLine[]);
    return { head: `edit(${str(b.input, 'path') || b.summary})`, body };
  },

  apply_patch: (b, o) => {
    const parsed = parsePatchText(str(b.input, 'patch'));
    const files = parsed.filter((l) => l.kind === 'meta' && /^\*\*\* (Add|Update|Delete) File/.test(l.text)).length;
    const { add, del } = diffStat(parsed);
    const body = o.verbose
      ? toStyled(collapseContext(parsed))
      : ([[span(`+${add} `, { color: 'green' }), span(`-${del}`, { color: 'red' })]] as StyledLine[]);
    return { head: `apply_patch(${files || '?'} 个文件)`, body };
  },

  bash: (b, o) => {
    const body = tailPreview(b, o.verbose ? 30 : 5);
    if (b.exitCode !== undefined && b.exitCode !== 0) body.push(plainLine(`exit ${b.exitCode}`, { color: 'red' }));
    return { head: `bash(${firstLine(str(b.input, 'command') || b.summary)})`, body };
  },

  todo_write: (b) => {
    const raw = (b.input as { todos?: unknown } | null)?.todos;
    const todos = Array.isArray(raw) ? raw : [];
    const body = todos.map((t): StyledLine => {
      const o = (t ?? {}) as Record<string, unknown>;
      const status = typeof o.status === 'string' ? o.status : 'pending';
      const mark = status === 'completed' ? '☑' : status === 'in_progress' ? '◐' : '☐';
      const text = typeof o.content === 'string' ? o.content : String(t);
      return [span(`${mark} ${text}`, status === 'in_progress' ? { bold: true } : status === 'completed' ? { dim: true } : {})];
    });
    return { head: 'todo', body };
  },

  skill_activate: (b) => ({ head: `skill(${str(b.input, 'name') || b.summary})`, body: [] }),
};

function listView(b: ToolBlock, o: ViewOpts, arg: string, unit: string): ToolView {
  const lines = outputLines(b);
  const none = lines.length === 1 && lines[0] === '(无匹配)';
  const count = none ? 0 : lines.filter((l) => !l.startsWith('[截断于')).length;
  const body: StyledLine[] = [plainLine(`${count} ${unit}`, { dim: true })];
  if (count) {
    for (const l of lines.slice(0, o.verbose ? 50 : 3)) body.push(plainLine(l, { dim: true }));
    const shown = Math.min(count, o.verbose ? 50 : 3);
    if (count > shown) body.push(plainLine(`··· 共 ${count} ${unit}`, { dim: true }));
  }
  return { head: `${b.name}(${arg})`, body };
}

/** 入口:按工具名分发;mcp__{srv}__{tool} 归一显示;未注册走通用视图。 */
export function toolView(b: ToolBlock, opts: ViewOpts): ToolView {
  const r = RENDERERS[b.name];
  if (r) return r(b, opts);
  const mcp = b.name.match(/^mcp__([^_]+(?:[_-][^_]+)*)__(.+)$/);
  const display = mcp ? `${mcp[1]}:${mcp[2]}` : b.name;
  return { head: `${display}(${firstLine(b.summary, 40)})`, body: tailPreview(b, opts.verbose ? 30 : 5) };
}
