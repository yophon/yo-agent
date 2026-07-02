/**
 * Footer 渲染(4.7d 自 app.ts 拆出):四态互斥 —— 审批面板 / 引导输入 / 选择器 /
 * (活动行 + 队列提示 + 输入框 + 补全菜单 + 快捷键提示)。纯元素工厂,状态由 app 传入。
 */
import React from 'react';
import { Text } from 'ink';
import { fmtInt } from '../../tui-format';
import type { Completion } from '../input/completion';
import type * as ed from '../input/editor';
import type { UiState } from '../model';
import { renderApprovalPanel } from './approval';
import { renderInputBox } from './input-box';
import { renderCompletionMenu, renderPicker } from './picker';

const h = React.createElement;

export interface FooterInput {
  state: UiState;
  editor: ed.EditorState;
  columns: number;
  completion: Completion | null;
  /** @ 文件补全清单加载中。 */
  filesLoading: boolean;
  exitArmed: boolean;
  rejectArmed: boolean;
  spinFrame: string;
  /** 本轮已运行秒数(活动行;0 不显示)。 */
  elapsedSec: number;
}

export function renderFooter(f: FooterInput): React.ReactElement[] {
  const { state, editor, columns, completion } = f;
  const footer: React.ReactElement[] = [];

  if (state.approval) {
    footer.push(renderApprovalPanel(state.approval, f.rejectArmed));
    return footer;
  }

  if (state.pendingGuide) {
    // 引导输入态:输入框 + 提示(Enter = 拒绝并告知;Esc 返回审批)。
    footer.push(
      h(Text, { key: 'g', color: 'yellow' }, `⚠ 引导 ${state.pendingGuide.tool}:输入它该怎么做,回车 = 拒绝该操作并告知`),
      renderInputBox(editor, columns, false),
      h(Text, { key: 'gh', color: 'gray', dimColor: true }, 'Enter 拒绝并引导 · Esc 返回审批面板'),
    );
    return footer;
  }

  if (state.picker) {
    footer.push(renderPicker(state.picker));
    return footer;
  }

  if (state.running) {
    // 活动行(4.6c):动作词 + 耗时 + 本轮出 token。
    const parts = [`${f.spinFrame} ${state.activity}…`];
    if (f.elapsedSec >= 1) parts.push(`${f.elapsedSec}s`);
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
  if (state.queue.length) {
    footer.push(h(Text, { key: 'q', color: 'yellow' }, `⏸ 已排队 ${state.queue.length} 条(完成后自动发送 · 输入框空时 ↑ 取回)`));
  }
  footer.push(renderInputBox(editor, columns, state.running));
  if (completion) {
    footer.push(
      renderCompletionMenu(
        completion.items.map((i) => ({ label: i.label, hint: i.hint })),
        state.menu.selected,
        f.filesLoading,
      ),
    );
  }
  const hint = f.exitArmed
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
  return footer;
}
