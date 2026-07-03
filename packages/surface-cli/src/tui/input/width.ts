/**
 * 终端显示宽度(4.6b):按字素簇度量单元格数,CJK/emoji 占 2 格、零宽符 0 格。
 * 不引 string-width 依赖:覆盖 East Asian Wide/Fullwidth + emoji 主区段即可满足 TUI 光标定位。
 */

let segmenter: Intl.Segmenter | null = null;
function seg(): Intl.Segmenter {
  // biome-ignore lint/suspicious/noAssignInExpressions: 惰性单例初始化惯用法
  return (segmenter ??= new Intl.Segmenter());
}

/** 字符串 → 字素簇数组。 */
export function graphemes(text: string): string[] {
  if (!text) return [];
  return Array.from(seg().segment(text), (s) => s.segment);
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首/汉字/假名/注音…
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji 主区
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展
  );
}

function isZero(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // 组合附加符
    (cp >= 0x200b && cp <= 0x200f) || // 零宽空格/连接符/方向标记
    cp === 0xfe0f || // VS16
    cp === 0xfe0e ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) // 肤色修饰
  );
}

/** 单个字素簇的显示格数(0/1/2)。 */
export function cellWidth(grapheme: string): number {
  let width = 0;
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0)!;
    if (isZero(cp)) continue;
    width = Math.max(width, isWide(cp) ? 2 : 1);
  }
  return width;
}

/** 字符串总显示格数。 */
export function strWidth(text: string): number {
  let w = 0;
  for (const g of graphemes(text)) w += cellWidth(g);
  return w;
}
