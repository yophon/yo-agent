/**
 * 大粘贴折叠(4.6b;4.7b 起括号粘贴状态机移入 input/decoder.ts):
 * >FOLD_LINES 行的粘贴折叠为 `[粘贴 #n · N 行]` 占位符,提交时展开(输入框防爆屏)。
 */
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
