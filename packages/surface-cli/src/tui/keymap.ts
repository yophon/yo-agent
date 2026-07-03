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
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export interface KeyContext {
  /** 审批面板打开(最高优先,吞其余输入)。 */
  approvalOpen: boolean;
  /** 通用选择器打开(次优先,吞其余输入;/model /resume 等)。 */
  pickerOpen: boolean;
  /** 子代理任务面板打开(4.10c;同 picker 层吞键)。 */
  tasksOpen: boolean;
  /** 补全菜单打开(只截获 ↑↓/Tab/Enter/Esc,其余落回编辑器继续过滤)。 */
  menuOpen: boolean;
  /** 审批「拒绝并引导」输入态(Esc 返回审批面板而非中断)。 */
  guideActive: boolean;
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
  | { type: 'approval-choose'; index: number }
  | { type: 'guide-cancel' }
  | { type: 'cycle-mode' }
  | { type: 'queue' }
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
  | { type: 'picker-up' }
  | { type: 'picker-down' }
  | { type: 'picker-confirm' }
  | { type: 'picker-cancel' }
  | { type: 'tasks-up' }
  | { type: 'tasks-down' }
  /** 列表 Enter = 进详情;详情 Enter = 刷新快照。 */
  | { type: 'tasks-confirm' }
  /** 详情 Esc = 返回列表;列表 Esc = 关闭面板(区分在 executor)。 */
  | { type: 'tasks-back' }
  | { type: 'menu-up' }
  | { type: 'menu-down' }
  | { type: 'menu-accept' }
  | { type: 'menu-close' }
  | { type: 'insert'; text: string };

/** 无命令(吞掉或忽略)。 */
export type Routed = KeyCommand | null;

export function routeKey(ch: string, key: KeyLike, ctx: KeyContext): Routed {
  // ① 审批面板:方向/回车/Esc 裁决;Ctrl+C 放行(4.7f:中断/退出不被吞死);其余吞掉。
  if (ctx.approvalOpen) {
    if (key.ctrl && ch === 'c') return ctx.running ? { type: 'interrupt' } : { type: 'exit-request' };
    if (key.upArrow) return { type: 'approval-up' };
    if (key.downArrow) return { type: 'approval-down' };
    if (key.return) return { type: 'approval-confirm' };
    if (key.escape) return { type: 'approval-reject' };
    if (/^[1-9]$/.test(ch) && !key.ctrl && !key.meta) return { type: 'approval-choose', index: Number(ch) - 1 };
    return null;
  }

  // ①.2 引导输入态:Esc 返回审批面板(优先于全局中断);其余走编辑器。
  if (ctx.guideActive && key.escape) return { type: 'guide-cancel' };

  // ①.5 通用选择器:同审批,吞其余输入。
  if (ctx.pickerOpen) {
    if (key.upArrow) return { type: 'picker-up' };
    if (key.downArrow) return { type: 'picker-down' };
    if (key.return) return { type: 'picker-confirm' };
    if (key.escape) return { type: 'picker-cancel' };
    if (key.ctrl && ch === 'c') return { type: 'picker-cancel' };
    return null;
  }

  // ①.6 子代理任务面板(4.10c):同 picker 吞其余输入;Ctrl+C 放行为取消(同 picker 惯例)。
  if (ctx.tasksOpen) {
    if (key.upArrow) return { type: 'tasks-up' };
    if (key.downArrow) return { type: 'tasks-down' };
    if (key.return) return { type: 'tasks-confirm' };
    if (key.escape) return { type: 'tasks-back' };
    if (key.ctrl && ch === 'c') return { type: 'tasks-back' };
    return null;
  }

  // ①.7 补全菜单:只截获导航/接受/关闭,其余落回编辑器继续过滤。
  if (ctx.menuOpen) {
    if (key.upArrow) return { type: 'menu-up' };
    if (key.downArrow) return { type: 'menu-down' };
    if (key.tab) return { type: 'menu-accept' };
    if (key.return) return { type: 'menu-accept' };
    if (key.escape) return { type: 'menu-close' };
  }

  // ② Ctrl+C / Esc:运行中中断;空闲 Ctrl+C 请求退出、Esc 清空输入。
  if (key.ctrl && ch === 'c') return ctx.running ? { type: 'interrupt' } : { type: 'exit-request' };
  if (key.escape) return ctx.running ? { type: 'interrupt' } : { type: 'clear-input' };

  // ②.5 Shift+Tab:循环权限模式(read-only → supervised → accept-edits → autonomous)。
  if (key.tab && key.shift) return { type: 'cycle-mode' };

  // ③ 回车提交;Alt+Enter(ch='\r' 无 return 标志):运行中排队 follow-up、空闲换行;Ctrl+J(ch='\n')恒换行。
  if (key.return) return { type: 'submit' };
  if (ch === '\r') return ctx.running ? { type: 'queue' } : { type: 'newline' };
  if (ch === '\n') return { type: 'newline' };

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
