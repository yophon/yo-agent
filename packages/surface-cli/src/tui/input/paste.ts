/**
 * 括号粘贴(4.6b):TUI 启动时开 `\x1b[?2004h`,终端把粘贴包成 `ESC[200~ … ESC[201~`。
 * ink 的 parseKeypress 会剥掉首个 ESC,标记以 `[200~` / `[201~`(或残留 `\x1b[201~`)形态
 * 到达 useInput;大粘贴可能拆多个 chunk。本状态机在 keymap 之前拦截:开始标记 → 进入
 * 粘贴态累积(期间回车/Tab 等一律当字面量),结束标记 → 一次性产出全文。
 *
 * 另:>FOLD_LINES 行的粘贴折叠为 `[粘贴 #n · N 行]` 占位符,提交时展开(输入框防爆屏)。
 */

const START = '[200~';
const START_RAW = '\x1b[200~';
const END = '\x1b[201~';
const END_STRIPPED = '[201~'; // 结束标记单独成 chunk 时被 ink 剥掉 ESC 的形态

export interface PasteFeed {
  /** 本次 feed 完成的粘贴全文(未完成为 null)。 */
  done: string | null;
  /** 是否消费了本次输入(true → app 不再走 keymap)。 */
  consumed: boolean;
}

/** 括号粘贴累积器。非粘贴态时对不含标记的输入不消费。 */
export class PasteTracker {
  private buf: string | null = null;

  get active(): boolean {
    return this.buf !== null;
  }

  /**
   * raw:useInput 收到的 input 串(可能已被 ink 剥掉首 ESC)。
   * keyReturn/keyTab:ink 把 \r/\t 解析成标志时 input 为空,粘贴态下需还原字面量。
   */
  feed(raw: string, opts: { keyReturn?: boolean; keyTab?: boolean } = {}): PasteFeed {
    let text = raw;
    if (!text && opts.keyReturn) text = '\r';
    if (!text && opts.keyTab) text = '\t';

    if (!this.active) {
      const idx = indexOfStart(text);
      if (idx === -1) return { done: null, consumed: false };
      const rest = text.slice(idx).replace(START_RAW, '').replace(START, '');
      this.buf = '';
      return this.append(rest);
    }
    return this.append(text);
  }

  private append(text: string): PasteFeed {
    const endIdx = earliestEnd(text);
    if (endIdx === -1) {
      this.buf! += text;
      return { done: null, consumed: true };
    }
    const content = this.buf! + text.slice(0, endIdx.pos);
    this.buf = null;
    return { done: content, consumed: true };
  }
}

function indexOfStart(text: string): number {
  const a = text.indexOf(START_RAW);
  const b = text.indexOf(START);
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function earliestEnd(text: string): { pos: number } | -1 {
  const a = text.indexOf(END);
  // 剥 ESC 形态只在 chunk 开头出现(ink 只剥首 ESC)。
  const b = text.startsWith(END_STRIPPED) ? 0 : -1;
  if (a === -1 && b === -1) return -1;
  const pos = a === -1 ? b : b === -1 ? a : Math.min(a, b);
  return { pos };
}

// ── 大粘贴折叠 ───────────────────────────────────────────────────────────
export const FOLD_LINES = 10;

export interface PasteStore {
  /** 占位符 → 原文。 */
  readonly entries: Map<string, string>;
  nextId: number;
}

export function newPasteStore(): PasteStore {
  return { entries: new Map(), nextId: 1 };
}

/** 需要折叠则登记并返回占位符,否则原样返回。 */
export function foldPaste(store: PasteStore, text: string): string {
  const lines = text.split('\n').length;
  if (lines <= FOLD_LINES) return text;
  const token = `[粘贴 #${store.nextId} · ${lines} 行]`;
  store.entries.set(token, text);
  store.nextId += 1;
  return token;
}

/** 提交前展开占位符(仅整 token 匹配)。 */
export function expandPastes(store: PasteStore, text: string): string {
  let out = text;
  for (const [token, content] of store.entries) {
    out = out.split(token).join(content);
  }
  return out;
}
