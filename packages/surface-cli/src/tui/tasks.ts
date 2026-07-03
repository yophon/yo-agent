/**
 * 子代理任务登记与事件流格式化(4.10c,纯函数可离线单测)。
 * 数据面只用父会话的 SubagentStarted/SubagentResult 聚合事件(不动协议);
 * 子代理自身事件流经 TuiKernel.events.read(childSessionId) 按需快照(渲染在 render/tasks.ts)。
 */
import type { AgentEvent } from '@yo-agent/protocol';

export interface SubagentTask {
  childId: string;
  label: string;
  model: string;
  status: 'running' | 'done';
  summary?: string;
  /** 事件时戳(server-time 基准;回放/缺省时可空)。 */
  startedTs?: number;
  endedTs?: number;
}

/** 任务面板状态:非 null = 面板打开;detail 非 null = 查看某任务的事件流快照。 */
export interface TasksView {
  selected: number;
  detail: { childId: string; lines: string[] } | null;
}

export function taskStarted(
  tasks: SubagentTask[],
  e: { childSessionId: string; label: string; model: string },
  ts?: number,
): SubagentTask[] {
  // 幂等:同 childId 重复 Started(回放)不重复登记。
  if (tasks.some((t) => t.childId === e.childSessionId)) return tasks;
  return [
    ...tasks,
    { childId: e.childSessionId, label: e.label, model: e.model, status: 'running', ...(ts !== undefined ? { startedTs: ts } : {}) },
  ];
}

export function taskResolved(tasks: SubagentTask[], e: { childSessionId: string; summary: string }, ts?: number): SubagentTask[] {
  return tasks.map((t) =>
    t.childId === e.childSessionId
      ? { ...t, status: 'done' as const, summary: e.summary, ...(ts !== undefined ? { endedTs: ts } : {}) }
      : t,
  );
}

/** 失败启发式:manager 的拒绝/失败摘要统一带 `[子 agent …]` 前缀(subagent.ts),surface 只作展示分色。 */
export function taskLooksFailed(t: SubagentTask): boolean {
  return t.status === 'done' && (t.summary?.startsWith('[子 agent ') ?? false);
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * 子代理事件流 → 展示行(快照式,进入详情/回车刷新时整段重算)。
 * 流式增量(AssistantText/Reasoning)按连续段折叠成单行;会话元事件跳过。
 */
export function formatChildEvents(events: AgentEvent[]): string[] {
  const lines: string[] = [];
  let streamKind: 'assistant' | 'reasoning' | null = null;
  const flushable = (kind: 'assistant' | 'reasoning', delta: string): void => {
    if (streamKind === kind && lines.length) {
      lines[lines.length - 1] = clip(`${lines[lines.length - 1]}${delta.replaceAll('\n', ' ')}`, 200);
    } else {
      lines.push(clip(`${kind === 'assistant' ? '💬' : '…'} ${delta.replaceAll('\n', ' ')}`, 200));
    }
    streamKind = kind;
  };
  for (const e of events) {
    switch (e.kind) {
      case 'AssistantText':
        if (e.delta) flushable('assistant', e.delta);
        continue;
      case 'Reasoning':
        if (e.delta) flushable('reasoning', e.delta);
        continue;
      default:
        break;
    }
    streamKind = null;
    switch (e.kind) {
      case 'ToolCallStarted':
        lines.push(clip(`⏺ ${e.name} ${e.summary && e.summary !== e.name ? e.summary : ''}`.trimEnd(), 120));
        break;
      case 'ToolCallCompleted':
        if (e.status === 'error') lines.push('  ⎿ 出错');
        break;
      case 'Error':
        lines.push(clip(`✗ ${e.message}`, 160));
        break;
      case 'SubagentStarted':
        lines.push(clip(`↳ 嵌套子代理:${e.label}(${e.model})`, 120));
        break;
      case 'SubagentResult':
        lines.push(clip(`↳ 嵌套子代理完成:${e.summary.replaceAll('\n', ' ')}`, 160));
        break;
      case 'TurnCompleted':
        lines.push(`— 轮结束(${e.stopReason})`);
        break;
      case 'TurnFailed':
        lines.push(clip(`— 轮失败:${e.error.message}`, 160));
        break;
      default:
        break; // 会话元/用量等事件不进详情视图
    }
  }
  return lines;
}
