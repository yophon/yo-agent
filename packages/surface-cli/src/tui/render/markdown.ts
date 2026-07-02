/**
 * 轻量 Markdown 渲染(4.6c):md 文本 → 样式行,零新依赖、纯函数。
 * 支持:标题 / 加粗 / 斜体 / 行内代码 / 围栏代码块(语言标签)/ 无序·有序列表 /
 * 引用 / 分隔线 / 简单表格 / 链接。不做语法高亮与重排版(终端由 ink 自动软换行)。
 * 流式期间对未闭合围栏按代码块渲染,闭合后不回改(<Static> 不可回写的固有取舍)。
 */
import { strWidth } from '../input/width';
import { plainLine, span, type Span, type StyledLine } from './spans';

const CODE_COLOR = 'cyan';

export function renderMarkdown(md: string, width = 80): StyledLine[] {
  const out: StyledLine[] = [];
  const lines = md.split('\n');
  let inFence = false;
  let fenceLang = '';
  let table: string[] = [];

  const flushTable = (): void => {
    if (table.length) {
      out.push(...renderTable(table));
      table = [];
    }
  };

  for (const raw of lines) {
    // 围栏代码块
    const fence = raw.match(/^\s*(```|~~~)\s*(\S*)\s*$/);
    if (fence) {
      flushTable();
      if (!inFence) {
        inFence = true;
        fenceLang = fence[2] ?? '';
        out.push(plainLine(fenceLang ? `╭─ ${fenceLang}` : '╭─', { dim: true }));
      } else {
        inFence = false;
        out.push(plainLine('╰─', { dim: true }));
      }
      continue;
    }
    if (inFence) {
      out.push([span('│ ', { dim: true }), span(raw, { color: CODE_COLOR })]);
      continue;
    }

    // 表格行缓冲(| 开头);离开表格区随即冲刷。
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      table.push(raw.trim());
      continue;
    }
    flushTable();

    // 标题
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(inline(heading[2]!).map((s) => ({ ...s, bold: true, underline: level <= 2 })));
      continue;
    }
    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw)) {
      out.push(plainLine('─'.repeat(Math.max(4, Math.min(width, 40))), { dim: true }));
      continue;
    }
    // 引用
    const quote = raw.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push([span('│ ', { dim: true }), ...inline(quote[1]!).map((s) => ({ ...s, dim: true }))]);
      continue;
    }
    // 无序列表(保留缩进层级)
    const ul = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      out.push([span(`${ul[1]!}• `), ...inline(ul[2]!)]);
      continue;
    }
    // 有序列表
    const ol = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) {
      out.push([span(`${ol[1]!}${ol[2]!}. `), ...inline(ol[3]!)]);
      continue;
    }
    out.push(inline(raw));
  }
  flushTable();
  if (inFence) out.push(plainLine('╰─', { dim: true })); // 流式未闭合兜底
  return out;
}

// ── 行内样式 ─────────────────────────────────────────────────────────────
/** 优先级:code(反引号)> 加粗(双星)> 斜体(单星/下划线)> 链接。 */
export function inline(text: string): StyledLine {
  const spans: Span[] = [];
  // 单遍扫描:按最早命中的标记切分。
  let rest = text;
  const patterns: Array<{ re: RegExp; make: (m: RegExpMatchArray) => Span[] }> = [
    { re: /`([^`]+)`/, make: (m) => [span(m[1]!, { color: CODE_COLOR })] },
    { re: /\*\*([^*]+)\*\*/, make: (m) => [span(m[1]!, { bold: true })] },
    { re: /\*([^*]+)\*/, make: (m) => [span(m[1]!, { italic: true })] },
    { re: /(?<![\w`])_([^_]+)_(?![\w`])/, make: (m) => [span(m[1]!, { italic: true })] },
    {
      re: /\[([^\]]+)\]\(([^)]+)\)/,
      make: (m) => [span(m[1]!, { underline: true }), span(` (${m[2]!})`, { dim: true })],
    },
  ];
  while (rest) {
    let earliest: { idx: number; match: RegExpMatchArray; make: (m: RegExpMatchArray) => Span[] } | null = null;
    for (const p of patterns) {
      const m = rest.match(p.re);
      if (m && m.index !== undefined && (earliest === null || m.index < earliest.idx)) {
        earliest = { idx: m.index, match: m, make: p.make };
      }
    }
    if (!earliest) {
      spans.push(span(rest));
      break;
    }
    if (earliest.idx > 0) spans.push(span(rest.slice(0, earliest.idx)));
    spans.push(...earliest.make(earliest.match));
    rest = rest.slice(earliest.idx + earliest.match[0]!.length);
  }
  return spans.length ? spans : [span('')];
}

// ── 表格 ─────────────────────────────────────────────────────────────────
function renderTable(rows: string[]): StyledLine[] {
  const parse = (r: string): string[] =>
    r
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const isSep = (r: string): boolean => /^\|?\s*:?-{2,}.*$/.test(r) && !/[^|:\s-]/.test(r);
  const cells = rows.filter((r) => !isSep(r)).map(parse);
  if (!cells.length) return [];
  const cols = Math.max(...cells.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...cells.map((r) => strWidth(r[i] ?? ''))));
  const pad = (text: string, w: number): string => text + ' '.repeat(Math.max(0, w - strWidth(text)));
  const out: StyledLine[] = [];
  const hasHeader = rows.length > 1 && isSep(rows[1]!);
  cells.forEach((r, ri) => {
    const line: Span[] = [];
    for (let i = 0; i < cols; i++) {
      line.push(span(pad(r[i] ?? '', widths[i]!), hasHeader && ri === 0 ? { bold: true } : {}));
      if (i < cols - 1) line.push(span('  ', { dim: true }));
    }
    out.push(line);
    if (hasHeader && ri === 0) {
      out.push(plainLine(widths.map((w) => '─'.repeat(w)).join('  '), { dim: true }));
    }
  });
  return out;
}
