/**
 * 通用选择器面板(4.6d):/model /mode /resume 等共用。↑↓ 选择,Enter 确认,Esc 取消
 * (按键路由在 keymap 的 picker 层)。本文件只负责渲染;状态由 app 持有。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { PickerState } from '../model';

const h = React.createElement;

export function renderPicker(p: PickerState): React.ReactElement {
  const rows = p.items.map((item, i) =>
    h(
      Text,
      { key: `i${i}`, color: i === p.selected ? 'green' : undefined },
      `${i === p.selected ? '❯ ' : '  '}${item.label}`,
      item.hint ? h(Text, { key: 'h', dimColor: true }, `  ${item.hint}`) : null,
    ),
  );
  return h(
    Box,
    { key: 'picker', flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { key: 't', color: 'cyan' }, `${p.title}  (↑↓ 选择,Enter 确认,Esc 取消)`),
    ...rows,
  );
}

/** 补全菜单(输入框下浮层):候选 + 选中高亮 + hint。 */
export interface MenuItemView {
  label: string;
  hint?: string;
}

export function renderCompletionMenu(items: MenuItemView[], selected: number, loading: boolean): React.ReactElement {
  if (loading) {
    return h(Box, { key: 'menu', paddingX: 2 }, h(Text, { dimColor: true }, '加载文件清单…'));
  }
  const rows = items.map((item, i) =>
    h(
      Text,
      { key: `m${i}`, color: i === selected ? 'green' : undefined },
      `${i === selected ? '❯ ' : '  '}${item.label}`,
      item.hint ? h(Text, { key: 'h', dimColor: true }, `  ${item.hint}`) : null,
    ),
  );
  return h(Box, { key: 'menu', flexDirection: 'column', paddingX: 2 }, ...rows);
}
