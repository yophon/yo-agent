/**
 * Ink TUI（DESIGN §7.2，Phase 4.5 完整化）：交互式多轮 REPL。
 *
 * 渲染模型：结构化区块（user / assistant / reasoning / tool / notice）。已完成区块进 ink <Static>
 * （只渲一次、落滚动区，不随每帧重绘）；当前轮的流式区块在动态区实时刷新。底部状态栏（model/模式/
 * 累计 token/成本/cwd）+ 输入框（光标编辑 + 历史）或审批面板。
 *
 * 交互：Enter 发送；运行中 Enter → steer（轮内追加引导）；Esc/Ctrl+C 中断当前轮（空闲时退出）；
 * ↑↓ 输入历史；←→ / Ctrl+A/E 移动光标；Ctrl+U 清空；/help /clear /model /cwd /exit 等 slash 命令。
 *
 * 用 React.createElement 而非 JSX（免 tsconfig jsx 配置、保持全 .ts）。
 * CliApp 可被 ink-testing-library 离线冒烟；runTui 用 ink 真 render（需 TTY）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import type {
  ApprovalDecision,
  ApprovalSuggestion,
  EventEnvelope,
  Id,
  PermissionMode,
  RiskLevel,
} from '@yo-agent/protocol';
import {
  SLASH_HELP,
  SPINNER_FRAMES,
  fmtInt,
  parseSlash,
  previewOutput,
  riskColor,
  statusBar,
  summarizeInput,
  toolIcon,
  type Tone,
} from './tui-format';

const h = React.createElement;

/** CliApp 仅依赖内核的这几个方法。interrupt/steer/listModels 可选（FakeKernel 测试免实现）。 */
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
  /** 初始提问。空串 → 直接进输入态等待用户键入（交互式 REPL）。 */
  prompt: string;
  /** 状态栏展示用（不影响内核行为）。 */
  model?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  /** true：首轮完成即退出（单次模式 / 测试）。默认 false：多轮 REPL，持续到 /exit 或 Ctrl+C。 */
  autoExit?: boolean;
}

// ── 区块模型 ─────────────────────────────────────────────────────────────
type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool';
      id: string; // = ToolCallStarted.id（关联 Output/Completed）
      name: string;
      summary: string;
      input: unknown;
      output: string;
      status?: 'ok' | 'error';
      exitCode?: number;
      truncatedToPath?: string;
    }
  | { kind: 'notice'; id: string; tone: Tone; text: string };

interface ApprovalView {
  requestId: Id;
  tool: string;
  input: unknown;
  risk: RiskLevel;
  suggestions: ApprovalSuggestion[];
}

const DEFAULT_SUGGESTIONS: ApprovalSuggestion[] = [
  { decision: 'allow_once', label: '允许一次' },
  { decision: 'allow_always', label: '总是允许' },
  { decision: 'reject_once', label: '拒绝一次' },
  { decision: 'reject_always', label: '总是拒绝' },
];

const TONE_COLOR: Record<Tone, string | undefined> = {
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
  dim: 'gray',
  success: 'green',
};

