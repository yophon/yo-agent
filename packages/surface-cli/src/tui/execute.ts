/**
 * 命令执行器(4.7d 自 app.ts 拆出):keymap 路由出的语义命令 → 状态变更/内核副作用。
 * 纯编辑器命令(光标/删改)在 applyEditorCommand 独立成纯函数;审批/选择器/菜单/队列/
 * 历史/提交需要上下文,走 createExecutor(ctx) 闭包。app.ts 只负责构造 ExecuteCtx 与分发。
 */
import type { Id, PermissionMode } from '@yo-agent/protocol';
import * as ed from './input/editor';
import type { Completion } from './input/completion';
import { acceptCompletion } from './input/completion';
import type { PersistentHistory } from './input/history';
import type { KeyCommand } from './keymap';
import type { ApprovalView, UiAction, UiState } from './model';
import type { TuiKernel } from './types';
import type { ArmedConfirm } from './hooks';
import { MODE_CYCLE, parseCommandLine } from './commands';

/** 纯编辑器命令 → 新编辑器状态;非编辑器命令返回 null(交回 executor)。 */
export function applyEditorCommand(cur: ed.EditorState, cmd: KeyCommand): ed.EditorState | null {
  switch (cmd.type) {
    case 'newline':
      return ed.newline(cur);
    case 'clear-input':
      return ed.EMPTY;
    case 'cursor-home':
      return ed.lineHome(cur);
    case 'cursor-end':
      return ed.lineEnd(cur);
    case 'cursor-left':
      return ed.left(cur);
    case 'cursor-right':
      return ed.right(cur);
    case 'cursor-up':
      return ed.up(cur) ?? cur;
    case 'cursor-down':
      return ed.down(cur) ?? cur;
    case 'word-left':
      return ed.wordLeft(cur);
    case 'word-right':
      return ed.wordRight(cur);
    case 'delete-word-back':
      return ed.deleteWordBack(cur);
    case 'kill-line-end':
      return ed.killToLineEnd(cur);
    case 'delete-forward':
      return ed.deleteForward(cur);
    case 'backspace':
      return ed.backspace(cur);
    case 'insert':
      return ed.insert(cur, cmd.text);
    default:
      return null;
  }
}

/** executor 依赖的组件上下文(app.ts 每渲染构造;访问器保证同帧读到最新值)。 */
export interface ExecuteCtx {
  kernel: TuiKernel;
  dispatch(a: UiAction): void;
  /** stateRef.current(同帧最新)。 */
  state(): UiState;
  editor(): ed.EditorState;
  setEditor(st: ed.EditorState): void;
  sid(): Id;
  mode(): PermissionMode;
  /** Shift+Tab 与 /mode 共用的切模式入口(commands.applyMode 已含内核接缝与提示)。 */
  applyMode(mode: PermissionMode): void;
  runSlash(name: string, args: string): void;
  submit(text: string): void;
  history(): PersistentHistory;
  histIdx: { current: number };
  expandPastes(text: string): string;
  computeMenu(st: ed.EditorState): Completion | null;
  toggleVerbose(): void;
  exit(): void;
  exitConfirm: ArmedConfirm;
  rejectConfirm: ArmedConfirm;
}

export interface Executor {
  execute(cmd: KeyCommand): void;
  onSubmit(): void;
}

