/**
 * 会话列表域（Phase 5.1e，纯函数可单测）：EventStore.listSessions() + 控制台元数据 → 侧栏条目。
 * 标题优先级：手动改名（SessionMeta.title）> messages 快照里首条 user 文本截断 > 「新对话」。
 */
import type { EventStore, SessionRow } from '@yo-agent/store/core';
import type { ConsoleStore } from './console-store';
import type { AgentConfigRecord } from './types';

export interface SessionListItem {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  /** agent 配置已被删除：只读展示，不可续聊。 */
  orphaned: boolean;
  title: string;
  lastActiveAt: number;
}

export function deriveTitle(row: SessionRow): string {
  const msgs = (row.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  for (const m of msgs) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      const t = m.content.trim().replace(/\s+/g, ' ');
      return t.length > 24 ? `${t.slice(0, 24)}…` : t;
    }
  }
  return '新对话';
}

export async function listSessionItems(
  events: EventStore,
  consoleStore: ConsoleStore,
  agents: AgentConfigRecord[],
): Promise<SessionListItem[]> {
  const rows = await events.listSessions();
  rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const items: SessionListItem[] = [];
  for (const row of rows) {
    const agent = byId.get(row.agentProfile);
    const meta = await consoleStore.getSessionMeta(row.sessionId);
    items.push({
      sessionId: row.sessionId,
      agentId: row.agentProfile,
      agentName: agent?.name ?? '（已删除的 agent）',
      agentColor: agent?.color ?? '#9ca3af',
      orphaned: !agent,
      title: meta?.title ?? deriveTitle(row),
      lastActiveAt: row.lastActiveAt,
    });
  }
  return items;
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}