export function CliApp(props: CliAppProps): React.ReactElement {
  const { kernel, sessionId, prompt, model = 'unknown', cwd = process.cwd(), permissionMode = 'supervised', autoExit = false } = props;
  const { exit } = useApp();

  // committed：已完成区块（进 <Static>）；live：当前轮在途区块（动态区重绘）。
  const [committed, setCommitted] = useState<Block[]>(() => [
    { kind: 'notice', id: 'banner', tone: 'dim', text: `yo-agent · ${model} · ${cwd}\n输入消息回车发送；/help 查看命令；Esc/Ctrl+C 中断；/exit 退出` },
  ]);
  const [live, setLive] = useState<Block[]>([]);
  const liveRef = useRef<Block[]>([]);
  const idRef = useRef(0);
  const nextId = (): string => 'b' + ++idRef.current;

  const [running, setRunning] = useState(prompt.trim().length > 0);
  const runningRef = useRef(running);
  const [turns, setTurns] = useState(0);
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [selected, setSelected] = useState(0);

  // 用量：committed 累计（每轮 TurnCompleted 累加）+ 本轮实时（UsageUpdate）。
  const [totals, setTotals] = useState({ inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0 });
  const [liveUsage, setLiveUsage] = useState({ inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0 });

  // 输入缓冲 + 光标（ref 镜像：useInput 闭包跨同帧多次按键读不到最新 state）。
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

  // 输入历史（仅记非 slash 的真实提问）。
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(0);

  // spinner 动画帧。
  const [spin, setSpin] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [running]);

  const pushLive = (b: Block): void => {
    liveRef.current = [...liveRef.current, b];
    setLive(liveRef.current);
  };
  const commitNotice = (tone: Tone, text: string): void => setCommitted((c) => [...c, { kind: 'notice', id: nextId(), tone, text }]);

  // 把当前 live 区块刷入 committed（轮结束 / 中断时）。
  const flushLive = (): void => {
    const pending = liveRef.current;
    liveRef.current = [];
    setLive([]);
    if (pending.length) setCommitted((c) => [...c, ...pending]);
  };

  function submit(text: string): void {
    setCommitted((c) => [...c, { kind: 'user', id: nextId(), text }]);
    setRunning(true);
    runningRef.current = true;
    void kernel.submitInput(sessionId, text, `tui-${Date.now()}`).catch((e) => {
      commitNotice('error', `提交失败：${e instanceof Error ? e.message : String(e)}`);
      setRunning(false);
      runningRef.current = false;
    });
  }

  useEffect(() => {
    const unsub = kernel.subscribe(sessionId, null, (env) => {
      const e = env.event;
      switch (e.kind) {
        case 'AssistantText': {
          if (!e.delta) break;
          const last = liveRef.current.at(-1);
          if (last?.kind === 'assistant') {
            last.text += e.delta;
            setLive([...liveRef.current]);
          } else {
            pushLive({ kind: 'assistant', id: nextId(), text: e.delta });
          }
          break;
        }
        case 'Reasoning': {
          if (!e.delta) break;
          const last = liveRef.current.at(-1);
          if (last?.kind === 'reasoning') {
            last.text += e.delta;
            setLive([...liveRef.current]);
          } else {
            pushLive({ kind: 'reasoning', id: nextId(), text: e.delta });
          }
          break;
        }
        case 'ToolCallStarted':
          pushLive({ kind: 'tool', id: e.id, name: e.name, summary: e.summary, input: e.input, output: '' });
          break;
        case 'ToolCallOutput': {
          const blk = liveRef.current.find((b) => b.kind === 'tool' && b.id === e.id);
          if (blk && blk.kind === 'tool') {
            blk.output += e.chunk;
            if (e.exitCode !== undefined) blk.exitCode = e.exitCode;
            setLive([...liveRef.current]);
          }
          break;
        }
        case 'ToolCallCompleted': {
          const blk = liveRef.current.find((b) => b.kind === 'tool' && b.id === e.id);
          if (blk && blk.kind === 'tool') {
            blk.status = e.status;
            blk.truncatedToPath = e.truncatedToPath;
            setLive([...liveRef.current]);
          }
          break;
        }
        case 'ApprovalRequested':
          setSelected(0);
          setApproval({
            requestId: e.requestId,
            tool: e.tool,
            input: e.input,
            risk: e.risk,
            suggestions: e.suggestions.length ? e.suggestions : DEFAULT_SUGGESTIONS,
          });
          break;
        case 'ContextCompacted':
          pushLive({ kind: 'notice', id: nextId(), tone: 'info', text: `上下文压缩：省 ${fmtInt(e.tokensSaved)} tokens` });
          break;
        case 'McpServerStatus':
          pushLive({ kind: 'notice', id: nextId(), tone: 'dim', text: `[mcp] ${e.server} → ${e.status}` });
          break;
        case 'SubagentStarted':
          pushLive({ kind: 'notice', id: nextId(), tone: 'dim', text: `↳ 子 agent 启动：${e.label}（${e.model}）` });
          break;
        case 'SubagentResult':
          pushLive({ kind: 'notice', id: nextId(), tone: 'dim', text: `↳ 子 agent 完成：${e.summary}` });
          break;
        case 'ApiRetry':
          pushLive({ kind: 'notice', id: nextId(), tone: 'warn', text: `API 重试 ${e.attempt}/${e.maxRetries}${e.error ? `（${e.error}）` : ''}` });
          break;
        case 'FileChanged':
          pushLive({ kind: 'notice', id: nextId(), tone: 'dim', text: `${e.changeKind} ${e.path}` });
          break;
        case 'Error':
          pushLive({ kind: 'notice', id: nextId(), tone: 'error', text: `错误：${e.message}` });
          break;
        case 'UsageUpdate':
          setLiveUsage({ inTok: e.inputTokens, outTok: e.outputTokens, cacheTok: e.cacheReadTokens, costUsd: e.costUsd ?? 0 });
          break;
        case 'TurnCompleted': {
          const u = e.usage;
          setTotals((t) => ({
            inTok: t.inTok + u.inputTokens,
            outTok: t.outTok + u.outputTokens,
            cacheTok: t.cacheTok + u.cacheReadTokens,
            costUsd: t.costUsd + (u.costUsd ?? e.costUsd ?? 0),
          }));
          setLiveUsage({ inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0 });
          flushLive();
          commitNotice(e.stopReason === 'interrupted' ? 'warn' : 'success', `完成 · ${e.stopReason}`);
          setRunning(false);
          runningRef.current = false;
          setTurns((n) => n + 1);
          break;
        }
        case 'TurnFailed':
          flushLive();
          commitNotice('error', `失败：${e.error.message}`);
          setRunning(false);
          runningRef.current = false;
          setTurns((n) => n + 1);
          break;
        default:
          break;
      }
    });
    if (prompt.trim().length > 0) {
      setCommitted((c) => [...c, { kind: 'user', id: nextId(), text: prompt }]);
      void kernel.submitInput(sessionId, prompt, `tui-${Date.now()}`).catch(() => {});
    }
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel, sessionId, prompt]);

  // 单次模式（autoExit）：首轮完成即退出。REPL 模式（默认）回到输入态。
  useEffect(() => {
    if (autoExit && turns > 0) {
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [autoExit, turns, exit]);

  function runSlash(cmd: string): void {
    switch (cmd) {
      case '/exit':
      case '/quit':
        exit();
        break;
      case '/help':
        commitNotice('info', SLASH_HELP);
        break;
      case '/clear':
        setCommitted([]);
        break;
      case '/cwd':
        commitNotice('info', `cwd: ${cwd}`);
        break;
      case '/model': {
        commitNotice('info', `当前模型：${model}`);
        void kernel
          .listModels?.()
          .then((ms) => {
            const names = ms.map((m) => m.id ?? m.name ?? '').filter(Boolean);
            if (names.length) commitNotice('info', `可用模型：${names.join(', ')}`);
          })
          .catch(() => {});
        break;
      }
      default:
        commitNotice('warn', `未知命令：${cmd}（/help 看帮助）`);
    }
  }

  function onEnter(): void {
    const text = inputRef.current.trim();
    setBuf('');
    if (!text) return;
    const slash = parseSlash(text);
    if (slash) {
      runSlash(slash);
      return;
    }
    if (runningRef.current) {
      // 运行中：作为 steer 注入当前轮。
      if (kernel.steer) {
        void kernel.steer(sessionId, text).catch(() => {});
        pushLive({ kind: 'notice', id: nextId(), tone: 'dim', text: `↳ 引导：${text}` });
      }
      return;
    }
    historyRef.current.push(text);
    histIdxRef.current = historyRef.current.length;
    submit(text);
  }

  useInput((ch, key) => {
    // ① 审批优先：方向键/回车裁决，吞掉其余输入。
    if (approval) {
      const n = approval.suggestions.length;
      if (key.upArrow) setSelected((s) => (s + n - 1) % n);
      else if (key.downArrow) setSelected((s) => (s + 1) % n);
      else if (key.return) {
        kernel.decideApproval(approval.requestId, approval.suggestions[selected]!.decision);
        setApproval(null);
      } else if (key.escape) {
        kernel.decideApproval(approval.requestId, 'reject_once');
        setApproval(null);
      }
      return;
    }

    // ② Ctrl+C / Esc：运行中中断当前轮；空闲时 Ctrl+C 退出、Esc 清空输入。
    if (key.ctrl && ch === 'c') {
      if (runningRef.current) void kernel.interrupt?.(sessionId).catch(() => {});
      else exit();
      return;
    }
    if (key.escape) {
      if (runningRef.current) void kernel.interrupt?.(sessionId).catch(() => {});
      else setBuf('');
      return;
    }

    // ③ 回车：发送 / slash / steer。
    if (key.return) {
      onEnter();
      return;
    }

    // ④ 行内编辑快捷键。
    if (key.ctrl && ch === 'a') return setBuf(inputRef.current, 0);
    if (key.ctrl && ch === 'e') return setBuf(inputRef.current, inputRef.current.length);
    if (key.ctrl && ch === 'u') return setBuf('');
    if (key.leftArrow) return setBuf(inputRef.current, cursorRef.current - 1);
    if (key.rightArrow) return setBuf(inputRef.current, cursorRef.current + 1);

    // ⑤ 历史（↑↓）。
    if (key.upArrow) {
      const hist = historyRef.current;
      if (histIdxRef.current > 0) {
        histIdxRef.current -= 1;
        setBuf(hist[histIdxRef.current] ?? '');
      }
      return;
    }
    if (key.downArrow) {
      const hist = historyRef.current;
      if (histIdxRef.current < hist.length) {
        histIdxRef.current += 1;
        setBuf(histIdxRef.current < hist.length ? hist[histIdxRef.current]! : '');
      }
      return;
    }

    // ⑥ 退格 / 删除：删光标前一字符（兼顾两种终端键位）。
    if (key.backspace || key.delete) {
      const cur = cursorRef.current;
      if (cur > 0) setBuf(inputRef.current.slice(0, cur - 1) + inputRef.current.slice(cur), cur - 1);
      return;
    }

    // ⑦ 普通可见字符：在光标处插入。
    if (ch && !key.ctrl && !key.meta) {
      const cur = cursorRef.current;
      setBuf(inputRef.current.slice(0, cur) + ch + inputRef.current.slice(cur), cur + ch.length);
    }
  });

  // ── 渲染 ──────────────────────────────────────────────────────────────
  const u = {
    inTok: totals.inTok + liveUsage.inTok,
    outTok: totals.outTok + liveUsage.outTok,
    cacheTok: totals.cacheTok + liveUsage.cacheTok,
    costUsd: totals.costUsd + liveUsage.costUsd,
  };
  const bar = statusBar({ model, mode: permissionMode, ...u, cwd });

  const dynamic: React.ReactElement[] = live.map(renderBlock);

  let footer: React.ReactElement;
  if (approval) {
    footer = h(
      Box,
      { key: 'approval', flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: riskColor(approval.risk), paddingX: 1 },
      h(Text, { key: 'hdr', color: riskColor(approval.risk) }, `⚠ 审批请求：${approval.tool}  [风险 ${approval.risk}]  (↑↓ 选择，Enter 确认，Esc 拒绝)`),
      h(Text, { key: 'in', color: 'gray' }, `  ${summarizeInput(approval.input)}`),
      ...approval.suggestions.map((sug, i) =>
        h(Text, { key: sug.decision, color: i === selected ? 'green' : undefined }, `${i === selected ? '❯ ' : '  '}${sug.label ?? sug.decision}`),
      ),
    );
  } else if (running) {
    footer = h(Text, { key: 'busy', color: 'gray' }, `${SPINNER_FRAMES[spin]} 运行中…（Esc/Ctrl+C 中断，可直接输入引导后回车）`);
  } else {
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    footer = h(Text, { key: 'prompt' }, h(Text, { color: 'cyan' }, '› '), before, h(Text, { inverse: true }, after.slice(0, 1) || ' '), after.slice(1));
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { key: 'static', items: committed, children: (b: unknown) => renderBlock(b as Block) }),
    dynamic.length ? h(Box, { key: 'live', flexDirection: 'column' }, ...dynamic) : null,
    h(Text, { key: 'bar', color: 'gray', dimColor: true }, bar),
    footer,
  );
}

