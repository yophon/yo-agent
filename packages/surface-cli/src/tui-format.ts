/**
 * TUI 纯格式化助手（DESIGN §7.2）。与 ink 解耦，便于离线单测。
 * app.ts 负责把这些字符串/数组塞进 React 元素。
 */
import type { RiskLevel } from '@yo-agent/protocol';

/** 紧凑整数：1234→1.2k，1_200_000→1.2M。状态栏 token 计数用。 */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 成本：未知/0 → "$0"；<1¢ 显 4 位小数；否则 2 位。 */
export function fmtCost(usd: number | undefined): string {
  if (!usd || usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** 家目录折叠为 ~，状态栏 cwd 用。 */
export function shortPath(p: string, home = process.env.HOME): string {
  if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p;
}

export type Tone = 'info' | 'warn' | 'error' | 'dim' | 'success';

/** ink 颜色名（risk → 颜色）。 */
export function riskColor(risk: RiskLevel): string {
  switch (risk) {
    case 'low':
      return 'green';
    case 'medium':
      return 'yellow';
    case 'high':
      return 'red';
    default:
      return 'magenta';
  }
}

export interface StatusBarInput {
  model: string;
  mode: string;
  inTok: number;
  outTok: number;
  cacheTok: number;
  costUsd: number;
  cwd: string;
  /** 上下文剩余百分比(4.6e,来自 kernel.contextState);缺省不显示。 */
  ctxLeftPct?: number;
  /** git 分支(纯展示);缺省不显示。 */
  branch?: string;
}

/** 底部状态栏单行文本。 */
export function statusBar(o: StatusBarInput): string {
  const cache = o.cacheTok > 0 ? ` (cache ${fmtInt(o.cacheTok)})` : '';
  const ctx = o.ctxLeftPct !== undefined ? ` · ctx ${Math.max(0, Math.round(o.ctxLeftPct))}%` : '';
  const branch = o.branch ? ` · ${o.branch}` : '';
  return `${o.model} · ${o.mode}${ctx} · ↑${fmtInt(o.inTok)} ↓${fmtInt(o.outTok)}${cache} · ${fmtCost(o.costUsd)}${branch} · ${shortPath(o.cwd)}`;
}

/** spinner 帧（盲文转轮）。 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
