/**
 * 审批面板(4.6e 入参正文;4.7d 面板整体自 app.ts 迁入):按工具类型呈现
 * 「看得见改动再批」的正文。bash → 命令全文;edit → 彩色 diff;write → 内容预览;
 * apply_patch → 补丁着色;其余 → pretty JSON。正文纯函数,行数封顶防爆屏。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { riskColor } from '../../tui-format';
import type { ApprovalView } from '../model';
import { styledLine } from './blocks';
import { collapseContext, parsePatchText, renderDiff, toStyled } from './diff';
import { plainLine, span, type StyledLine } from './spans';

const h = React.createElement;

const MAX_LINES = 20;

const str = (input: unknown, field: string): string => {
  const v = (input as Record<string, unknown> | null)?.[field];
  return typeof v === 'string' ? v : '';
};

function cap(lines: StyledLine[], max = MAX_LINES): StyledLine[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), plainLine(`··· 共 ${lines.length} 行`, { dim: true })];
}

export function approvalBody(tool: string, input: unknown): StyledLine[] {
  switch (tool) {
    case 'bash': {
      const command = str(input, 'command');
      return cap(command.split('\n').map((l) => [span(l, { bold: true })]));
    }
    case 'edit': {
      const path = str(input, 'path');
      return cap([plainLine(path, { underline: true }), ...renderDiff(str(input, 'old_string'), str(input, 'new_string'))]);
    }
    case 'write': {
      const path = str(input, 'path');
      const content = str(input, 'content');
      const lines = content ? content.split('\n') : [];
      return cap([
        plainLine(`${path}(写入 ${lines.length} 行)`, { underline: true }),
        ...lines.slice(0, 10).map((l) => plainLine(l, { dim: true })),
        ...(lines.length > 10 ? [plainLine(`··· 共 ${lines.length} 行`, { dim: true })] : []),
      ]);
    }
    case 'apply_patch':
      return cap(toStyled(collapseContext(parsePatchText(str(input, 'patch')))));
    default: {
      let pretty: string;
      try {
        pretty = JSON.stringify(input, null, 1) ?? '';
      } catch {
        pretty = String(input);
      }
      return cap(
        pretty.split('\n').map((l) => plainLine(l, { dim: true })),
        10,
      );
    }
  }
}

/** 审批面板整体:风险色边框 + 正文 + 选项列表 + Esc 双击提示。 */
export function renderApprovalPanel(a: ApprovalView, rejectArmed: boolean): React.ReactElement {
  const options = [
    ...a.suggestions.map((sug) => sug.label ?? sug.decision),
    ...(a.withGuide ? ['拒绝并告诉它该怎么做…'] : []),
  ];
  const body = approvalBody(a.tool, a.input);
  return h(
    Box,
    { key: 'approval', flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: riskColor(a.risk), paddingX: 1 },
    h(
      Text,
      { key: 'hdr', color: riskColor(a.risk) },
      `⚠ ${a.tool} · 风险 ${a.risk}`,
      h(Text, { key: 'k', dimColor: true }, '  (↑↓/数字 选择 · Enter 确认 · Esc×2 拒绝)'),
    ),
    ...body.map((line, i) => styledLine(line, 'b' + i, ' ')),
    h(Text, { key: 'sp' }, ' '),
    ...options.map((label, i) =>
      h(
        Text,
        { key: 'o' + i, color: i === a.selected ? 'green' : undefined },
        `${i === a.selected ? '❯' : ' '} ${i + 1}. ${label}`,
      ),
    ),
    rejectArmed ? h(Text, { key: 'ra', color: 'yellow' }, '再按 Esc 拒绝') : null,
  );
}
