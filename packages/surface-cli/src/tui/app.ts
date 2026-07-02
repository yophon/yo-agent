/**
 * Ink TUI 组装壳(DESIGN §7.2,4.6a 重构 / 4.6b 输入编辑器):交互式多轮 REPL。
 *
 * 分层:事件/交互 → UiState 的折叠在 model.ts(纯 reducer);按键 → 语义命令在 keymap.ts
 * (纯路由);多行编辑在 input/editor.ts(纯 buffer,字素/显示宽度);粘贴在 input/paste.ts
 * (括号粘贴状态机 + 大段折叠);历史在 input/history.ts(JSONL 持久)。本文件只做:订阅
 * 内核事件、执行命令副作用、摆放区块 + 状态栏 + 输入框/审批面板。
 *
 * dispatch 走「ref 镜像 + 纯 reduce」:同帧多次按键/事件在 useInput 闭包里能同步读到最新
 * 状态(useState 异步批处理读不到,4.5 已踩过)。
 *
 * 输入框运行中也可见(4.5 反例:steer 输入不可见);审批面板打开时才隐藏。
 * 用 React.createElement 而非 JSX(免 tsconfig jsx 配置、保持全 .ts)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalDecision, EventEnvelope, Id, PermissionMode } from '@yo-agent/protocol';
import {
  SLASH_HELP,
  SPINNER_FRAMES,
  parseSlash,
  riskColor,
  statusBar,
  summarizeInput,
} from '../tui-format';
import { initialState, reduce, type Block, type UiAction, type UiState } from './model';
import { routeKey, type KeyCommand } from './keymap';
import { renderBlock } from './render/blocks';
import * as ed from './input/editor';
import { PersistentHistory } from './input/history';
import { PasteTracker, expandPastes, foldPaste, newPasteStore } from './input/paste';

const h = React.createElement;

/** CliApp 仅依赖内核的这几个方法。interrupt/steer/listModels 可选(FakeKernel 测试免实现)。 */
export interface TuiKernel {
  subscribe(sessionId: Id, fromCursor: number | null, handler: (env: EventEnvelope) => void): () => void;
  submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<unknown>;
  decideApproval(requestId: Id, decision: ApprovalDecision, updatedInput?: unknown): void;
  interrupt?(sessionId: Id): Promise<void>;
  steer?(sessionId: Id, text: string): Promise<void>;
  listModels?(): Promise<ReadonlyArray<{ id?: string; name?: string }>>;
}

export interface CliAppProps {
  kernel: TuiKernel;
  sessionId: Id;
  /** 初始提问。空串 → 直接进输入态等待用户键入(交互式 REPL)。 */
  prompt: string;
  /** 状态栏展示用(不影响内核行为)。 */
  model?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  /** true:首轮完成即退出(单次模式 / 测试)。默认 false:多轮 REPL,持续到 /exit 或 Ctrl+C。 */
  autoExit?: boolean;
  /** 输入历史持久化路径;缺省 null = 纯内存(runTui 注入默认 ~/.config/yo-agent/history.jsonl)。 */
  historyFile?: string | null;
}

/** 输入框最多显示的视觉行数(超出围绕光标滚动)。 */
const INPUT_MAX_ROWS = 10;

