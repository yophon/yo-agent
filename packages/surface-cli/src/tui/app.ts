/**
 * Ink TUI 组装壳(DESIGN §7.2,4.6a 重构):交互式多轮 REPL。
 *
 * 分层:事件/交互 → UiState 的折叠在 model.ts(纯 reducer);按键 → 语义命令在 keymap.ts
 * (纯路由);区块渲染在 render/blocks.ts。本文件只做:订阅内核事件、执行命令副作用
 * (submitInput/steer/interrupt/decideApproval/exit)、摆放区块 + 状态栏 + 输入框/审批面板。
 *
 * dispatch 走「ref 镜像 + 纯 reduce」:同帧多次按键/事件在 useInput 闭包里能同步读到最新
 * 状态(useState 异步批处理读不到,4.5 已踩过)。
 *
 * 用 React.createElement 而非 JSX(免 tsconfig jsx 配置、保持全 .ts)。
 * CliApp 可被 ink-testing-library 离线冒烟;runTui 用 ink 真 render(需 TTY)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
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
}

export function CliApp(props: CliAppProps): React.ReactElement {
  const {
    kernel,
    sessionId,
    prompt,
    model = 'unknown',
    cwd = process.cwd(),
    permissionMode = 'supervised',
    autoExit = false,
  } = props;
  const { exit } = useApp();

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

  // ── 输入缓冲 + 光标(ref 镜像同理;4.6b 抽为多行 editor)────────────────
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef('');
  const cursorRef = useRef(0);
  const setBuf = (next: string, cur = next.length): void => {
    inputRef.current = next;
    cursorRef.current = Math.max(0, Math.min(cur, next.length));
    setInput(next);
    setCursor(cursorRef.current);
  };

  // 输入历史(仅记非 slash 的真实提问;4.6b 持久化)。
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(0);

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
    const text = inputRef.current.trim();
    setBuf('');
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
    historyRef.current.push(text);
    histIdxRef.current = historyRef.current.length;
    submit(text);
  }

  // ── 命令执行(keymap 路由结果 → 副作用)────────────────────────────────
  function execute(cmd: KeyCommand): void {
    const s = stateRef.current;
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
      case 'exit':
        exit();
        break;
      case 'submit':
        onSubmit();
        break;
      case 'clear-input':
        setBuf('');
        break;
      case 'cursor-home':
        setBuf(inputRef.current, 0);
        break;
      case 'cursor-end':
        setBuf(inputRef.current, inputRef.current.length);
        break;
      case 'cursor-left':
        setBuf(inputRef.current, cursorRef.current - 1);
        break;
      case 'cursor-right':
        setBuf(inputRef.current, cursorRef.current + 1);
        break;
      case 'history-prev': {
        const hist = historyRef.current;
        if (histIdxRef.current > 0) {
          histIdxRef.current -= 1;
          setBuf(hist[histIdxRef.current] ?? '');
        }
        break;
      }
      case 'history-next': {
        const hist = historyRef.current;
        if (histIdxRef.current < hist.length) {
          histIdxRef.current += 1;
          setBuf(histIdxRef.current < hist.length ? hist[histIdxRef.current]! : '');
        }
        break;
      }
      case 'backspace': {
        const cur = cursorRef.current;
        if (cur > 0) setBuf(inputRef.current.slice(0, cur - 1) + inputRef.current.slice(cur), cur - 1);
        break;
      }
      case 'insert': {
        const cur = cursorRef.current;
        setBuf(inputRef.current.slice(0, cur) + cmd.text + inputRef.current.slice(cur), cur + cmd.text.length);
        break;
      }
      default:
        break;
    }
  }

  useInput((ch, key) => {
    const s = stateRef.current;
    const cmd = routeKey(ch, key, { approvalOpen: s.approval !== null, running: s.running });
    if (cmd) execute(cmd);
  });

  // ── 渲染 ──────────────────────────────────────────────────────────────
  const u = {
    inTok: state.totals.inTok + state.liveUsage.inTok,
    outTok: state.totals.outTok + state.liveUsage.outTok,
    cacheTok: state.totals.cacheTok + state.liveUsage.cacheTok,
    costUsd: state.totals.costUsd + state.liveUsage.costUsd,
  };
  const bar = statusBar({ model, mode: permissionMode, ...u, cwd });

  let footer: React.ReactElement;
  if (state.approval) {
    const a = state.approval;
    footer = h(
      Box,
      { key: 'approval', flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: riskColor(a.risk), paddingX: 1 },
      h(Text, { key: 'hdr', color: riskColor(a.risk) }, `⚠ 审批请求:${a.tool}  [风险 ${a.risk}]  (↑↓ 选择,Enter 确认,Esc 拒绝)`),
      h(Text, { key: 'in', color: 'gray' }, `  ${summarizeInput(a.input)}`),
      ...a.suggestions.map((sug, i) =>
        h(Text, { key: sug.decision, color: i === a.selected ? 'green' : undefined }, `${i === a.selected ? '❯ ' : '  '}${sug.label ?? sug.decision}`),
      ),
    );
  } else if (state.running) {
    footer = h(Text, { key: 'busy', color: 'gray' }, `${SPINNER_FRAMES[spin]} 运行中…(Esc/Ctrl+C 中断,可直接输入引导后回车)`);
  } else {
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    footer = h(Text, { key: 'prompt' }, h(Text, { color: 'cyan' }, '› '), before, h(Text, { inverse: true }, after.slice(0, 1) || ' '), after.slice(1));
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { key: 'static', items: state.committed, children: (b: unknown) => renderBlock(b as Block) }),
    state.live.length ? h(Box, { key: 'live', flexDirection: 'column' }, ...state.live.map(renderBlock)) : null,
    h(Text, { key: 'bar', color: 'gray', dimColor: true }, bar),
    footer,
  );
}

/** 真 render(需 TTY)。headless / jsonl 模式不应走这里。 */
export async function runTui(props: CliAppProps): Promise<void> {
  const { render } = await import('ink');
  // exitOnCtrlC:false → Ctrl+C 交给组件(运行中中断当前轮,空闲才退出)。
  const instance = render(h(CliApp, props), { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
