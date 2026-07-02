/**
 * 按键路由(4.6a):(字符, 修饰键, 上下文) → 语义命令,纯函数可单测。
 * 层级吞键:审批面板打开时吞掉全部输入,只发审批命令;之后按 全局(中断/退出)→
 * 提交 → 行编辑 → 历史 → 删除 → 可见字符 的优先级路由。app.ts 负责执行副作用。
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
  backspace?: boolean;
  delete?: boolean;
}

export interface KeyContext {
  /** 审批面板打开(最高优先,吞其余输入)。 */
  approvalOpen: boolean;
  /** 当前轮运行中(影响 Ctrl+C / Esc 语义)。 */
  running: boolean;
}

export type KeyCommand =
  | { type: 'approval-up' }
  | { type: 'approval-down' }
  | { type: 'approval-confirm' }
  | { type: 'approval-reject' }
  | { type: 'interrupt' }
  | { type: 'exit' }
  | { type: 'submit' }
  | { type: 'clear-input' }
  | { type: 'cursor-home' }
  | { type: 'cursor-end' }
  | { type: 'cursor-left' }
  | { type: 'cursor-right' }
  | { type: 'history-prev' }
  | { type: 'history-next' }
  | { type: 'backspace' }
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

  // ② Ctrl+C / Esc:运行中中断;空闲 Ctrl+C 退出、Esc 清空输入。
  if (key.ctrl && ch === 'c') return ctx.running ? { type: 'interrupt' } : { type: 'exit' };
  if (key.escape) return ctx.running ? { type: 'interrupt' } : { type: 'clear-input' };

  // ③ 回车:提交(app 决定 发送 / slash / steer)。
  if (key.return) return { type: 'submit' };

  // ④ 行内编辑。
  if (key.ctrl && ch === 'a') return { type: 'cursor-home' };
  if (key.ctrl && ch === 'e') return { type: 'cursor-end' };
  if (key.ctrl && ch === 'u') return { type: 'clear-input' };
  if (key.leftArrow) return { type: 'cursor-left' };
  if (key.rightArrow) return { type: 'cursor-right' };

  // ⑤ 历史。
  if (key.upArrow) return { type: 'history-prev' };
  if (key.downArrow) return { type: 'history-next' };

  // ⑥ 退格/删除(两种终端键位都删光标前一字符,4.5 兼容)。
  if (key.backspace || key.delete) return { type: 'backspace' };

  // ⑦ 可见字符插入。
  if (ch && !key.ctrl && !key.meta) return { type: 'insert', text: ch };

  return null;
}
