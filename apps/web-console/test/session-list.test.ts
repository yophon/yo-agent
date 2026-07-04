import { describe, expect, it } from 'vitest';
import type { SessionRow } from '@yo-agent/store/core';
import { MemoryEventStore } from '@yo-agent/store/core';
import { MemoryConsoleStore } from '../src/services/console-store';
import { deriveTitle, formatRelativeTime, listSessionItems } from '../src/services/session-list';
import { newAgentRecord } from '../src/services/types';

function row(sessionId: string, agentProfile: string, lastActiveAt: number, messages: unknown[] = []): SessionRow {
  return {
    sessionId,
    owner: 'self',
    surfaceKind: 'kernel',
    agentProfile,
    workspacePath: '/',
    model: 'm',
    permissionMode: 'supervised',
    state: 'active',
    headCursor: 0,
    createdAt: 1,
    lastActiveAt,
    messages,
  };
}

describe('deriveTitle', () => {
  it('取首条 user 文本、折叠空白、超长截断；无则「新对话」', () => {
    expect(deriveTitle(row('s', 'a', 1, [{ role: 'user', content: '  订单 42\n到哪了  ' }]))).toBe('订单 42 到哪了');
    expect(deriveTitle(row('s', 'a', 1, [{ role: 'user', content: '这是一条非常非常非常非常非常非常非常非常长的用户消息标题' }]))).toMatch(/…$/);
    expect(deriveTitle(row('s', 'a', 1, [{ role: 'assistant', content: 'hi' }]))).toBe('新对话');
    expect(deriveTitle(row('s', 'a', 1))).toBe('新对话');
  });
});

describe('listSessionItems', () => {
  it('按 lastActiveAt 降序；agent 归属映射；配置已删标 orphaned；改名优先', async () => {
    const events = new MemoryEventStore();
    const consoleStore = new MemoryConsoleStore();
    const agent = { ...newAgentRecord(), id: 'a1', name: '客服', color: '#111' };
    await events.createSession(row('s-old', 'a1', 100, [{ role: 'user', content: '第一问' }]));
    await events.createSession(row('s-new', 'a1', 200, [{ role: 'user', content: '第二问' }]));
    await events.createSession(row('s-orphan', 'gone', 150));
    await consoleStore.saveSessionMeta({ sessionId: 's-old', title: '改过名' });

    const items = await listSessionItems(events, consoleStore, [agent]);
    expect(items.map((i) => i.sessionId)).toEqual(['s-new', 's-orphan', 's-old']);
    expect(items[0]).toMatchObject({ agentName: '客服', agentColor: '#111', orphaned: false, title: '第二问' });
    expect(items[1]).toMatchObject({ orphaned: true, agentName: '（已删除的 agent）' });
    expect(items[2]?.title).toBe('改过名');
  });
});

describe('formatRelativeTime', () => {
  it('刚刚/分钟/小时/天', () => {
    const now = 10 * 24 * 3600_000;
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe('3 小时前');
    expect(formatRelativeTime(now - 2 * 24 * 3600_000, now)).toBe('2 天前');
  });
});
