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
  PlanStep,
  RiskLevel,
  TodoItem,
} from '@yo-agent/protocol';
import { fmtCost, fmtInt, type Tone } from '../tui-format';

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
  | { kind: 'todo'; id: string; items: TodoItem[] }
  | { kind: 'plan'; id: string; steps: PlanStep[] }
  | { kind: 'subagent'; id: string; childId: string; label: string; model: string; summary?: string }
  | { kind: 'notice'; id: string; tone: Tone; text: string };

export interface ApprovalView {
  requestId: Id;
  tool: string;
  input: unknown;
  risk: RiskLevel;
  suggestions: ApprovalSuggestion[];
  selected: number;
  /** 末尾合成「拒绝并告诉它该怎么做…」选项(4.6e;index = suggestions.length)。 */
  withGuide: boolean;
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
  /** 活动行动作词(4.6c):思考中 / 读取 x / 执行 y / 等待审批。 */
  activity: string;
  /** 每轮用量流水(/cost)。 */
  costLog: UsageTotals[];
  /** MCP server 连接状态快照(/mcp)。 */
  mcpStatus: Record<string, { status: string; toolCount?: number; error?: string }>;
  /** 本轮 TurnStarted 的事件时戳(轮摘要算耗时;server-time 基准)。 */
  turnStartedTs: number | null;
  /** 最近一轮的结束方式(排队 follow-up 只在正常完成后自动发送)。 */
  lastStop: string | null;
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
    activity: '思考中',
    costLog: [],
    mcpStatus: {},
    turnStartedTs: null,
    lastStop: null,
  };
}

// ── 动作 ─────────────────────────────────────────────────────────────────
export type UiAction =
  | { type: 'event'; event: AgentEvent; ts?: number }
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
      const n = state.approval.suggestions.length + (state.approval.withGuide ? 1 : 0);
      const selected = (state.approval.selected + action.delta + n) % n;
      return { ...state, approval: { ...state.approval, selected } };
    }
    case 'approval-clear':
      return { ...state, approval: null };
    case 'event':
      return reduceEvent(state, action.event, action.ts);
    default:
      return state;
  }
}

/** ToolCallStarted → 活动行动作词。 */
const KIND_VERB: Record<string, string> = {
  read: '读取',
  edit: '修改',
  execute: '执行',
  search: '检索',
  fetch: '抓取',
  think: '思考',
  other: '调用',
};

function activityFor(name: string, toolKind: string, summary: string): string {
  const verb = KIND_VERB[toolKind] ?? '调用';
  const target = (summary || name).split('\n')[0] ?? '';
  return `${verb} ${target.length > 40 ? target.slice(0, 39) + '…' : target}`;
}

