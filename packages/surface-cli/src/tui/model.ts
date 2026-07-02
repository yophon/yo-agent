/**
 * TUI 状态模型(4.6a):AgentEvent / 本地交互 → UiState 的纯 reducer。
 * ink 组件只订阅 state 渲染;事件折叠逻辑全部在此,可离线单测。
 *
 * 区块生命周期:live(当前轮流式,动态区重绘)→ 轮结束 flush 进 committed(落 <Static> 滚动区,
 * 只渲一次)。committed 仅追加(/clear 例外:整体重置,Static 已渲部分不可回收,固有语义)。
 */
import type {
  AgentEvent,
  ApprovalSuggestion,
  Id,
  RiskLevel,
} from '@yo-agent/protocol';
import { fmtInt, type Tone } from '../tui-format';

// ── 区块 ─────────────────────────────────────────────────────────────────
export type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool';
      id: string; // = ToolCallStarted.id(关联 Output/Completed)
      name: string;
      summary: string;
      input: unknown;
      output: string;
      status?: 'ok' | 'error';
      exitCode?: number;
      truncatedToPath?: string;
    }
  | { kind: 'notice'; id: string; tone: Tone; text: string };

export interface ApprovalView {
  requestId: Id;
  tool: string;
  input: unknown;
  risk: RiskLevel;
  suggestions: ApprovalSuggestion[];
  selected: number;
}

export interface UsageTotals {
  inTok: number;
  outTok: number;
  cacheTok: number;
  costUsd: number;
}

const ZERO_USAGE: UsageTotals = { inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0 };

export interface UiState {
  committed: Block[];
  live: Block[];
  running: boolean;
  /** 已完成轮数(含失败/中断),autoExit 判据。 */
  turns: number;
  approval: ApprovalView | null;
  /** 已完成轮累计用量。 */
  totals: UsageTotals;
  /** 本轮实时用量(UsageUpdate),轮结束清零并入 totals。 */
  liveUsage: UsageTotals;
  /** 区块 id 发号器。 */
  seq: number;
}

export const DEFAULT_SUGGESTIONS: ApprovalSuggestion[] = [
  { decision: 'allow_once', label: '允许一次' },
  { decision: 'allow_always', label: '总是允许' },
  { decision: 'reject_once', label: '拒绝一次' },
  { decision: 'reject_always', label: '总是拒绝' },
];

export interface InitialStateOpts {
  banner: string;
  /** 带初始 prompt 启动 → 直接处于运行态。 */
  running?: boolean;
}

export function initialState(opts: InitialStateOpts): UiState {
  return {
    committed: [{ kind: 'notice', id: 'banner', tone: 'dim', text: opts.banner }],
    live: [],
    running: opts.running ?? false,
    turns: 0,
    approval: null,
    totals: ZERO_USAGE,
    liveUsage: ZERO_USAGE,
    seq: 0,
  };
}

// ── 动作 ─────────────────────────────────────────────────────────────────
export type UiAction =
  | { type: 'event'; event: AgentEvent }
  /** 用户提交一轮(user 区块 + 进入运行态)。 */
  | { type: 'submit'; text: string }
  | { type: 'submit-failed'; message: string }
  /** slash 命令等产生的即时通知(直接进 committed)。 */
  | { type: 'notice'; tone: Tone; text: string }
  | { type: 'clear' }
  /** 运行中 steer 的回显(live dim 行)。 */
  | { type: 'steer'; text: string }
  | { type: 'approval-move'; delta: 1 | -1 }
  | { type: 'approval-clear' };

// ── 内部助手(全部返回新对象,state 不就地改)─────────────────────────────
function nextId(s: UiState): [string, UiState] {
  const seq = s.seq + 1;
  return ['b' + seq, { ...s, seq }];
}

/** Omit 在联合类型上需逐成员分配,否则塌缩为公共字段。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function pushLive(s: UiState, block: DistributiveOmit<Block, 'id'>): UiState {
  const [id, s2] = nextId(s);
  return { ...s2, live: [...s2.live, { id, ...block } as Block] };
}

function pushCommitted(s: UiState, tone: Tone, text: string): UiState {
  const [id, s2] = nextId(s);
  return { ...s2, committed: [...s2.committed, { kind: 'notice', id, tone, text }] };
}

/** 流式增量:并入最后一个同类 live 区块,否则新开。 */
function appendStream(s: UiState, kind: 'assistant' | 'reasoning', delta: string): UiState {
  const last = s.live.at(-1);
  if (last && last.kind === kind) {
    const merged = { ...last, text: last.text + delta };
    return { ...s, live: [...s.live.slice(0, -1), merged] };
  }
  return pushLive(s, { kind, text: delta });
}

function patchTool(s: UiState, id: string, patch: (t: Extract<Block, { kind: 'tool' }>) => Block): UiState {
  const live = s.live.map((b) => (b.kind === 'tool' && b.id === id ? patch(b) : b));
  return { ...s, live };
}

