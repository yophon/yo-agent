/**
 * 区块渲染(4.6c):Block → React 元素,committed(<Static>)/live 共用。
 * 视觉体系:`›` 用户 / 助手 markdown / `⏺ 工具(arg)` + `⎿ 结果尾`(状态色圆点)/
 * `☐◐☑` todo / `↳` 子 agent。verbose(Ctrl+O)切换工具折叠尾 ↔ 展开体;
 * <Static> 已渲区块不回改(固有取舍),verbose 只影响其后渲染。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { Tone } from '../../tui-format';
import type { Block } from '../model';
import { renderMarkdown } from './markdown';
import { toolView } from './tool-views';
import type { Span, StyledLine } from './spans';

const h = React.createElement;

export const TONE_COLOR: Record<Tone, string | undefined> = {
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
  dim: 'gray',
  success: 'green',
};

export interface RenderOpts {
  /** 终端列数(表格/分隔线适配)。 */
  width: number;
  /** 工具区块展开体(Ctrl+O)。 */
  verbose: boolean;
}

const DEFAULT_OPTS: RenderOpts = { width: 80, verbose: false };

function spanEl(sp: Span, key: number): React.ReactElement {
  return h(
    Text,
    {
      key,
      bold: sp.bold,
      italic: sp.italic,
      underline: sp.underline,
      inverse: sp.inverse,
      dimColor: sp.dim,
      color: sp.color,
    },
    sp.text,
  );
}

/** 样式行 → 单个 <Text> 行(前缀可选);审批面板等外部渲染也复用。 */
export function styledLine(line: StyledLine, key: string, prefix = ''): React.ReactElement {
  return h(Text, { key }, prefix ? h(Text, { key: 'p', dimColor: true }, prefix) : null, ...line.map(spanEl));
}
const lineEl = styledLine;

export function renderBlock(b: Block, opts: RenderOpts = DEFAULT_OPTS): React.ReactElement {
  switch (b.kind) {
    case 'user':
      // 轮间空行分隔:用户消息自带上边距。
      return h(Box, { key: b.id, flexDirection: 'column', marginTop: 1 }, h(Text, { color: 'cyan' }, `› ${b.text}`));
    case 'assistant': {
      const lines = renderMarkdown(b.text, opts.width);
      return h(Box, { key: b.id, flexDirection: 'column' }, ...lines.map((l, i) => lineEl(l, 'm' + i)));
    }
    case 'reasoning':
      return h(Text, { key: b.id, color: 'gray', dimColor: true }, `💭 ${b.text}`);
    case 'notice':
      return h(Text, { key: b.id, color: TONE_COLOR[b.tone], dimColor: b.tone === 'dim' }, b.text);
    case 'tool': {
      const view = toolView(b, { verbose: opts.verbose });
      const dotColor = b.status === 'error' ? 'red' : b.status === 'ok' ? 'green' : 'yellow';
      const children: React.ReactElement[] = [
        h(Text, { key: 'h' }, h(Text, { key: 'dot', color: dotColor }, '⏺ '), view.head),
      ];
      view.body.forEach((line, i) => {
        children.push(lineEl(line, 'b' + i, i === 0 ? '  ⎿ ' : '    '));
      });
      if (b.truncatedToPath) {
        children.push(h(Text, { key: 't', color: 'gray', dimColor: true }, `    …输出已截断,完整见 ${b.truncatedToPath}`));
      }
      return h(Box, { key: b.id, flexDirection: 'column' }, ...children);
    }
    case 'todo': {
      const rows = b.items.map((t, i) => {
        const mark = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐';
        return h(
          Text,
          { key: 'i' + i, bold: t.status === 'in_progress', dimColor: t.status === 'completed' },
          `${mark} ${t.text}`,
        );
      });
      return h(Box, { key: b.id, flexDirection: 'column' }, ...rows);
    }
    case 'plan': {
      const rows = b.steps.map((s, i) => {
        const mark = s.status === 'completed' ? '☑' : s.status === 'in_progress' ? '◐' : '☐';
        return h(Text, { key: 's' + i, dimColor: s.status === 'completed' }, `  ${mark} ${i + 1}. ${s.text}`);
      });
      return h(Box, { key: b.id, flexDirection: 'column' }, h(Text, { color: 'cyan' }, '☰ 计划'), ...rows);
    }
    case 'subagent': {
      const children: React.ReactElement[] = [
        h(Text, { key: 'h', color: 'cyan' }, `↳ ${b.label}`, h(Text, { key: 'm', dimColor: true }, `(${b.model})`)),
      ];
      if (b.summary !== undefined) {
        children.push(h(Text, { key: 's', dimColor: true }, `  ⎿ ${b.summary}`));
      } else {
        children.push(h(Text, { key: 's', dimColor: true, color: 'yellow' }, '  ⎿ 运行中…'));
      }
      return h(Box, { key: b.id, flexDirection: 'column' }, ...children);
    }
    default:
      return h(Text, { key: 'x' }, '');
  }
}
