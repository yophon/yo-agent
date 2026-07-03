/**
 * Ink TUI 组装壳(DESIGN §7.2;4.6a-e 增量交付,4.7a-d 架构收敛)。
 *
 * 分层:事件折叠与交互态在 model.ts(纯 reducer);raw chunk 解码在 input/decoder.ts;
 * 按键路由在 keymap.ts;命令执行在 execute.ts(app 构造 ExecuteCtx);多行编辑/粘贴折叠/
 * 历史/补全在 input/*;slash 注册表 commands.ts;对外契约 types.ts;渲染 render/*
 * (footer/审批面板/输入框已拆出)。本文件只做:状态装配、内核订阅、slash 依赖注入、布局摆放。
 *
 * dispatch 走「ref 镜像 + 纯 reduce」:同帧多次按键/事件在 useInput 闭包里能同步读到最新
 * 状态(useState 异步批处理读不到,4.5 已踩过)。组件本地态统一 useSyncedRef(4.7c)。
 * 用 React.createElement 而非 JSX(免 tsconfig jsx 配置、保持全 .ts)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Id, PermissionMode } from '@yo-agent/protocol';
import { statusBar } from '../tui-format';
import { initialState, reduce, type Block, type UiAction, type UiState } from './model';
import { routeKey } from './keymap';
import { BlockView, type RenderOpts } from './render/blocks';
import { renderFooter } from './render/footer';
import * as ed from './input/editor';
import { PersistentHistory } from './input/history';
import { InputDecoder } from './input/decoder';
import { expandPastes, foldPaste, newPasteStore } from './input/paste';
import { computeCompletion, listFiles, type Completion } from './input/completion';
import { applyMode, buildCommands, findCommand, type CommandDeps } from './commands';
import { createExecutor, type ExecuteCtx } from './execute';
import { useArmedConfirm, useSyncedRef } from './hooks';
import type { CliAppProps } from './types';

export type { CliAppProps, TuiKernel } from './types';

const h = React.createElement;

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
    replayOnMount = false,
  } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // ── 会话(/new /resume 可切换)+ 会话级模型/模式(K1/K2 可变)──────────
  const sidBox = useSyncedRef<Id>(sessionId);
  const [curModel, setCurModel] = useState(model);
  const modeBox = useSyncedRef<PermissionMode>(permissionMode);

  // 上下文占用(状态栏 ctx%)与 git 分支;每轮完成/压缩后刷新。
  const [ctx, setCtx] = useState<{ usedTokens: number; usableTokens: number } | null>(null);
  const [branch, setBranch] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 闭包经 sidBox.current 读最新会话,box 包装引用刻意不入依赖
  const refreshMeta = useCallback((): void => {
    try {
      const c = kernel.contextState?.(sidBox.current);
      if (c) setCtx(c);
    } catch {
      // 会话未知等瞬态错误忽略
    }
    setBranch(readGitBranch(cwd));
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

  // ── 编辑器(useSyncedRef:事件闭包读 .current,渲染读 .value)────────────
  const editorBox = useSyncedRef<ed.EditorState>(ed.EMPTY);

  // 输入历史(仅记非 slash 的真实提问;historyFile 注入时跨进程持久)。
  const historyRef = useRef<PersistentHistory | null>(null);
  historyRef.current ??= PersistentHistory.load(historyFile, cwd);
  const histIdxRef = useRef(historyRef.current.list().length);

  // 输入解码(4.7b):raw chunk → 语义事件(粘贴拦截/pty 切段收在 decoder);折叠登记表。
  const decoderRef = useRef(new InputDecoder());
  const pasteStoreRef = useRef(newPasteStore());

  // ── 补全(4.6d):候选由 editor 状态派生;选中/抑制在 reducer(4.7c)──────
  const commandsRef = useRef(buildCommands());
  const filesBox = useSyncedRef<string[] | null>(null);
  const filesLoadingRef = useRef(false);
  const lastTokenRef = useRef<string | null>(null);

  // 同一 (text, cursor, files, 抑制) 的补全在一次按键内会被路由/执行/渲染多处查询,缓存一份(4.7e)。
  const menuCacheRef = useRef<{
    text: string;
    cursor: number;
    files: string[] | null;
    suppressed: string | null;
    result: Completion | null;
  } | null>(null);
  const computeMenu = (edState: ed.EditorState): Completion | null => {
    const files = filesBox.current;
    const suppressed = stateRef.current.menu.suppressedToken;
    const c = menuCacheRef.current;
    if (c && c.text === edState.text && c.cursor === edState.cursor && c.files === files && c.suppressed === suppressed) {
      return c.result;
    }
    const comp = computeCompletion(edState.text, edState.cursor, {
      commands: commandsRef.current.map((cm) => ({ name: cm.name, desc: cm.desc })),
      files,
    });
    const result = comp && suppressed !== comp.token ? comp : null;
    menuCacheRef.current = { text: edState.text, cursor: edState.cursor, files, suppressed, result };
    return result;
  };
  const completion = computeMenu(editorBox.value);
  // token 变化 → 重置选中、解除抑制;触发文件清单懒加载。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 刻意只按 token/kind 触发;dispatch/box/fileLister 恒定,经闭包读
  useEffect(() => {
    const token = completion?.token ?? null;
    if (token !== lastTokenRef.current) {
      lastTokenRef.current = token;
      dispatch({ type: 'menu-select', index: 0 });
      if (token !== null) dispatch({ type: 'menu-suppress', token: null });
    }
    if (completion?.kind === 'file' && filesBox.current === null && !filesLoadingRef.current) {
      filesLoadingRef.current = true;
      void fileLister(cwd)
        .then((list) => filesBox.set(list))
        .catch(() => filesBox.set([])); // 有意降级:清单失败 → 空补全,不打扰输入流

    }
  }, [completion?.token, completion?.kind]);

  // 推理流显隐(/reasoning)/工具展开(Ctrl+O):只影响其后渲染,<Static> 已渲区块不回改。
  const reasoningBox = useSyncedRef(true);
  const verboseBox = useSyncedRef(false);

  // 审批 Esc 双击拒绝 / 退出双击确认(Ctrl+C/Ctrl+D,3 秒窗口)。
  const rejectConfirm = useArmedConfirm();
  const exitConfirm = useArmedConfirm();

  // 本轮起始时刻(活动行耗时,UI 本地时钟;spinner tick 在 footer 的 ActivityLine 自持,4.7e)。
  const runStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state.running) runStartedAtRef.current = null;
    else runStartedAtRef.current ??= Date.now();
  }, [state.running]);

  // ── 副作用:提交/订阅 ────────────────────────────────────────────────
  function submit(text: string): void {
    dispatch({ type: 'submit', text });
    void kernel.submitInput(sidBox.current, text, `tui-${Date.now()}`).catch((e) => {
      dispatch({ type: 'submit-failed', message: e instanceof Error ? e.message : String(e) });
    });
  }

  // 订阅当前会话事件;/new /resume 切换 sid 后自动重订阅。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只按 kernel/会话 id 重订阅;dispatch/refreshMeta 恒定
  useEffect(() => {
    return kernel.subscribe(sidBox.value, null, (env) => {
      dispatch({ type: 'event', event: env.event, ts: env.ts });
      if (env.event.kind === 'ContextCompacted') refreshMeta();
    });
  }, [kernel, sidBox.value]);

  // 历史回放(4.7f):恢复会话时把已落库事件折叠进区块(不再空屏)。
  // 已决审批的 ApprovalRequested 跳过(isApprovalPending 缺省一律跳);失败静默,仍可继续对话。
  const replaySession = useCallback(
    async (id: Id): Promise<void> => {
      if (!kernel.events?.read) return;
      try {
        for await (const env of kernel.events.read(id)) {
          if (env.event.kind === 'ApprovalRequested' && !(kernel.isApprovalPending?.(env.event.requestId) ?? false)) {
            continue;
          }
          dispatch({ type: 'event', event: env.event, ts: env.ts });
        }
      } catch {
        // 读库失败不阻断会话
      }
      dispatch({ type: 'replay-end' });
    },
    [kernel, dispatch],
  );

  // ctx% / git 分支:挂载 + 每轮完成后刷新。
  // biome-ignore lint/correctness/useExhaustiveDependencies: state.turns/sidBox.value 是刻意的触发信号,非闭包数据依赖
  useEffect(() => {
    refreshMeta();
  }, [refreshMeta, state.turns, sidBox.value]);

  // 排队 follow-up:正常完成(end_turn)后自动出队提交;中断/失败保留待手动。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只按轮次完成触发;queue/lastStop 经 stateRef 同帧读,submit 恒定
  useEffect(() => {
    const q = stateRef.current.queue;
    if (state.running || !q.length) return;
    if (state.lastStop !== 'end_turn') {
      if (state.lastStop) dispatch({ type: 'notice', tone: 'warn', text: `已排队 ${q.length} 条保留(↑ 取回或直接回车发送)` });
      return;
    }
    const next = q[0]!;
    dispatch({ type: 'queue-shift' });
    historyRef.current!.push(next);
    histIdxRef.current = historyRef.current!.list().length;
    submit(next);
  }, [state.running, state.turns]);

  // `yoagent --resume` 不带 id:挂载即打开会话选择器;`--resume <id>/last`:挂载即回放历史。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行一次,启动参数不随渲染变化
  useEffect(() => {
    if (openResumePicker) {
      const cmd = findCommand(commandsRef.current, '/resume');
      if (cmd) void cmd.run(commandDeps, '');
    } else if (replayOnMount) {
      void replaySession(sidBox.current);
    }
  }, []);

  // 初始 prompt 只在首个会话提交一次。
  const initRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 初始 prompt 仅挂载时提交一次,initRef 双保险
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    if (prompt.trim().length > 0) {
      dispatch({ type: 'submit', text: prompt });
      void kernel.submitInput(sidBox.current, prompt, `tui-${Date.now()}`).catch((e: unknown) => {
        dispatch({ type: 'submit-failed', message: e instanceof Error ? e.message : String(e) });
      });
    }
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
    sessionId: () => sidBox.current,
    model: curModel,
    mode: modeBox.value,
    cwd,
    getState: () => stateRef.current,
    notice: (tone, text) => dispatch({ type: 'notice', tone, text }),
    clear: () => dispatch({ type: 'clear' }),
    exit,
    openPicker: (p) => dispatch({ type: 'picker-open', picker: p }),
    setModelUi: (m) => setCurModel(m),
    setModeUi: (m) => modeBox.set(m),
    switchSession: (id) => {
      sidBox.set(id);
      dispatch({ type: 'clear' });
      void replaySession(id);
      refreshMeta();
    },
    newSession: kernel.startSession
      ? async () => {
          try {
            const next = await kernel.startSession!({ model: curModel, cwd, permissionMode: modeBox.current });
            sidBox.set(next);
            dispatch({ type: 'clear' });
            dispatch({ type: 'notice', tone: 'info', text: `已开新会话 ${String(next).slice(0, 8)}` });
          } catch (e) {
            dispatch({ type: 'notice', tone: 'error', text: `新会话失败:${e instanceof Error ? e.message : String(e)}` });
          }
        }
      : undefined,
    toggleReasoning: () => {
      reasoningBox.set(!reasoningBox.current);
      return reasoningBox.current;
    },
  };

  // ── 命令执行器(execute.ts;ctx 访问器保证同帧最新)──────────────────────
  const execCtx: ExecuteCtx = {
    kernel,
    dispatch,
    state: () => stateRef.current,
    editor: () => editorBox.current,
    setEditor: editorBox.set,
    sid: () => sidBox.current,
    mode: () => modeBox.current,
    applyMode: (m) => applyMode(commandDeps, m),
    runSlash: (name, args) => {
      const cmd = findCommand(commandsRef.current, name);
      if (!cmd) {
        dispatch({ type: 'notice', tone: 'warn', text: `未知命令:${name}(/help 看帮助)` });
        return;
      }
      void cmd.run(commandDeps, args);
    },
    submit,
    history: () => historyRef.current!,
    histIdx: histIdxRef,
    expandPastes: (text) => expandPastes(pasteStoreRef.current, text),
    computeMenu,
    toggleVerbose: () => verboseBox.set(!verboseBox.current),
    exit,
    exitConfirm,
    rejectConfirm,
  };
  const executor = createExecutor(execCtx);

  useInput((ch, key) => {
    // 解码(4.7b):粘贴拦截 / pty 合并 chunk 切段收在 decoder,这里只消费语义事件。
    for (const ev of decoderRef.current.feed(ch, key)) {
      if (ev.kind === 'paste') {
        editorBox.set(ed.insert(editorBox.current, foldPaste(pasteStoreRef.current, ed.sanitize(ev.text))));
        continue;
      }
      if (ev.kind === 'text') {
        executor.execute({ type: 'insert', text: ev.text });
        continue;
      }
      if (ev.kind === 'enter') {
        executor.execute({ type: 'submit' });
        continue;
      }
      const s = stateRef.current;
      const cur = editorBox.current;
      const menu = computeMenu(cur);
      const cmd = routeKey(ev.ch, ev.key, {
        approvalOpen: s.approval !== null,
        pickerOpen: s.picker !== null,
        menuOpen: menu !== null && menu.items.length > 0,
        guideActive: s.pendingGuide !== null,
        running: s.running,
        bufferEmpty: cur.text.length === 0,
        cursorAtFirstRow: ed.cursorRow(cur) === 0,
        cursorAtLastRow: ed.cursorRow(cur) === ed.rowCount(cur) - 1,
      });
      if (cmd) {
        // 任何非退出键都解除退出确认态。
        if (cmd.type !== 'exit-request') exitConfirm.disarm();
        executor.execute(cmd);
      }
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
  const bar = statusBar({ model: curModel, mode: modeBox.value, ...u, cwd, ctxLeftPct, branch });

  const footer = renderFooter({
    state,
    editor: editorBox.value,
    columns,
    completion,
    filesLoading: completion?.kind === 'file' && filesBox.value === null,
    exitArmed: exitConfirm.armed,
    rejectArmed: rejectConfirm.armed,
    runStartedAt: runStartedAtRef.current,
  });

  const renderOpts: RenderOpts = { width: columns, verbose: verboseBox.value };
  const liveBlocks = reasoningBox.value ? state.live : state.live.filter((b) => b.kind !== 'reasoning');
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, {
      key: 'static',
      items: state.committed,
      children: (b: unknown) => h(BlockView, { key: (b as Block).id, block: b as Block, opts: renderOpts }),
    }),
    liveBlocks.length
      ? h(Box, { key: 'live', flexDirection: 'column' }, ...liveBlocks.map((b) => h(BlockView, { key: b.id, block: b, opts: renderOpts })))
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
