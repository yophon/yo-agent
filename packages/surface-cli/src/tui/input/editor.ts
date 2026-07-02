/**
 * 多行文本编辑器(4.6b):纯函数 buffer。光标以 UTF-16 code unit 计(便于切串),
 * 但所有移动/删除按**字素簇**进行(CJK/emoji/组合符不劈开);渲染布局按显示格数
 * 软换行,光标行列由 layout() 统一计算 —— app 层只摆元素。
 */
import { cellWidth, graphemes } from './width';

export interface EditorState {
  text: string;
  /** code-unit 下标,0..text.length。 */
  cursor: number;
}

export const EMPTY: EditorState = { text: '', cursor: 0 };

export function fromText(text: string, cursor = text.length): EditorState {
  return { text, cursor: Math.max(0, Math.min(cursor, text.length)) };
}

// ── 字素边界 ─────────────────────────────────────────────────────────────
/** 光标前一个字素边界(不越过 0)。 */
function prevBoundary(text: string, i: number): number {
  if (i <= 0) return 0;
  let pos = 0;
  for (const g of graphemes(text)) {
    const next = pos + g.length;
    if (next >= i) return pos;
    pos = next;
  }
  return pos;
}

/** 光标后一个字素边界(不越过末尾)。 */
function nextBoundary(text: string, i: number): number {
  if (i >= text.length) return text.length;
  let pos = 0;
  for (const g of graphemes(text)) {
    const next = pos + g.length;
    if (pos >= i) return next;
    pos = next;
  }
  return text.length;
}

