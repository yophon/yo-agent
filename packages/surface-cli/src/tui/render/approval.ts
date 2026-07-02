/**
 * 审批面板入参渲染(4.6e):按工具类型呈现「看得见改动再批」的正文。
 * bash → 命令全文;edit → 彩色 diff;write → 内容预览;apply_patch → 补丁着色;
 * 其余 → pretty JSON。纯函数,行数封顶防爆屏。
 */
import { collapseContext, parsePatchText, renderDiff, toStyled } from './diff';
import { plainLine, span, type StyledLine } from './spans';

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