/** live 全部落 committed(轮结束/失败)。 */
function flushLive(s: UiState): UiState {
  if (!s.live.length) return s;
  return { ...s, committed: [...s.committed, ...s.live], live: [] };
}

// ── reducer ──────────────────────────────────────────────────────────────
export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'submit': {
      const [id, s] = nextId(state);
      return {
        ...s,
        committed: [...s.committed, { kind: 'user', id, text: action.text }],
        running: true,
      };
    }
    case 'submit-failed':
      return { ...pushCommitted(state, 'error', `提交失败:${action.message}`), running: false };
    case 'notice':
      return pushCommitted(state, action.tone, action.text);
    case 'clear':
      return { ...state, committed: [], live: [] };
    case 'steer':
      return pushLive(state, { kind: 'notice', tone: 'dim', text: `↳ 引导:${action.text}` });
    case 'approval-move': {
      if (!state.approval) return state;
      const n = state.approval.suggestions.length;
      const selected = (state.approval.selected + action.delta + n) % n;
      return { ...state, approval: { ...state.approval, selected } };
    }
    case 'approval-clear':
      return { ...state, approval: null };
    case 'event':
      return reduceEvent(state, action.event);
    default:
      return state;
  }
}

function reduceEvent(state: UiState, e: AgentEvent): UiState {
  switch (e.kind) {
    case 'AssistantText':
      return e.delta ? appendStream(state, 'assistant', e.delta) : state;
    case 'Reasoning':
      return e.delta ? appendStream(state, 'reasoning', e.delta) : state;
    case 'ToolCallStarted':
      return {
        ...state,
        live: [
          ...state.live,
          { kind: 'tool', id: e.id, name: e.name, summary: e.summary, input: e.input, output: '' },
        ],
      };
    case 'ToolCallOutput':
      return patchTool(state, e.id, (t) => ({
        ...t,
        output: t.output + e.chunk,
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
      }));
    case 'ToolCallCompleted':
      return patchTool(state, e.id, (t) => ({ ...t, status: e.status, truncatedToPath: e.truncatedToPath }));
    case 'ApprovalRequested':
      return {
        ...state,
        approval: {
          requestId: e.requestId,
          tool: e.tool,
          input: e.input,
          risk: e.risk,
          suggestions: e.suggestions.length ? e.suggestions : DEFAULT_SUGGESTIONS,
          selected: 0,
        },
      };
    case 'ContextCompacted':
      return pushLive(state, { kind: 'notice', tone: 'info', text: `上下文压缩:省 ${fmtInt(e.tokensSaved)} tokens` });
    case 'McpServerStatus':
      return pushLive(state, { kind: 'notice', tone: 'dim', text: `[mcp] ${e.server} → ${e.status}` });
    case 'SubagentStarted':
      return pushLive(state, { kind: 'notice', tone: 'dim', text: `↳ 子 agent 启动:${e.label}(${e.model})` });
    case 'SubagentResult':
      return pushLive(state, { kind: 'notice', tone: 'dim', text: `↳ 子 agent 完成:${e.summary}` });
    case 'ApiRetry':
      return pushLive(state, {
        kind: 'notice',
        tone: 'warn',
        text: `API 重试 ${e.attempt}/${e.maxRetries}${e.error ? `(${e.error})` : ''}`,
      });
    case 'FileChanged':
      return pushLive(state, { kind: 'notice', tone: 'dim', text: `${e.changeKind} ${e.path}` });
    case 'Error':
      return pushLive(state, { kind: 'notice', tone: 'error', text: `错误:${e.message}` });
    case 'UsageUpdate':
      return {
        ...state,
        liveUsage: {
          inTok: e.inputTokens,
          outTok: e.outputTokens,
          cacheTok: e.cacheReadTokens,
          costUsd: e.costUsd ?? 0,
        },
      };
    case 'TurnCompleted': {
      const u = e.usage;
      const totals: UsageTotals = {
        inTok: state.totals.inTok + u.inputTokens,
        outTok: state.totals.outTok + u.outputTokens,
        cacheTok: state.totals.cacheTok + u.cacheReadTokens,
        costUsd: state.totals.costUsd + (u.costUsd ?? e.costUsd ?? 0),
      };
      const flushed = flushLive({ ...state, totals, liveUsage: ZERO_USAGE });
      const done = pushCommitted(
        flushed,
        e.stopReason === 'interrupted' ? 'warn' : 'success',
        `完成 · ${e.stopReason}`,
      );
      return { ...done, running: false, turns: done.turns + 1 };
    }
    case 'TurnFailed': {
      const flushed = flushLive(state);
      const done = pushCommitted(flushed, 'error', `失败:${e.error.message}`);
      return { ...done, running: false, turns: done.turns + 1 };
    }
    // 4.6a 行为等价:以下事件暂不渲染(4.6c 起接管 Todo/Plan/BackgroundProcess)。
    case 'SessionStarted':
    case 'TurnStarted':
    case 'Todo':
    case 'Plan':
    case 'BackgroundProcess':
      return state;
    default:
      return state;
  }
}
