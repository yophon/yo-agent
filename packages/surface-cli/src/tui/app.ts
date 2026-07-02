/**
 * Ink TUI 组装壳(DESIGN §7.2;4.6a 重构 / 4.6b 输入 / 4.6c 渲染 / 4.6d 命令与补全)。
 *
 * 分层:事件折叠在 model.ts(纯 reducer);按键路由在 keymap.ts(层级:审批 > 选择器 >
 * 补全菜单 > 编辑器);多行编辑 input/editor.ts;粘贴 input/paste.ts;历史 input/history.ts;
 * 补全 input/completion.ts;slash 注册表 commands.ts;渲染 render/*。本文件只做:订阅内核
 * 事件、执行命令副作用、摆放区块 + 状态栏 + 输入框/审批/选择器。
 *
 * dispatch 走「ref 镜像 + 纯 reduce」:同帧多次按键/事件在 useInput 闭包里能同步读到最新
 * 状态(useState 异步批处理读不到,4.5 已踩过)。
 * 用 React.createElement 而非 JSX(免 tsconfig jsx 配置、保持全 .ts)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalDecision, EventEnvelope, Id, PermissionMode } from '@yo-agent/protocol';
import { SPINNER_FRAMES, fmtInt, riskColor, statusBar, summarizeInput } from '../tui-format';
import { initialState, reduce, type Block, type UiAction, type UiState } from './model';
import { routeKey, type KeyCommand } from './keymap';
import { renderBlock, type RenderOpts } from './render/blocks';
import { renderCompletionMenu, renderPicker, type PickerState } from './render/picker';
import * as ed from './input/editor';
import { PersistentHistory } from './input/history';
import { PasteTracker, expandPastes, foldPaste, newPasteStore } from './input/paste';
import { acceptCompletion, computeCompletion, listFiles, type Completion } from './input/completion';
import { MODE_CYCLE, applyMode, buildCommands, findCommand, parseCommandLine, type CommandDeps } from './commands';
import { approvalBody } from './render/approval';
import { styledLine } from './render/blocks';
import { readFileSync } from 'node:fs';
import type { ApprovalView } from './model';

const h = React.createElement;

/** CliApp 仅依赖内核的这几个方法。可选项缺省时对应功能降级(FakeKernel 测试免实现)。 */
export interface TuiKernel {
  subscribe(sessionId: Id, fromCursor: number | null, handler: (env: EventEnvelope) => void): () => void;
  submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<unknown>;
  decideApproval(requestId: Id, decision: ApprovalDecision, updatedInput?: unknown): void;
  interrupt?(sessionId: Id): Promise<void>;
  steer?(sessionId: Id, text: string): Promise<void>;
  listModels?(): Promise<ReadonlyArray<{ id?: string; name?: string }>>;
  /** /new 用;缺省时 /new 提示不可用。 */
  startSession?(opts?: { model?: string; cwd?: string; permissionMode?: PermissionMode }): Promise<Id>;
  // ── 4.6e 内核接缝(全部可选,缺省时对应命令降级提示)──
  setModel?(sessionId: Id, model: string): void;
  setPermissionMode?(sessionId: Id, mode: PermissionMode): void;
  compactNow?(sessionId: Id): Promise<boolean>;
  contextState?(sessionId: Id): { usedTokens: number; usableTokens: number };
  listPersistedSessions?(): Promise<
    ReadonlyArray<{ sessionId: Id; model: string; workspacePath: string; lastActiveAt: number }>
  >;
  resumeSession?(sessionId: Id): Promise<boolean>;
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
  /** @ 文件补全数据源(测试注入;缺省 git ls-files / fs 遍历)。 */
  fileLister?: (cwd: string) => Promise<string[]>;
  /** FakeProvider 演示态(状态栏醒目提示)。 */
  demo?: boolean;
  /** 启动即打开 /resume 选择器(`yoagent --resume` 不带 id)。 */
  openResumePicker?: boolean;
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
    fileLister = listFiles,
    demo = false,
    openResumePicker = false,
  } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // ── 会话(/new /resume 可切换)+ 会话级模型/模式(K1/K2 可变)──────────
  const [sid, setSid] = useState<Id>(sessionId);
  const sidRef = useRef<Id>(sessionId);
  const [curModel, setCurModel] = useState(model);
  const [curMode, setCurMode] = useState<PermissionMode>(permissionMode);
  const curModeRef = useRef<PermissionMode>(permissionMode);

  // 上下文占用(状态栏 ctx%)与 git 分支;每轮完成/压缩后刷新。
  const [ctx, setCtx] = useState<{ usedTokens: number; usableTokens: number } | null>(null);
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const refreshMeta = useCallback((): void => {
    try {
      const c = kernel.contextState?.(sidRef.current);
      if (c) setCtx(c);
    } catch {
      // 会话未知等瞬态错误忽略
    }
    setBranch(readGitBranch(cwd));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel, cwd]);

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

  // ── 补全(4.6d):候选由 editor 状态派生;选中/抑制为本地状态 ─────────────
  const commandsRef = useRef(buildCommands());
  const [files, setFiles] = useState<string[] | null>(null);
  const filesRef = useRef<string[] | null>(null);
  const filesLoadingRef = useRef(false);
  const [menuSel, setMenuSel] = useState(0);
  const menuSelRef = useRef(0);
  const setMenuSelBoth = (n: number): void => {
    menuSelRef.current = n;
    setMenuSel(n);
  };
  /** Esc 关闭菜单后抑制同一 token(输入变化自动解除)。 */
  const suppressedTokenRef = useRef<string | null>(null);
  const lastTokenRef = useRef<string | null>(null);

  const computeMenu = (edState: ed.EditorState): Completion | null => {
    const comp = computeCompletion(edState.text, edState.cursor, {
      commands: commandsRef.current.map((c) => ({ name: c.name, desc: c.desc })),
      files: filesRef.current,
    });
    if (!comp) return null;
    if (suppressedTokenRef.current === comp.token) return null;
    return comp;
  };
  const completion = computeMenu(editor);
  // token 变化 → 重置选中、解除抑制;触发文件清单懒加载。
  useEffect(() => {
    const token = completion?.token ?? null;
    if (token !== lastTokenRef.current) {
      lastTokenRef.current = token;
      setMenuSelBoth(0);
      if (token !== null) suppressedTokenRef.current = null;
    }
    if (completion?.kind === 'file' && filesRef.current === null && !filesLoadingRef.current) {
      filesLoadingRef.current = true;
      void fileLister(cwd)
        .then((list) => {
          filesRef.current = list;
          setFiles(list);
        })
        .catch(() => {
          filesRef.current = [];
          setFiles([]);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completion?.token, completion?.kind]);

  // ── 通用选择器(/model /mode /resume 用;4.6d 落组件与路由层)────────────
  const [picker, setPickerState] = useState<PickerState | null>(null);
  const pickerRef = useRef<PickerState | null>(null);
  const setPicker = (p: PickerState | null): void => {
    pickerRef.current = p;
    setPickerState(p);
  };

  // 推理流显隐(/reasoning;只影响 live 渲染,scrollback 不回改)。
  const [showReasoning, setShowReasoning] = useState(true);
  const showReasoningRef = useRef(true);

  // 排队 follow-up(4.6e):运行中 Alt+Enter 入队,正常完成后自动作为下一轮提交。
  const [queue, setQueueState] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const setQueue = (q: string[]): void => {
    queueRef.current = q;
    setQueueState(q);
  };

  // 审批「拒绝并引导」输入态 + Esc 双击拒绝防误触。
  const [pendingGuide, setPendingGuideState] = useState<ApprovalView | null>(null);
  const pendingGuideRef = useRef<ApprovalView | null>(null);
  const setPendingGuide = (g: ApprovalView | null): void => {
    pendingGuideRef.current = g;
    setPendingGuideState(g);
  };
  const [rejectArmed, setRejectArmed] = useState(false);
  const rejectArmedRef = useRef(false);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmReject = (): void => {
    rejectArmedRef.current = false;
    setRejectArmed(false);
    if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
  };

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

  // spinner 动画帧 + 本轮起始时刻(活动行耗时,UI 本地时钟)。
  const [spin, setSpin] = useState(0);
  const runStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state.running) {
      runStartedAtRef.current = null;
      return;
    }
    runStartedAtRef.current ??= Date.now();
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [state.running]);

  // 工具区块展开体(Ctrl+O);只影响其后渲染(<Static> 已渲区块不回改)。
  const [verbose, setVerbose] = useState(false);
  const verboseRef = useRef(false);

  // ── 副作用:提交/命令 ────────────────────────────────────────────────
  function submit(text: string): void {
    dispatch({ type: 'submit', text });
    void kernel.submitInput(sidRef.current, text, `tui-${Date.now()}`).catch((e) => {
      dispatch({ type: 'submit-failed', message: e instanceof Error ? e.message : String(e) });
    });
  }

  // 订阅当前会话事件;/new 切换 sid 后自动重订阅。
  useEffect(() => {
    sidRef.current = sid;
    return kernel.subscribe(sid, null, (env) => {
      dispatch({ type: 'event', event: env.event, ts: env.ts });
      if (env.event.kind === 'ContextCompacted') refreshMeta();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel, sid]);

  // ctx% / git 分支:挂载 + 每轮完成后刷新。
  useEffect(() => {
    refreshMeta();
  }, [refreshMeta, state.turns, sid]);

  // 排队 follow-up:正常完成(end_turn)后自动出队提交;中断/失败保留待手动。
  useEffect(() => {
    if (state.running || !queueRef.current.length) return;
    if (state.lastStop !== 'end_turn') {
      if (state.lastStop) dispatch({ type: 'notice', tone: 'warn', text: `已排队 ${queueRef.current.length} 条保留(↑ 取回或直接回车发送)` });
      return;
    }
    const [next, ...rest] = queueRef.current;
    setQueue(rest);
    historyRef.current!.push(next!);
    histIdxRef.current = historyRef.current!.list().length;
    submit(next!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.running, state.turns]);

  // `yoagent --resume` 不带 id:挂载即打开会话选择器。
  useEffect(() => {
    if (openResumePicker) {
      const cmd = findCommand(commandsRef.current, '/resume');
      if (cmd) void cmd.run(commandDeps, '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始 prompt 只在首个会话提交一次。
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    if (prompt.trim().length > 0) {
      dispatch({ type: 'submit', text: prompt });
      void kernel.submitInput(sidRef.current, prompt, `tui-${Date.now()}`).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 单次模式(autoExit):首轮完成即退出。REPL 模式(默认)回到输入态。
  useEffect(() => {
    if (autoExit && state.turns > 0) {
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [autoExit, state.turns, exit]);

  // slash 命令依赖注入。
  const commandDeps: CommandDeps = {
    kernel,
    sessionId: () => sidRef.current,
    model: curModel,
    mode: curMode,
    cwd,
    getState: () => stateRef.current,
    notice: (tone, text) => dispatch({ type: 'notice', tone, text }),
    clear: () => dispatch({ type: 'clear' }),
    exit,
    openPicker: (p) => setPicker(p),
    setModelUi: (m) => setCurModel(m),
    setModeUi: (m) => {
      curModeRef.current = m;
      setCurMode(m);
    },
    switchSession: (id) => {
      setSid(id);
      dispatch({ type: 'clear' });
      refreshMeta();
    },
    newSession: kernel.startSession
      ? async () => {
          try {
            const next = await kernel.startSession!({ model: curModel, cwd, permissionMode: curModeRef.current });
            setSid(next);
            dispatch({ type: 'clear' });
            dispatch({ type: 'notice', tone: 'info', text: `已开新会话 ${String(next).slice(0, 8)}` });
          } catch (e) {
            dispatch({ type: 'notice', tone: 'error', text: `新会话失败:${e instanceof Error ? e.message : String(e)}` });
          }
        }
      : undefined,
    toggleReasoning: () => {
      showReasoningRef.current = !showReasoningRef.current;
      setShowReasoning(showReasoningRef.current);
      return showReasoningRef.current;
    },
  };

  function runSlash(name: string, args: string): void {
    const cmd = findCommand(commandsRef.current, name);
    if (!cmd) {
      dispatch({ type: 'notice', tone: 'warn', text: `未知命令:${name}(/help 看帮助)` });
      return;
    }
    void cmd.run(commandDeps, args);
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
    // 审批引导输入态:回车 = 拒绝该操作 + steer 告知怎么做。
    const g = pendingGuideRef.current;
    if (g) {
      if (!text) return; // 空输入留在引导态(Esc 返回审批)
      setPendingGuide(null);
      kernel.decideApproval(g.requestId, 'reject_once');
      if (kernel.steer) {
        void kernel.steer(sidRef.current, text).catch(() => {});
        dispatch({ type: 'steer', text });
      }
      return;
    }
    if (!text) return;
    const slash = parseCommandLine(text);
    if (slash) {
      runSlash(slash.name, slash.args);
      return;
    }
    if (stateRef.current.running) {
      // 运行中:作为 steer 注入当前轮。
      if (kernel.steer) {
        void kernel.steer(sidRef.current, text).catch(() => {});
        dispatch({ type: 'steer', text });
      }
      return;
    }
    historyRef.current!.push(text);
    histIdxRef.current = historyRef.current!.list().length;
    submit(text);
  }

  /** 审批裁决(Enter/数字键共用):末位合成项 = 转「拒绝并引导」输入态。 */
  function decideApprovalAt(a: ApprovalView | null, index: number): void {
    if (!a) return;
    disarmReject();
    const total = a.suggestions.length + (a.withGuide ? 1 : 0);
    if (index < 0 || index >= total) return;
    if (a.withGuide && index === a.suggestions.length) {
      setPendingGuide(a);
      dispatch({ type: 'approval-clear' });
      setEditor(ed.EMPTY);
      return;
    }
    kernel.decideApproval(a.requestId, a.suggestions[index]!.decision);
    dispatch({ type: 'approval-clear' });
  }

  // ── 命令执行(keymap 路由结果 → 副作用)────────────────────────────────
  function execute(cmd: KeyCommand): void {
    const s = stateRef.current;
    const cur = edRef.current;
    switch (cmd.type) {
      case 'approval-up':
        disarmReject();
        dispatch({ type: 'approval-move', delta: -1 });
        break;
      case 'approval-down':
        disarmReject();
        dispatch({ type: 'approval-move', delta: 1 });
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
        if (!rejectArmedRef.current) {
          rejectArmedRef.current = true;
          setRejectArmed(true);
          if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
          rejectTimerRef.current = setTimeout(disarmReject, 3000);
          break;
        }
        disarmReject();
        kernel.decideApproval(a.requestId, 'reject_once');
        dispatch({ type: 'approval-clear' });
        break;
      }
      case 'guide-cancel': {
        // 从引导输入态返回审批面板。
        const g = pendingGuideRef.current;
        if (g) {
          setPendingGuide(null);
          setEditor(ed.EMPTY);
          stateRef.current = { ...stateRef.current, approval: g };
          setState(stateRef.current);
        }
        break;
      }
      case 'cycle-mode': {
        const idx = MODE_CYCLE.indexOf(curModeRef.current);
        const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!;
        applyMode(commandDeps, next);
        break;
      }
      case 'queue': {
        const text = expandPastes(pasteStoreRef.current, edRef.current.text).trim();
        setEditor(ed.EMPTY);
        if (text) setQueue([...queueRef.current, text]);
        break;
      }
      case 'picker-up':
      case 'picker-down': {
        const p = pickerRef.current;
        if (p) {
          const n = p.items.length;
          const delta = cmd.type === 'picker-up' ? -1 : 1;
          setPicker({ ...p, selected: (p.selected + delta + n) % n });
        }
        break;
      }
      case 'picker-confirm': {
        const p = pickerRef.current;
        if (p) {
          setPicker(null);
          p.onPick(p.items[p.selected]!.value);
        }
        break;
      }
      case 'picker-cancel':
        setPicker(null);
        break;
      case 'menu-up':
      case 'menu-down': {
        const comp = computeMenu(edRef.current);
        if (comp?.items.length) {
          const n = comp.items.length;
          const delta = cmd.type === 'menu-up' ? -1 : 1;
          setMenuSelBoth((menuSelRef.current + delta + n) % n);
        }
        break;
      }
      case 'menu-accept': {
        const comp = computeMenu(edRef.current);
        const item = comp?.items[Math.min(menuSelRef.current, (comp?.items.length ?? 1) - 1)];
        if (comp && item) {
          // 已完整键入命令名 → 直接执行(Enter 一步到位)。
          if (comp.kind === 'slash' && item.value === comp.token) {
            onSubmit();
          } else {
            const next = acceptCompletion(edRef.current.text, comp, item);
            setEditor(ed.fromText(next.text, next.cursor));
          }
        }
        break;
      }
      case 'menu-close': {
        const comp = computeMenu(edRef.current);
        if (comp) suppressedTokenRef.current = comp.token;
        setMenuSelBoth(0);
        // 触发重渲(抑制存于 ref)。
        setEditor({ ...edRef.current });
        break;
      }
      case 'interrupt':
        void kernel.interrupt?.(sidRef.current).catch(() => {});
        break;
      case 'toggle-verbose':
        verboseRef.current = !verboseRef.current;
        setVerbose(verboseRef.current);
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
        // 有排队消息且输入为空 → 先取回队尾编辑。
        if (queueRef.current.length && edRef.current.text.length === 0) {
          const q = [...queueRef.current];
          const last = q.pop()!;
          setQueue(q);
          setEditor(ed.fromText(last));
          break;
        }
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
      pickerOpen: pickerRef.current !== null,
      menuOpen: computeMenu(cur) !== null && (computeMenu(cur)?.items.length ?? 0) > 0,
      guideActive: pendingGuideRef.current !== null,
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
  const ctxLeftPct =
    ctx && ctx.usableTokens > 0 ? Math.max(0, 100 - (ctx.usedTokens / ctx.usableTokens) * 100) : undefined;
  const bar = statusBar({ model: curModel, mode: curMode, ...u, cwd, ctxLeftPct, branch });

  const footer: React.ReactElement[] = [];
  if (state.approval) {
    const a = state.approval;
    const options = [
      ...a.suggestions.map((sug) => sug.label ?? sug.decision),
      ...(a.withGuide ? ['拒绝并告诉它该怎么做…'] : []),
    ];
    const body = approvalBody(a.tool, a.input);
    footer.push(
      h(
        Box,
        { key: 'approval', flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: riskColor(a.risk), paddingX: 1 },
        h(
          Text,
          { key: 'hdr', color: riskColor(a.risk) },
          `⚠ ${a.tool} · 风险 ${a.risk}`,
          h(Text, { key: 'k', dimColor: true }, '  (↑↓/数字 选择 · Enter 确认 · Esc×2 拒绝)'),
        ),
        ...body.map((line, i) => styledLine(line, 'b' + i, ' ')),
        h(Text, { key: 'sp' }, ' '),
        ...options.map((label, i) =>
          h(
            Text,
            { key: 'o' + i, color: i === a.selected ? 'green' : undefined },
            `${i === a.selected ? '❯' : ' '} ${i + 1}. ${label}`,
          ),
        ),
        rejectArmed ? h(Text, { key: 'ra', color: 'yellow' }, '再按 Esc 拒绝') : null,
      ),
    );
  } else if (pendingGuide) {
    // 引导输入态:输入框 + 提示(Enter = 拒绝并告知;Esc 返回审批)。
    footer.push(
      h(Text, { key: 'g', color: 'yellow' }, `⚠ 引导 ${pendingGuide.tool}:输入它该怎么做,回车 = 拒绝该操作并告知`),
      renderInputBox(editor, columns, false),
      h(Text, { key: 'gh', color: 'gray', dimColor: true }, 'Enter 拒绝并引导 · Esc 返回审批面板'),
    );
  } else if (picker) {
    footer.push(renderPicker(picker));
  } else {
    if (state.running) {
      // 活动行(4.6c):动作词 + 耗时 + 本轮出 token。
      const elapsed = runStartedAtRef.current ? Math.floor((Date.now() - runStartedAtRef.current) / 1000) : 0;
      const parts = [`${SPINNER_FRAMES[spin]} ${state.activity}…`];
      if (elapsed >= 1) parts.push(`${elapsed}s`);
      if (state.liveUsage.outTok > 0) parts.push(`↓${fmtInt(state.liveUsage.outTok)}`);
      footer.push(
        h(
          Text,
          { key: 'busy', color: 'gray' },
          parts.join(' · '),
          h(Text, { key: 'h', dimColor: true }, '(Esc 中断 · Enter 引导 · Alt+Enter 排队)'),
        ),
      );
    }
    if (queue.length) {
      footer.push(h(Text, { key: 'q', color: 'yellow' }, `⏸ 已排队 ${queue.length} 条(完成后自动发送 · 输入框空时 ↑ 取回)`));
    }
    footer.push(renderInputBox(editor, columns, state.running));
    if (completion) {
      footer.push(
        renderCompletionMenu(
          completion.items.map((i) => ({ label: i.label, hint: i.hint })),
          menuSel,
          completion.kind === 'file' && files === null,
        ),
      );
    }
    const hint = exitArmed
      ? h(Text, { key: 'hint', color: 'yellow' }, '再按一次退出')
      : h(
          Text,
          { key: 'hint', color: 'gray', dimColor: true },
          completion
            ? 'Tab/Enter 补全 · Esc 关闭'
            : state.running
              ? 'Enter 引导当前轮 · Alt+Enter 排队 · Esc 中断 · Ctrl+O 详情'
              : 'Enter 发送 · Alt+Enter/Ctrl+J 换行 · ↑↓ 历史 · @ 文件 · Ctrl+O 详情 · /help 命令',
        );
    footer.push(hint);
  }

  const renderOpts: RenderOpts = { width: columns, verbose };
  const liveBlocks = showReasoning ? state.live : state.live.filter((b) => b.kind !== 'reasoning');
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { key: 'static', items: state.committed, children: (b: unknown) => renderBlock(b as Block, renderOpts) }),
    liveBlocks.length
      ? h(Box, { key: 'live', flexDirection: 'column' }, ...liveBlocks.map((b) => renderBlock(b, renderOpts)))
      : null,
    h(
      Text,
      { key: 'bar' },
      demo ? h(Text, { key: 'demo', color: 'yellow' }, 'FAKE 演示 · ') : null,
      h(Text, { key: 'txt', color: 'gray', dimColor: true }, bar),
    ),
    ...footer,
  );
}

/** git 分支(纯展示,best-effort):.git/HEAD 的 ref 短名;detached → 短 sha;非 git → undefined。 */
function readGitBranch(cwd: string): string | undefined {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    if (m) return m[1];
    return head.slice(0, 7);
  } catch {
    return undefined;
  }
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
