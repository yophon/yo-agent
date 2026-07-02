/**
 * 输入解码器(4.7b):useInput 的 raw chunk → 语义输入事件序列,纯状态机可离线穷举测试。
 * 收编此前散在 app.ts useInput 里的内联特判:
 *   ⓪ 括号粘贴拦截(吸收 4.6b input/paste.ts 的 PasteTracker)
 *   ① pty 合并 chunk 切段(「文本+回车」合并到达时按换行切段,段间视为 Enter)
 *   其余透传 `key` 事件,由 keymap.routeKey 继续路由。
 *
 * 对 ink 5 parse-keypress 私有行为的依赖全部收拢在本文件(4.6b 实测事实):
 * - ink 剥掉 chunk 的首个 ESC:粘贴开始标记以 `[200~`(或未剥的 `\x1b[200~`)形态到达;
 *   结束标记单独成 chunk 时为 `[201~`,混在内容里则保留 `\x1b[201~`(ink 只剥首 ESC)。
 * - 单独的 \r/\t 被解析成 key.return/key.tab 且 input 为空:粘贴态下需还原字面量。
 * - Alt+Enter → ch='\r' 且 key.return=false;Ctrl+J → ch='\n'(键位语义在 keymap,不在本层)。
 *
 * 相对 4.6b 的两处行为修正:开始标记前的普通前缀、结束标记后的余量不再丢弃,
 * 而是继续按普通输入解码(余量可含下一个开始标记)。
 */
import type { KeyLike } from '../keymap';

const START = '[200~';
const START_RAW = '\x1b[200~';
const END = '\x1b[201~';
const END_STRIPPED = '[201~'; // 结束标记单独成 chunk 时被 ink 剥掉 ESC 的形态

export type InputEvent =
  /** 完整括号粘贴全文(未 sanitize/未折叠,由调用方处理)。 */
  | { kind: 'paste'; text: string }
  /** pty 合并 chunk 的文本段(不含换行)。 */
  | { kind: 'text'; text: string }
  /** pty 合并 chunk 的段间回车(语义 = 提交)。 */
  | { kind: 'enter' }
  /** 透传给 keymap.routeKey 的原始按键。 */
  | { kind: 'key'; ch: string; key: KeyLike };

export class InputDecoder {
  /** 粘贴累积缓冲(null = 非粘贴态)。 */
  private buf: string | null = null;

  get pasting(): boolean {
    return this.buf !== null;
  }

  /** 一次 useInput 回调喂一 chunk;返回零或多个语义事件(粘贴累积中返回 [])。 */
  feed(raw: string, key: KeyLike = {}): InputEvent[] {
    if (this.buf !== null) {
      // 粘贴态:ink 把单独的 \r/\t 解析成标志且 input 清空,需还原字面量累积。
      let text = raw;
      if (!text && key.return) text = '\r';
      if (!text && key.tab) text = '\t';
      return this.consume(text);
    }
    const idx = indexOfStart(raw);
    if (idx !== -1) {
      const out: InputEvent[] = [];
      const prefix = raw.slice(0, idx);
      if (prefix) out.push(...this.plain(prefix, {}));
      const rest = raw.slice(idx).replace(START_RAW, '').replace(START, '');
      this.buf = '';
      out.push(...this.consume(rest));
      return out;
    }
    return this.plain(raw, key);
  }

  /** 粘贴态累积;遇结束标记产出全文,标记后的余量继续走普通解码。 */
  private consume(text: string): InputEvent[] {
    const end = earliestEnd(text);
    if (end === null) {
      this.buf! += text;
      return [];
    }
    const content = this.buf! + text.slice(0, end.pos);
    this.buf = null;
    const out: InputEvent[] = [{ kind: 'paste', text: content }];
    const rest = text.slice(end.pos + end.len);
    if (rest) out.push(...this.feed(rest, {}));
    return out;
  }

  /** 非粘贴输入:pty 合并 chunk(多字符含换行且非单纯回车键)切段,否则透传。 */
  private plain(raw: string, key: KeyLike): InputEvent[] {
    if (!key.return && raw.length > 1 && /[\r\n]/.test(raw)) {
      const parts = raw.split(/\r\n|\r|\n/);
      const out: InputEvent[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) out.push({ kind: 'text', text: parts[i]! });
        if (i < parts.length - 1) out.push({ kind: 'enter' });
      }
      return out;
    }
    return [{ kind: 'key', ch: raw, key }];
  }
}

function indexOfStart(text: string): number {
  const a = text.indexOf(START_RAW);
  const b = text.indexOf(START);
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function earliestEnd(text: string): { pos: number; len: number } | null {
  const a = text.indexOf(END);
  // 剥 ESC 形态只在 chunk 开头出现(ink 只剥首 ESC)。
  const b = text.startsWith(END_STRIPPED) ? 0 : -1;
  if (a === -1 && b === -1) return null;
  if (b !== -1 && (a === -1 || b < a)) return { pos: b, len: END_STRIPPED.length };
  return { pos: a, len: END.length };
}
