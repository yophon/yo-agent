/**
 * 样式片段(4.6c):markdown/diff/工具视图的公共输出形态。
 * 纯数据 → blocks.ts 统一转 ink <Text>,渲染器全程可离线单测。
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  inverse?: boolean;
  /** ink 颜色名。 */
  color?: string;
}

/** 一行 = 若干样式片段。 */
export type StyledLine = Span[];

export function span(text: string, style: Omit<Span, 'text'> = {}): Span {
  return { text, ...style };
}

export function plainLine(text: string, style: Omit<Span, 'text'> = {}): StyledLine {
  return [span(text, style)];
}

/** 全部片段拼为纯文本(测试断言用)。 */
export function lineText(line: StyledLine): string {
  return line.map((s) => s.text).join('');
}