// ── 编辑操作 ─────────────────────────────────────────────────────────────
/** 归一换行(CRLF/CR → LF)、剥离除 \n\t 外的 C0 控制符(粘贴防呆)。 */
export function sanitize(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function insert(st: EditorState, raw: string): EditorState {
  const text = sanitize(raw);
  if (!text) return st;
  return {
    text: st.text.slice(0, st.cursor) + text + st.text.slice(st.cursor),
    cursor: st.cursor + text.length,
  };
}

export function newline(st: EditorState): EditorState {
  return insert(st, '\n');
}

export function backspace(st: EditorState): EditorState {
  if (st.cursor === 0) return st;
  const from = prevBoundary(st.text, st.cursor);
  return { text: st.text.slice(0, from) + st.text.slice(st.cursor), cursor: from };
}

export function deleteForward(st: EditorState): EditorState {
  if (st.cursor >= st.text.length) return st;
  const to = nextBoundary(st.text, st.cursor);
  return { text: st.text.slice(0, st.cursor) + st.text.slice(to), cursor: st.cursor };
}

export function left(st: EditorState): EditorState {
  return { ...st, cursor: prevBoundary(st.text, st.cursor) };
}

export function right(st: EditorState): EditorState {
  return { ...st, cursor: nextBoundary(st.text, st.cursor) };
}

const isSpace = (ch: string): boolean => /\s/.test(ch);

/** 词左移:先越过空白,再越过词(\n 视为空白,可跨行)。 */
export function wordLeft(st: EditorState): EditorState {
  let i = st.cursor;
  while (i > 0 && isSpace(st.text[i - 1]!)) i--;
  while (i > 0 && !isSpace(st.text[i - 1]!)) i--;
  return { ...st, cursor: i };
}

export function wordRight(st: EditorState): EditorState {
  let i = st.cursor;
  const n = st.text.length;
  while (i < n && isSpace(st.text[i]!)) i++;
  while (i < n && !isSpace(st.text[i]!)) i++;
  return { ...st, cursor: i };
}

/** Ctrl+W:删光标前一个词(含其后空白)。 */
export function deleteWordBack(st: EditorState): EditorState {
  const from = wordLeft(st).cursor;
  if (from === st.cursor) return st;
  return { text: st.text.slice(0, from) + st.text.slice(st.cursor), cursor: from };
}

// ── 行操作 ───────────────────────────────────────────────────────────────
/** 光标所在逻辑行的 [起点, 终点](终点不含 \n)。 */
function lineSpan(st: EditorState): { start: number; end: number } {
  const start = st.text.lastIndexOf('\n', st.cursor - 1) + 1;
  const nl = st.text.indexOf('\n', st.cursor);
  return { start, end: nl === -1 ? st.text.length : nl };
}

export function lineHome(st: EditorState): EditorState {
  return { ...st, cursor: lineSpan(st).start };
}

export function lineEnd(st: EditorState): EditorState {
  return { ...st, cursor: lineSpan(st).end };
}

/** Ctrl+K:删到行尾;已在行尾则删掉换行(合并下一行)。 */
export function killToLineEnd(st: EditorState): EditorState {
  const { end } = lineSpan(st);
  const to = st.cursor === end && end < st.text.length ? end + 1 : end;
  if (to === st.cursor) return st;
  return { text: st.text.slice(0, st.cursor) + st.text.slice(to), cursor: st.cursor };
}

/** 光标所在逻辑行号(0 起)与总行数。 */
export function cursorRow(st: EditorState): number {
  let row = 0;
  for (let i = 0; i < st.cursor; i++) if (st.text[i] === '\n') row++;
  return row;
}

export function rowCount(st: EditorState): number {
  let n = 1;
  for (const ch of st.text) if (ch === '\n') n++;
  return n;
}

/** 上/下移一逻辑行(保持字素列);已在首/末行返回 null(caller 转历史导航)。 */
export function up(st: EditorState): EditorState | null {
  return moveRow(st, -1);
}

export function down(st: EditorState): EditorState | null {
  return moveRow(st, 1);
}

function moveRow(st: EditorState, delta: -1 | 1): EditorState | null {
  const lines = st.text.split('\n');
  const row = cursorRow(st);
  const target = row + delta;
  if (target < 0 || target >= lines.length) return null;
  const { start } = lineSpan(st);
  const col = graphemes(st.text.slice(start, st.cursor)).length;
  let offset = 0;
  for (let i = 0; i < target; i++) offset += lines[i]!.length + 1;
  const gs = graphemes(lines[target]!);
  let units = 0;
  for (let i = 0; i < Math.min(col, gs.length); i++) units += gs[i]!.length;
  return { ...st, cursor: offset + units };
}

// ── 布局(软换行 + 光标定位)──────────────────────────────────────────────
export interface VisualLine {
  text: string;
  /** 光标是否落在本视觉行。 */
  hasCursor: boolean;
  /** 光标在本行内的 code-unit 偏移(hasCursor 时有效)。 */
  cursorUnits: number;
}

/**
 * 按显示格数把逻辑行软换行为视觉行,并标记光标位置。
 * width ≤ 0 时按 1 处理;单个超宽字素独占一行。
 */
export function layout(st: EditorState, width: number): VisualLine[] {
  const w = Math.max(1, width);
  const logical = st.text.split('\n');
  // 光标所在逻辑行与行内偏移。
  let rem = st.cursor;
  let cursorLine = 0;
  for (; cursorLine < logical.length; cursorLine++) {
    const len = logical[cursorLine]!.length;
    if (rem <= len) break;
    rem -= len + 1;
  }
  const out: VisualLine[] = [];
  for (let li = 0; li < logical.length; li++) {
    const pieces = wrapLine(logical[li]!, w);
    for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi]!;
      const isLast = pi === pieces.length - 1;
      const end = p.start + p.text.length;
      // 落点规则:片内 [start, end);行尾光标归本行最后一片;恰在折行边界归下一片(续行列 0)。
      const has =
        li === cursorLine && ((rem >= p.start && rem < end) || (isLast && rem === end));
      out.push({ text: p.text, hasCursor: has, cursorUnits: has ? rem - p.start : 0 });
    }
  }
  return out;
}

function wrapLine(line: string, width: number): Array<{ text: string; start: number }> {
  if (!line) return [{ text: '', start: 0 }];
  const pieces: Array<{ text: string; start: number }> = [];
  let cur = '';
  let curStart = 0;
  let curCells = 0;
  let pos = 0;
  for (const g of graphemes(line)) {
    const cells = cellWidth(g);
    if (curCells + cells > width && cur) {
      pieces.push({ text: cur, start: curStart });
      cur = '';
      curStart = pos;
      curCells = 0;
    }
    cur += g;
    curCells += cells;
    pos += g.length;
  }
  pieces.push({ text: cur, start: curStart });
  return pieces;
}

/** 光标行三段切分(渲染反白用):at 为光标下的字素(行尾为空格)。 */
export function splitAtCursor(line: string, units: number): { before: string; at: string; after: string } {
  const before = line.slice(0, units);
  const rest = line.slice(units);
  if (!rest) return { before, at: ' ', after: '' };
  const g = graphemes(rest)[0]!;
  return { before, at: g, after: rest.slice(g.length) };
}