/** 单个区块 → React 元素（committed/live 共用）。 */
function renderBlock(b: Block): React.ReactElement {
  switch (b.kind) {
    case 'user':
      return h(Text, { key: b.id, color: 'cyan' }, `› ${b.text}`);
    case 'assistant':
      return h(Text, { key: b.id }, b.text);
    case 'reasoning':
      return h(Text, { key: b.id, color: 'gray', dimColor: true }, `💭 ${b.text}`);
    case 'notice':
      return h(Text, { key: b.id, color: TONE_COLOR[b.tone], dimColor: b.tone === 'dim' }, b.text);
    case 'tool': {
      const head = `${toolIcon(b.status)} ${b.name}${b.summary ? ` · ${b.summary}` : ''}`;
      const headColor = b.status === 'error' ? 'red' : b.status === 'ok' ? 'green' : 'yellow';
      const lines = previewOutput(b.output);
      const children: React.ReactElement[] = [h(Text, { key: 'h', color: headColor }, head)];
      for (let i = 0; i < lines.length; i++) {
        children.push(h(Text, { key: 'o' + i, color: 'gray', dimColor: true }, `  ${lines[i]}`));
      }
      if (b.truncatedToPath) children.push(h(Text, { key: 't', color: 'gray', dimColor: true }, `  …输出已截断，完整见 ${b.truncatedToPath}`));
      return h(Box, { key: b.id, flexDirection: 'column' }, ...children);
    }
    default:
      return h(Text, { key: 'x' }, '');
  }
}

/** 真 render（需 TTY）。headless / jsonl 模式不应走这里。 */
export async function runTui(props: CliAppProps): Promise<void> {
  const { render } = await import('ink');
  // exitOnCtrlC:false → Ctrl+C 交给组件（运行中中断当前轮，空闲才退出）。
  const instance = render(h(CliApp, props), { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
