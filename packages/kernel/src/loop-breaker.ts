import type { LoopBreaker, ToolCallRef } from './index';

export interface LoopBreakerOpts {
  windowSize?: number;
  breakThreshold?: number;
  warnThreshold?: number;
}

/**
 * 历史窗死循环熔断（DESIGN §2.3，OpenClaw generic_repeat）。
 * 引擎层强制，不依赖 LLM 自识别。Slice A 实现 generic_repeat；其余三模式（unknown_tool /
 * poll_no_progress / ping_pong）后续阶段补。默认阈值偏小便于测试，生产可配（DESIGN 用 10/30）。
 */
export class HistoryLoopBreaker implements LoopBreaker {
  private readonly history: string[] = [];
  private readonly windowSize: number;
  private readonly breakThreshold: number;
  private readonly warnThreshold: number;

  constructor(opts: LoopBreakerOpts = {}) {
    this.windowSize = opts.windowSize ?? 30;
    this.breakThreshold = opts.breakThreshold ?? 3;
    this.warnThreshold = opts.warnThreshold ?? 2;
  }

  check(call: ToolCallRef): 'ok' | 'warn' | 'break' {
    const key = `${call.name}|${stableStringify(call.input)}`;
    this.history.push(key);
    if (this.history.length > this.windowSize) {
      this.history.splice(0, this.history.length - this.windowSize);
    }
    const repeats = this.history.reduce((n, k) => (k === key ? n + 1 : n), 0);
    if (repeats >= this.breakThreshold) return 'break';
    if (repeats >= this.warnThreshold) return 'warn';
    return 'ok';
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
