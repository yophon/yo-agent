/**
 * 子代理任务面板(4.10c):列表态(运行中/已结束任务)+ 详情态(某任务的事件流快照)。
 * 只负责渲染;状态在 UiState.tasks / subagentTasks,按键路由在 keymap 的 tasks 层。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SubagentTask, TasksView } from '../tasks';
import { taskLooksFailed } from '../tasks';

const h = React.createElement;

const DETAIL_TAIL = 18;

function statusMark(t: SubagentTask): { mark: string; color: string | undefined } {
  if (t.status === 'running') return { mark: '●', color: 'yellow' };
  if (taskLooksFailed(t)) return { mark: '✗', color: 'red' };
  return { mark: '✓', color: 'green' };
}

function elapsedLabel(t: SubagentTask): string {
  if (t.startedTs === undefined) return '';
  const end = t.endedTs ?? Date.now();
  const sec = Math.max(0, Math.round((end - t.startedTs) / 1000));
  return ` · ${sec}s`;
}

export function renderTasksPanel(view: TasksView, tasks: SubagentTask[]): React.ReactElement {
  if (view.detail) {
    const t = tasks.find((x) => x.childId === view.detail!.childId);
    const title = t ? `${t.label}(${t.model})` : view.detail.childId.slice(0, 8);
    const lines = view.detail.lines;
    const tail = lines.slice(-DETAIL_TAIL);
    const rows = tail.length
      ? tail.map((line, i) => h(Text, { key: `l${i}` }, line))
      : [h(Text, { key: 'empty', dimColor: true }, '(暂无事件——可能仍在启动,或运行在隔离档无共享事件存储)')];
    return h(
      Box,
      { key: 'tasks', flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: 'magenta', paddingX: 1 },
      h(Text, { key: 't', color: 'magenta' }, `子代理事件流:${title}${t?.status === 'running' ? ' · 运行中' : ''}`),
      lines.length > tail.length ? h(Text, { key: 'more', dimColor: true }, `…(前 ${lines.length - tail.length} 行省略)`) : null,
      ...rows,
      h(Text, { key: 'hint', color: 'gray', dimColor: true }, 'Enter 刷新 · Esc 返回列表'),
    );
  }

  const rows = tasks.length
    ? tasks.map((t, i) => {
        const { mark, color } = statusMark(t);
        const sel = i === view.selected;
        const summary = t.status === 'running' ? '运行中…' : (t.summary?.split('\n')[0] ?? '');
        return h(
          Text,
          { key: `t${i}`, color: sel ? 'green' : undefined },
          `${sel ? '❯ ' : '  '}`,
          h(Text, { key: 'm', color }, mark),
          ` ${t.label}(${t.model})${elapsedLabel(t)}  `,
          h(Text, { key: 's', dimColor: true }, summary.length > 60 ? `${summary.slice(0, 59)}…` : summary),
        );
      })
    : [h(Text, { key: 'empty', dimColor: true }, '本会话尚无子代理任务(LLM 调用 subagent_spawn 后在此可见)')];
  return h(
    Box,
    { key: 'tasks', flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: 'magenta', paddingX: 1 },
    h(Text, { key: 't', color: 'magenta' }, `子代理任务(${tasks.filter((t) => t.status === 'running').length} 运行中 / 共 ${tasks.length})`),
    ...rows,
    h(Text, { key: 'hint', color: 'gray', dimColor: true }, '↑↓ 选择 · Enter 查看事件流 · Esc 关闭'),
  );
}