export function createExecutor(ctx: ExecuteCtx): Executor {
  const steer = (text: string): void => {
    if (!ctx.kernel.steer) return;
    void ctx.kernel.steer(ctx.sid(), text).catch(() => {});
    ctx.dispatch({ type: 'steer', text });
  };

  function onSubmit(): void {
    const buf = ctx.editor().text;
    // 行尾反斜杠续行(CC 惯例):替换为换行,不提交。
    if (buf.endsWith('\\')) {
      ctx.setEditor(ed.fromText(`${buf.slice(0, -1)}\n`));
      return;
    }
    const text = ctx.expandPastes(buf).trim();
    ctx.setEditor(ed.EMPTY);
    // 审批引导输入态:回车 = 拒绝该操作 + steer 告知怎么做。
    const g = ctx.state().pendingGuide;
    if (g) {
      if (!text) return; // 空输入留在引导态(Esc 返回审批)
      ctx.dispatch({ type: 'guide-exit' });
      ctx.kernel.decideApproval(g.requestId, 'reject_once');
      steer(text);
      return;
    }
    if (!text) return;
    const slash = parseCommandLine(text);
    if (slash) {
      ctx.runSlash(slash.name, slash.args);
      return;
    }
    if (ctx.state().running) {
      // 运行中:作为 steer 注入当前轮。
      steer(text);
      return;
    }
    ctx.history().push(text);
    ctx.histIdx.current = ctx.history().list().length;
    ctx.submit(text);
  }

  /** 审批裁决(Enter/数字键共用):末位合成项 = 转「拒绝并引导」输入态。 */
  function decideApprovalAt(a: ApprovalView | null, index: number): void {
    if (!a) return;
    ctx.rejectConfirm.disarm();
    const total = a.suggestions.length + (a.withGuide ? 1 : 0);
    if (index < 0 || index >= total) return;
    if (a.withGuide && index === a.suggestions.length) {
      ctx.dispatch({ type: 'guide-enter' });
      ctx.setEditor(ed.EMPTY);
      return;
    }
    ctx.kernel.decideApproval(a.requestId, a.suggestions[index]!.decision);
    ctx.dispatch({ type: 'approval-clear' });
  }

  function execute(cmd: KeyCommand): void {
    const s = ctx.state();
    const cur = ctx.editor();
    // 纯编辑器命令统一分发。
    const edited = applyEditorCommand(cur, cmd);
    if (edited !== null) {
      ctx.setEditor(edited);
      return;
    }
    switch (cmd.type) {
      case 'approval-up':
        ctx.rejectConfirm.disarm();
        ctx.dispatch({ type: 'approval-move', delta: -1 });
        break;
      case 'approval-down':
        ctx.rejectConfirm.disarm();
        ctx.dispatch({ type: 'approval-move', delta: 1 });
        break;
      case 'approval-confirm':
        decideApprovalAt(s.approval, s.approval?.selected ?? 0);
        break;
      case 'approval-choose':
        decideApprovalAt(s.approval, cmd.index);
        break;
      case 'approval-reject': {
        const a = s.approval;
        if (!a) break;
        // Esc 双击才拒绝(防与全局 Esc 中断的肌肉记忆误触)。
        ctx.rejectConfirm.fire(() => {
          ctx.kernel.decideApproval(a.requestId, 'reject_once');
          ctx.dispatch({ type: 'approval-clear' });
        });
        break;
      }
      case 'guide-cancel':
        // 从引导输入态返回审批面板(走 reducer,4.7c)。
        if (s.pendingGuide) {
          ctx.setEditor(ed.EMPTY);
          ctx.dispatch({ type: 'approval-restore' });
        }
        break;
      case 'cycle-mode': {
        const idx = MODE_CYCLE.indexOf(ctx.mode());
        ctx.applyMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!);
        break;
      }
      case 'queue': {
        const text = ctx.expandPastes(cur.text).trim();
        ctx.setEditor(ed.EMPTY);
        if (text) ctx.dispatch({ type: 'queue-push', text });
        break;
      }
      case 'picker-up':
      case 'picker-down':
        ctx.dispatch({ type: 'picker-move', delta: cmd.type === 'picker-up' ? -1 : 1 });
        break;
      case 'picker-confirm': {
        const p = s.picker;
        if (p) {
          ctx.dispatch({ type: 'picker-close' });
          p.onPick(p.items[p.selected]!.value);
        }
        break;
      }
      case 'picker-cancel':
        ctx.dispatch({ type: 'picker-close' });
        break;
      case 'menu-up':
      case 'menu-down': {
        const comp = ctx.computeMenu(cur);
        if (comp?.items.length) {
          const n = comp.items.length;
          const delta = cmd.type === 'menu-up' ? -1 : 1;
          ctx.dispatch({ type: 'menu-select', index: (s.menu.selected + delta + n) % n });
        }
        break;
      }
      case 'menu-accept': {
        const comp = ctx.computeMenu(cur);
        const item = comp?.items[Math.min(s.menu.selected, (comp?.items.length ?? 1) - 1)];
        if (comp && item) {
          // 已完整键入命令名 → 直接执行(Enter 一步到位)。
          if (comp.kind === 'slash' && item.value === comp.token) {
            onSubmit();
          } else {
            const next = acceptCompletion(cur.text, comp, item);
            ctx.setEditor(ed.fromText(next.text, next.cursor));
          }
        }
        break;
      }
      case 'menu-close': {
        const comp = ctx.computeMenu(cur);
        if (comp) ctx.dispatch({ type: 'menu-suppress', token: comp.token });
        ctx.dispatch({ type: 'menu-select', index: 0 });
        break;
      }
      case 'interrupt':
        void ctx.kernel.interrupt?.(ctx.sid()).catch(() => {});
        break;
      case 'toggle-verbose':
        ctx.toggleVerbose();
        break;
      case 'exit-request':
        ctx.exitConfirm.fire(ctx.exit);
        break;
      case 'submit':
        onSubmit();
        break;
      case 'history-prev': {
        // 有排队消息且输入为空 → 先取回队尾编辑。
        if (s.queue.length && cur.text.length === 0) {
          const last = s.queue.at(-1)!;
          ctx.dispatch({ type: 'queue-pop' });
          ctx.setEditor(ed.fromText(last));
          break;
        }
        const hist = ctx.history().list();
        if (ctx.histIdx.current > 0) {
          ctx.histIdx.current -= 1;
          ctx.setEditor(ed.fromText(hist[ctx.histIdx.current] ?? ''));
        }
        break;
      }
      case 'history-next': {
        const hist = ctx.history().list();
        if (ctx.histIdx.current < hist.length) {
          ctx.histIdx.current += 1;
          ctx.setEditor(ed.fromText(ctx.histIdx.current < hist.length ? hist[ctx.histIdx.current]! : ''));
        }
        break;
      }
      default:
        break;
    }
  }

  return { execute, onSubmit };
}
