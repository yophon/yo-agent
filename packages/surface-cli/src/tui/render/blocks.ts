/**
 * 区块渲染(4.6a):Block → React 元素,committed(<Static>)/live 共用。
 * 4.6c 将扩展为工具专属视图注册表 + markdown/diff。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { previewOutput, toolIcon, type Tone } from '../../tui-format';
import type { Block } from '../model';

const h = React.createElement;

export const TONE_COLOR: Record<Tone, string | undefined> = {
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
  dim: 'gray',
  success: 'green',
};

export function renderBlock(b: Block): React.ReactElement {
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
      if (b.truncatedToPath) {
        children.push(h(Text, { key: 't', color: 'gray', dimColor: true }, `  …输出已截断,完整见 ${b.truncatedToPath}`));
      }
      return h(Box, { key: b.id, flexDirection: 'column' }, ...children);
    }
    default:
      return h(Text, { key: 'x' }, '');
  }
}
