import type { RiskLevel } from '@yo-agent/protocol';
import type { ToolDescriptor } from '@yo-agent/tools';

/** 保护路径（§15.7 Protected Paths 最小子集）：命中 → 升 high。 */
const PROTECTED_PATH_RE =
  /(^|[/\\])\.(git|ssh|env)([/\\]|$)|\.(pem|key)$|(^|[/\\])(id_rsa|id_ed25519|\.npmrc|\.aws|\.yo-agent)([/\\]|$)/i;
/** 危险命令模式：命中 → 升 high（rm 含短选项 -rf 与长选项 --recursive/--force，审查 RISK-05）。 */
const DANGEROUS_CMD_RE =
  /\brm\s+(-[rf]+|--recursive|--force|--no-preserve-root)|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{\s*:\s*\|\s*:|\bshutdown\b|\bchmod\s+-R\b|>\s*\/dev\/sd/i;

/**
 * 工具调用风险分级（DESIGN §9.2 / §15.7）。替换 kernel 中硬编码的 'unknown'。
 * 维度：① ToolKind 静态分级；② owner（外部工具基线更高）；③ input 内容（保护路径 / 危险命令 → high）。
 */
export function assessRisk(desc: ToolDescriptor | undefined, input: unknown): RiskLevel {
  if (!desc) return 'unknown';
  if (desc.approval === 'never') return 'low';

  // input 维度：保护路径 / 危险命令命中 → 直接 high（覆盖「write 到 protected path 升级」）。
  const probe = riskProbeText(input);
  if (PROTECTED_PATH_RE.test(probe) || DANGEROUS_CMD_RE.test(probe)) return 'high';

  // 外部工具（owner !== 'core'）副作用未知，读类基线也取 medium。
  const external = desc.owner !== 'core';
  switch (desc.kind) {
    case 'read':
    case 'search':
    case 'fetch':
    case 'think':
      return external ? 'medium' : 'low';
    case 'edit':
    case 'move':
      return 'medium';
    case 'delete':
    case 'execute':
      return 'high';
    default:
      return external ? 'medium' : 'low';
  }
}

/** 是否命中 Protected Paths（§15.7）。供 ACP fs/* 反向能力等复用同一保护路径定义。 */
export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATH_RE.test(path);
}

/** 从工具 input 抽取风险探测文本（路径 / 命令维度；不含 content 以免文档正文误报）。 */
function riskProbeText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const parts: string[] = [];
  // 含 Anthropic/MCP 系工具常用字段 file_path（Edit/Write）、paths/files（多文件）（审查 RISK-01）。
  for (const k of ['path', 'file_path', 'file', 'filename', 'paths', 'files', 'dest', 'target', 'command', 'cmd', 'args']) {
    const v = o[k];
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
  }
  return parts.join(' ');
}
