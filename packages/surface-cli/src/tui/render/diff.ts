/**
 * Diff 渲染(4.6c):行级 LCS diff(edit 工具 old/new)+ 补丁文本着色(apply_patch 信封)。
 * 输出统一 DiffLine → toStyled 转样式行(+ 绿 / - 红 / @@ 青 / 上下文 dim,带新行号,
 * 连续未变 >2*keep 行折叠为 ···)。纯函数,审批面板与工具展开体共用。
 */
import { plainLine, span, type StyledLine } from './spans';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  /** 新文件行号(add/ctx)。 */
  newNo?: number;
}

/** 行级 LCS;超大输入退化为整删整加(O(n²) DP 防爆)。 */
export function diffStrings(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text) => ({ kind: 'del', text }) as DiffLine),
      ...b.map((text, i) => ({ kind: 'add', text, newNo: i + 1 }) as DiffLine),
    ];
  }
  // LCS DP
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i]!, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j]!, newNo: j + 1 });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', text: a[i++]! });
  while (j < n) out.push({ kind: 'add', text: b[j]!, newNo: ++j });
  return out;
}

/** apply_patch 信封 / unified diff 文本 → DiffLine(按前缀着色,不重算)。 */
export function parsePatchText(patch: string): DiffLine[] {
  return patch.split('\n').map((line): DiffLine => {
    if (/^(\*\*\*|@@|---|\+\+\+|diff )/.test(line)) return { kind: 'meta', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
    return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
  });
}

export function diffStat(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === 'add') add++;
    else if (l.kind === 'del') del++;
  }
  return { add, del };
}

/** 折叠连续未变更行:变更块前后各保留 keep 行,中段折叠为 meta「··· 跳过 N 行」。 */
export function collapseContext(lines: DiffLine[], keep = 2): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (isTail: boolean): void => {
    const head = out.length === 0; // 文件开头的上下文只保留尾部 keep 行
    if (run.length <= keep * 2 || (head && run.length <= keep) || (isTail && run.length <= keep)) {
      out.push(...run);
    } else {
      const lead = head ? [] : run.slice(0, keep);
      const tail = isTail ? [] : run.slice(-keep);
      const skipped = run.length - lead.length - tail.length;
      out.push(...lead, { kind: 'meta', text: `··· 跳过 ${skipped} 行` }, ...tail);
    }
    run = [];
  };
  for (const l of lines) {
    if (l.kind === 'ctx') {
      run.push(l);
    } else {
      flush(false);
      out.push(l);
    }
  }
  flush(true);
  return out;
}

/** DiffLine → 样式行:行号(new 侧)+ 前缀符 + 着色。 */
export function toStyled(lines: DiffLine[]): StyledLine[] {
  const noWidth = String(Math.max(1, ...lines.map((l) => l.newNo ?? 0))).length;
  return lines.map((l): StyledLine => {
    if (l.kind === 'meta') return plainLine(l.text, { dim: true, color: 'cyan' });
    const no = l.newNo !== undefined ? String(l.newNo).padStart(noWidth) : ' '.repeat(noWidth);
    const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    const color = l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined;
    return [span(`${no} `, { dim: true }), span(`${mark} ${l.text}`, color ? { color } : { dim: true })];
  });
}

/** 一步到位:old/new → 折叠 + 样式行(工具展开体/审批面板)。 */
export function renderDiff(oldText: string, newText: string, keep = 2): StyledLine[] {
  return toStyled(collapseContext(diffStrings(oldText, newText), keep));
}