export function CliApp(props: CliAppProps): React.ReactElement {
  const {
    kernel,
    sessionId,
    prompt,
    model = 'unknown',
    cwd = process.cwd(),
    permissionMode = 'supervised',
    autoExit = false,
    historyFile = null,
  } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // ── 状态:纯 reducer + ref 镜像(同帧同步可见)──────────────────────────
  const [state, setState] = useState<UiState>(() =>
    initialState({
      banner: `yo-agent · ${model} · ${cwd}\n输入消息回车发送;/help 查看命令;Esc/Ctrl+C 中断;/exit 退出`,
      running: prompt.trim().length > 0,
    }),
  );
  const stateRef = useRef(state);
  const dispatch = useCallback((a: UiAction): void => {
    stateRef.current = reduce(stateRef.current, a);
    setState(stateRef.current);
  }, []);

  // ── 编辑器(ref 镜像同理)──────────────────────────────────────────────
  const [editor, setEditorState] = useState<ed.EditorState>(ed.EMPTY);
  const edRef = useRef<ed.EditorState>(ed.EMPTY);
  const setEditor = (next: ed.EditorState): void => {
    edRef.current = next;
    setEditorState(next);
  };

  // 输入历史(仅记非 slash 的真实提问;historyFile 注入时跨进程持久)。
  const historyRef = useRef<PersistentHistory | null>(null);
  historyRef.current ??= PersistentHistory.load(historyFile, cwd);
  const histIdxRef = useRef(historyRef.current.list().length);

  // 粘贴:括号粘贴累积器 + 大段折叠登记表。
  const pasteTrackerRef = useRef(new PasteTracker());
  const pasteStoreRef = useRef(newPasteStore());

  // 退出保护:双击 Ctrl+C/Ctrl+D(3 秒窗口)。
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitArmedRef = useRef(false);
  const armExit = (): void => {
    if (exitArmedRef.current) {
      exit();
      return;
    }
    exitArmedRef.current = true;
    setExitArmed(true);
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    exitTimerRef.current = setTimeout(() => {
      exitArmedRef.current = false;
      setExitArmed(false);
    }, 3000);
  };
  useEffect(
    () => () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    },
    [],
  );

  // spinner 动画帧。
  const [spin, setSpin] = useState(0);
  useEffect(() => {
    if (!state.running) return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [state.running]);

  // ── 副作用:提交/命令 ────────────────────────────────────────────────
  function submit(text: string): void {
    dispatch({ type: 'submit', text });
    void kernel.submitInput(sessionId, text, `tui-${Date.now()}`).catch((e) => {
      dispatch({ type: 'submit-failed', message: e instanceof Error ? e.message : String(e) });
    });
  }

  useEffect(() => {
    const unsub = kernel.subscribe(sessionId, null, (env) => dispatch({ type: 'event', event: env.event }));
    if (prompt.trim().length > 0) {
      dispatch({ type: 'submit', text: prompt });
      void kernel.submitInput(sessionId, prompt, `tui-${Date.now()}`).catch(() => {});
    }
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel, sessionId, prompt]);

  // 单次模式(autoExit):首轮完成即退出。REPL 模式(默认)回到输入态。
  useEffect(() => {
    if (autoExit && state.turns > 0) {
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [autoExit, state.turns, exit]);

  function runSlash(cmd: string): void {
    switch (cmd) {
      case '/exit':
      case '/quit':
        exit();
        break;
      case '/help':
        dispatch({ type: 'notice', tone: 'info', text: SLASH_HELP });
        break;
      case '/clear':
        dispatch({ type: 'clear' });
        break;
      case '/cwd':
        dispatch({ type: 'notice', tone: 'info', text: `cwd: ${cwd}` });
        break;
      case '/model': {
        dispatch({ type: 'notice', tone: 'info', text: `当前模型:${model}` });
        void kernel
          .listModels?.()
          .then((ms) => {
            const names = ms.map((m) => m.id ?? m.name ?? '').filter(Boolean);
            if (names.length) dispatch({ type: 'notice', tone: 'info', text: `可用模型:${names.join(', ')}` });
          })
          .catch(() => {});
        break;
      }
      default:
        dispatch({ type: 'notice', tone: 'warn', text: `未知命令:${cmd}(/help 看帮助)` });
    }
  }

  function onSubmit(): void {
    const buf = edRef.current.text;
    // 行尾反斜杠续行(CC 惯例):替换为换行,不提交。
    if (buf.endsWith('\\')) {
      setEditor(ed.fromText(buf.slice(0, -1) + '\n'));
      return;
    }
    const text = expandPastes(pasteStoreRef.current, buf).trim();
    setEditor(ed.EMPTY);
    if (!text) return;
    const slash = parseSlash(text);
    if (slash) {
      runSlash(slash);
      return;
    }
    if (stateRef.current.running) {
      // 运行中:作为 steer 注入当前轮。
      if (kernel.steer) {
        void kernel.steer(sessionId, text).catch(() => {});
        dispatch({ type: 'steer', text });
      }
      return;
    }
    historyRef.current!.push(text);
    histIdxRef.current = historyRef.current!.list().length;
    submit(text);
  }

  // ── 命令执行(keymap 路由结果 → 副作用)────────────────────────────────
  function execute(cmd: KeyCommand): void {
    const s = stateRef.current;
    const cur = edRef.current;
    switch (cmd.type) {
      case 'approval-up':
        dispatch({ type: 'approval-move', delta: -1 });
        break;
      case 'approval-down':
        dispatch({ type: 'approval-move', delta: 1 });
        break;
      case 'approval-confirm': {
        const a = s.approval;
        if (a) {
          kernel.decideApproval(a.requestId, a.suggestions[a.selected]!.decision);
          dispatch({ type: 'approval-clear' });
        }
        break;
      }
      case 'approval-reject': {
        const a = s.approval;
        if (a) {
          kernel.decideApproval(a.requestId, 'reject_once');
          dispatch({ type: 'approval-clear' });
        }
        break;
      }
      case 'interrupt':
        void kernel.interrupt?.(sessionId).catch(() => {});
        break;
      case 'exit-request':
        armExit();
        break;
      case 'submit':
        onSubmit();
        break;
      case 'newline':
        setEditor(ed.newline(cur));
        break;
      case 'clear-input':
        setEditor(ed.EMPTY);
        break;
      case 'cursor-home':
        setEditor(ed.lineHome(cur));
        break;
      case 'cursor-end':
        setEditor(ed.lineEnd(cur));
        break;
      case 'cursor-left':
        setEditor(ed.left(cur));
        break;
      case 'cursor-right':
        setEditor(ed.right(cur));
        break;
      case 'cursor-up':
        setEditor(ed.up(cur) ?? cur);
        break;
      case 'cursor-down':
        setEditor(ed.down(cur) ?? cur);
        break;
      case 'word-left':
        setEditor(ed.wordLeft(cur));
        break;
      case 'word-right':
        setEditor(ed.wordRight(cur));
        break;
      case 'delete-word-back':
        setEditor(ed.deleteWordBack(cur));
        break;
      case 'kill-line-end':
        setEditor(ed.killToLineEnd(cur));
        break;
      case 'delete-forward':
        setEditor(ed.deleteForward(cur));
        break;
      case 'history-prev': {
        const hist = historyRef.current!.list();
        if (histIdxRef.current > 0) {
          histIdxRef.current -= 1;
          setEditor(ed.fromText(hist[histIdxRef.current] ?? ''));
        }
        break;
      }
      case 'history-next': {
        const hist = historyRef.current!.list();
        if (histIdxRef.current < hist.length) {
          histIdxRef.current += 1;
          setEditor(ed.fromText(histIdxRef.current < hist.length ? hist[histIdxRef.current]! : ''));
        }
        break;
      }
      case 'backspace':
        setEditor(ed.backspace(cur));
        break;
      case 'insert':
        setEditor(ed.insert(cur, cmd.text));
        break;
      default:
        break;
    }
  }

  useInput((ch, key) => {
    // ⓪ 括号粘贴拦截(keymap 之前):粘贴态内回车/Tab 等一律当字面量累积。
    const feed = pasteTrackerRef.current.feed(ch, { keyReturn: key.return, keyTab: key.tab });
    if (feed.consumed) {
      if (feed.done !== null) {
        setEditor(ed.insert(edRef.current, foldPaste(pasteStoreRef.current, ed.sanitize(feed.done))));
      }
      return;
    }
    const s = stateRef.current;
    const cur = edRef.current;
    const cmd = routeKey(ch, key, {
      approvalOpen: s.approval !== null,
      running: s.running,
      bufferEmpty: cur.text.length === 0,
      cursorAtFirstRow: ed.cursorRow(cur) === 0,
      cursorAtLastRow: ed.cursorRow(cur) === ed.rowCount(cur) - 1,
    });
    if (cmd) {
      // 任何非退出键都解除退出确认态。
      if (cmd.type !== 'exit-request' && exitArmedRef.current) {
        exitArmedRef.current = false;
        setExitArmed(false);
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      }
      execute(cmd);
    }
  });

  // ── 渲染 ──────────────────────────────────────────────────────────────
  const u = {
    inTok: state.totals.inTok + state.liveUsage.inTok,
    outTok: state.totals.outTok + state.liveUsage.outTok,
    cacheTok: state.totals.cacheTok + state.liveUsage.cacheTok,
    costUsd: state.totals.costUsd + state.liveUsage.costUsd,
  };
  const bar = statusBar({ model, mode: permissionMode, ...u, cwd });

  const footer: React.ReactElement[] = [];
  if (state.approval) {
    const a = state.approval;
    footer.push(
      h(
        Box,
        { key: 'approval', flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: riskColor(a.risk), paddingX: 1 },
        h(Text, { key: 'hdr', color: riskColor(a.risk) }, `⚠ 审批请求:${a.tool}  [风险 ${a.risk}]  (↑↓ 选择,Enter 确认,Esc 拒绝)`),
        h(Text, { key: 'in', color: 'gray' }, `  ${summarizeInput(a.input)}`),
        ...a.suggestions.map((sug, i) =>
          h(Text, { key: sug.decision, color: i === a.selected ? 'green' : undefined }, `${i === a.selected ? '❯ ' : '  '}${sug.label ?? sug.decision}`),
        ),
      ),
    );
  } else {
    if (state.running) {
      footer.push(
        h(Text, { key: 'busy', color: 'gray' }, `${SPINNER_FRAMES[spin]} 运行中…(Esc/Ctrl+C 中断,可直接输入引导后回车)`),
      );
    }
    footer.push(renderInputBox(editor, columns, state.running));
    const hint = exitArmed
      ? h(Text, { key: 'hint', color: 'yellow' }, '再按一次退出')
      : h(
          Text,
          { key: 'hint', color: 'gray', dimColor: true },
          state.running ? 'Enter 引导当前轮 · Esc 中断' : 'Enter 发送 · Alt+Enter/Ctrl+J 换行 · ↑↓ 历史 · /help 命令',
        );
    footer.push(hint);
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { key: 'static', items: state.committed, children: (b: unknown) => renderBlock(b as Block) }),
    state.live.length ? h(Box, { key: 'live', flexDirection: 'column' }, ...state.live.map(renderBlock)) : null,
    h(Text, { key: 'bar', color: 'gray', dimColor: true }, bar),
    ...footer,
  );
}

/** 多行输入框:边框圆角,首行 '› ' 前缀;超高围绕光标滚动;光标字素反白。 */
function renderInputBox(editor: ed.EditorState, columns: number, running: boolean): React.ReactElement {
  // 可用文本宽度 = 终端列 - 边框(2) - 内边距(2) - 前缀(2),下限 10。
  const usable = Math.max(10, columns - 6);
  const all = ed.layout(editor, usable);
  let lines = all;
  let offset = 0;
  if (all.length > INPUT_MAX_ROWS) {
    const cursorAt = Math.max(0, all.findIndex((l) => l.hasCursor));
    offset = Math.min(Math.max(0, cursorAt - INPUT_MAX_ROWS + 1), all.length - INPUT_MAX_ROWS);
    lines = all.slice(offset, offset + INPUT_MAX_ROWS);
  }
  const rows = lines.map((line, i) => {
    const prefix = offset + i === 0 ? h(Text, { key: 'p', color: 'cyan' }, '› ') : h(Text, { key: 'p' }, '  ');
    if (!line.hasCursor) return h(Text, { key: 'l' + i }, prefix, line.text);
    const { before, at, after } = ed.splitAtCursor(line.text, line.cursorUnits);
    return h(Text, { key: 'l' + i }, prefix, before, h(Text, { inverse: true }, at), after);
  });
  return h(
    Box,
    { key: 'input', flexDirection: 'column', borderStyle: 'round', borderColor: running ? 'gray' : 'cyan', paddingX: 1 },
    ...rows,
  );
}

/** 真 render(需 TTY)。headless / jsonl 模式不应走这里。 */
export async function runTui(props: CliAppProps): Promise<void> {
  const { render } = await import('ink');
  // 括号粘贴:粘贴包上 ESC[200~/201~ 定界(含换行的粘贴不再被当成回车提交)。
  process.stdout.write('\x1b[?2004h');
  // 历史默认 ~/.config/yo-agent/history.jsonl;YO_HISTORY 覆盖,YO_HISTORY='' 关闭。
  const envHist = process.env.YO_HISTORY;
  const historyFile =
    props.historyFile !== undefined ? props.historyFile : envHist !== undefined ? envHist || null : join(homedir(), '.config', 'yo-agent', 'history.jsonl');
  try {
    // exitOnCtrlC:false → Ctrl+C 交给组件(运行中中断当前轮,空闲双击退出)。
    const instance = render(h(CliApp, { ...props, historyFile }), { exitOnCtrlC: false });
    await instance.waitUntilExit();
  } finally {
    process.stdout.write('\x1b[?2004l');
  }
}