function reduceEvent(state: UiState, e: AgentEvent, ts?: number): UiState {
  switch (e.kind) {
    case 'TurnStarted':
      return { ...state, turnStartedTs: ts ?? null, activity: '思考中' };
    case 'AssistantText':
      return e.delta ? { ...appendStream(state, 'assistant', e.delta), activity: '回复中' } : state;
    case 'Reasoning':
      return e.delta ? { ...appendStream(state, 'reasoning', e.delta), activity: '思考中' } : state;
    case 'ToolCallStarted':
      return {
        ...state,
        activity: activityFor(e.name, e.toolKind, e.summary),
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
        activity: '等待审批',
        approval: {
          requestId: e.requestId,
          tool: e.tool,
          input: e.input,
          risk: e.risk,
          suggestions: e.suggestions.length ? e.suggestions : DEFAULT_SUGGESTIONS,
          selected: 0,
          withGuide: true,
        },
      };
    case 'ContextCompacted':
      return pushLive(state, { kind: 'notice', tone: 'info', text: `上下文压缩:省 ${fmtInt(e.tokensSaved)} tokens` });
    case 'McpServerStatus':
      return pushLive(
        {
          ...state,
          mcpStatus: {
            ...state.mcpStatus,
            [e.server]: { status: e.status, toolCount: e.toolCount, error: e.error },
          },
        },
        { kind: 'notice', tone: 'dim', text: `[mcp] ${e.server} → ${e.status}` },
      );
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
    case 'Todo':
      return upsertByKind(state, 'todo', (id) => ({ kind: 'todo', id, items: e.items }));
    case 'Plan':
      return upsertByKind(state, 'plan', (id) => ({ kind: 'plan', id, steps: e.steps }));
    case 'SubagentStarted':
      return pushLive(state, { kind: 'subagent', childId: e.childSessionId, label: e.label, model: e.model });
    case 'SubagentResult': {
      let found = false;
      const live = state.live.map((b) => {
        if (b.kind === 'subagent' && b.childId === e.childSessionId) {
          found = true;
          return { ...b, summary: e.summary };
        }
        return b;
      });
      if (found) return { ...state, live };
      return pushLive(state, { kind: 'notice', tone: 'dim', text: `↳ 子 agent 完成:${e.summary}` });
    }
    case 'BackgroundProcess':
      return pushLive(state, {
        kind: 'notice',
        tone: 'dim',
        text: `⚙ ${e.label}:${e.status}${e.exitCode !== undefined ? `(exit ${e.exitCode})` : ''}`,
      });
    case 'TurnCompleted': {
      const u = e.usage;
      const totals: UsageTotals = {
        inTok: state.totals.inTok + u.inputTokens,
        outTok: state.totals.outTok + u.outputTokens,
        cacheTok: state.totals.cacheTok + u.cacheReadTokens,
        costUsd: state.totals.costUsd + (u.costUsd ?? e.costUsd ?? 0),
      };
      const turnUsage: UsageTotals = {
        inTok: u.inputTokens,
        outTok: u.outputTokens,
        cacheTok: u.cacheReadTokens,
        costUsd: u.costUsd ?? e.costUsd ?? 0,
      };
      const flushed = flushLive({ ...state, totals, liveUsage: ZERO_USAGE, costLog: [...state.costLog, turnUsage] });
      // 去噪(4.6c):正常完成只留一条 dim 轮摘要(耗时 · token · 成本);中断才发声。
      let done = flushed;
      if (e.stopReason === 'interrupted') {
        done = pushCommitted(flushed, 'warn', '⏹ 已中断');
      } else {
        const summary = turnSummary(state.turnStartedTs, ts, u, u.costUsd ?? e.costUsd);
        if (summary) done = pushCommitted(flushed, 'dim', summary);
      }
      return { ...done, running: false, turns: done.turns + 1, turnStartedTs: null, lastStop: e.stopReason };
    }
    case 'TurnFailed': {
      const flushed = flushLive(state);
      const done = pushCommitted(flushed, 'error', `失败:${e.error.message}`);
      return { ...done, running: false, turns: done.turns + 1, turnStartedTs: null, lastStop: 'failed' };
    }
    // 会话元信息不渲染。
    case 'SessionStarted':
      return state;
    default:
      return state;
  }
}

/** 轮摘要:`· 8.2s · ↑1.2k ↓300 · $0.03`;全部为零 → null(不产噪音)。 */
function turnSummary(
  startedTs: number | null,
  endTs: number | undefined,
  u: { inputTokens: number; outputTokens: number },
  costUsd: number | undefined,
): string | null {
  const parts: string[] = [];
  if (startedTs !== null && endTs !== undefined && endTs > startedTs) {
    parts.push(`${((endTs - startedTs) / 1000).toFixed(1)}s`);
  }
  if (u.inputTokens > 0 || u.outputTokens > 0) parts.push(`↑${fmtInt(u.inputTokens)} ↓${fmtInt(u.outputTokens)}`);
  if (costUsd && costUsd > 0) parts.push(fmtCost(costUsd));
  return parts.length ? `· ${parts.join(' · ')}` : null;
}

/** todo/plan 单例区块:live 内已有同类则就地更新,否则新开。 */
function upsertByKind(state: UiState, kind: 'todo' | 'plan', make: (id: string) => Block): UiState {
  const idx = state.live.findIndex((b) => b.kind === kind);
  if (idx >= 0) {
    const existing = state.live[idx]!;
    const updated = { ...make(existing.id) };
    const live = [...state.live];
    live[idx] = updated;
    return { ...state, live };
  }
  const [id, s2] = nextId(state);
  return { ...s2, live: [...s2.live, make(id)] };
}
