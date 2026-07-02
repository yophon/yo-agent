/**
 * 按键路由(4.6a,4.6b 扩多行编辑):(字符, 修饰键, 上下文) → 语义命令,纯函数可单测。
 * 层级吞键:审批面板打开时吞掉全部输入,只发审批命令;之后按 全局(中断/退出)→
 * 提交/换行 → 行编辑 → 词操作 → 行移/历史 → 删除 → 可见字符 的优先级路由。
 * app.ts 负责执行副作用。
 *
 * ink 5 派发事实(4.6b 实测 parse-keypress):Alt+Enter → ch='\r' 且 key.return=false;
 * Ctrl+J → ch='\n';Alt+B/F → ch='b'/'f' + meta;Alt+←→ → 方向键 + meta;
 * Home/End 被 ink 吞掉(input 清空且 Key 无对应位)→ 不可达,用 Ctrl+A/E。
 */

/** ink Key 的结构子集(不依赖 ink,便于离线测试)。 */
export interface KeyLike {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export interface KeyContext {
  /** 审批面板打开(最高优先,吞其余输入)。 */
  approvalOpen: boolean;
  /** 当前轮运行中(影响 Ctrl+C / Esc 语义)。 */
  running: boolean;
  /** 输入缓冲为空(Ctrl+D 退出判据)。 */
  bufferEmpty: boolean;
  /** 光标在首/末逻辑行(↑↓ 在 行移 与 历史 间切换)。 */
  cursorAtFirstRow: boolean;
  cursorAtLastRow: boolean;
}

export type KeyCommand =
  | { type: 'approval-up' }
  | { type: 'approval-down' }
  | { type: 'approval-confirm' }
  | { type: 'approval-reject' }
  | { type: 'interrupt' }
  /** 请求退出(app 做双击确认)。 */
  | { type: 'exit-request' }
  | { type: 'submit' }
  | { type: 'newline' }
  | { type: 'clear-input' }
  | { type: 'cursor-home' }
  | { type: 'cursor-end' }
  | { type: 'cursor-left' }
  | { type: 'cursor-right' }
  | { type: 'cursor-up' }
  | { type: 'cursor-down' }
  | { type: 'word-left' }
  | { type: 'word-right' }
  | { type: 'delete-word-back' }
  | { type: 'kill-line-end' }
  | { type: 'delete-forward' }
  | { type: 'history-prev' }
  | { type: 'history-next' }
  | { type: 'backspace' }
  | { type: 'toggle-verbose' }
  | { type: 'insert'; text: string };

/** 无命令(吞掉或忽略)。 */
export type Routed = KeyCommand | null;

export function routeKey(ch: string, key: KeyLike, ctx: KeyContext): Routed {
  // ① 审批面板:方向/回车/Esc 裁决,其余吞掉。
  if (ctx.approvalOpen) {
    if (key.upArrow) return { type: 'approval-up' };
    if (key.downArrow) return { type: 'approval-down' };
    if (key.return) return { type: 'approval-confirm' };
    if (key.escape) return { type: 'approval-reject' };
    return null;
  }

  // ② Ctrl+C / Esc:运行中中断;空闲 Ctrl+C 请求退出、Esc 清空输入。
  if (key.ctrl && ch === 'c') return ctx.running ? { type: 'interrupt' } : { type: 'exit-request' };
  if (key.escape) return ctx.running ? { type: 'interrupt' } : { type: 'clear-input' };

  // ③ 回车提交;Alt+Enter(ch='\r' 无 return 标志)/ Ctrl+J(ch='\n')→ 换行。
  if (key.return) return { type: 'submit' };
  if (ch === '\r' || ch === '\n') return { type: 'newline' };

  // ④ 行内编辑(readline 惯例)。
  if (key.ctrl && ch === 'a') return { type: 'cursor-home' };
  if (key.ctrl && ch === 'e') return { type: 'cursor-end' };
  if (key.ctrl && ch === 'u') return { type: 'clear-input' };
  if (key.ctrl && ch === 'w') return { type: 'delete-word-back' };
  if (key.ctrl && ch === 'k') return { type: 'kill-line-end' };
  if (key.ctrl && ch === 'd') return ctx.bufferEmpty ? { type: 'exit-request' } : { type: 'delete-forward' };
  if (key.ctrl && ch === 'b') return { type: 'cursor-left' };
  if (key.ctrl && ch === 'f') return { type: 'cursor-right' };
  if (key.ctrl && ch === 'o') return { type: 'toggle-verbose' };

  // ⑤ 词操作(Alt+B/F、Alt+←→)。
  if (key.meta && (ch === 'b' || key.leftArrow)) return { type: 'word-left' };
  if (key.meta && (ch === 'f' || key.rightArrow)) return { type: 'word-right' };

  // ⑥ 方向:多行内移动,首/末行转历史。
  if (key.leftArrow) return { type: 'cursor-left' };
  if (key.rightArrow) return { type: 'cursor-right' };
  if (key.upArrow) return ctx.cursorAtFirstRow ? { type: 'history-prev' } : { type: 'cursor-up' };
  if (key.downArrow) return ctx.cursorAtLastRow ? { type: 'history-next' } : { type: 'cursor-down' };

  // ⑦ 退格/删除(两种终端键位都删光标前一字素,4.5 兼容;前向删除用 Ctrl+D)。
  if (key.backspace || key.delete) return { type: 'backspace' };

  // ⑧ 可见字符插入(含整段粘贴的多字符 chunk;换行归一由 editor.sanitize 兜底)。
  if (ch && !key.ctrl && !key.meta && !key.tab) return { type: 'insert', text: ch };

  return null;
}
