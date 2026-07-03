import type { LoopBreaker, ToolCallRef } from './index';

export interface LoopBreakerOpts {
  windowSize?: number;
  breakThreshold?: number;
  warnThreshold?: number;
  /** 豁免工具名单：天然可重复调用的工具（如 subagent_spawn）不参与计重（4.10a）。 */
  exemptTools?: readonly string[];
  /** 豁免工具类别（protocol ToolKind,如 read/search 只读类）不参与计重（4.10a）。 */
  exemptKinds?: readonly string[];
  /**
   * 批内豁免（4.10a）：同一 assistant 响应批次（batchId 相同）内的同参重复只计 1 次——
   * 一次响应发多个同名同参 tool_use 是并行语义,不是死循环。默认开;strict 档关闭以保留旧行为。
   */
  batchScoped?: boolean;
}

/**
 * 历史窗死循环熔断（DESIGN §2.3，OpenClaw generic_repeat）。
 * 引擎层强制，不依赖 LLM 自识别。Slice A 实现 generic_repeat；其余三模式（unknown_tool /
 * poll_no_progress / ping_pong）后续阶段补。默认阈值偏小便于测试；生产经 makeLoopBreaker
 * 按档位配置（4.10a：YO_LOOP_BREAKER=off|loose|strict，默认 loose）。
 */
export class HistoryLoopBreaker implements LoopBreaker {
  private readonly history: string[] = [];
  private readonly windowSize: number;
  private readonly breakThreshold: number;
  private readonly warnThreshold: number;
  private readonly exemptTools: ReadonlySet<string>;
  private readonly exemptKinds: ReadonlySet<string>;
  private readonly batchScoped: boolean;
  private lastBatchId: string | undefined;
  private batchKeys = new Set<string>();

  constructor(opts: LoopBreakerOpts = {}) {
    this.windowSize = opts.windowSize ?? 30;
    this.breakThreshold = opts.breakThreshold ?? 3;
    this.warnThreshold = opts.warnThreshold ?? 2;
    this.exemptTools = new Set(opts.exemptTools ?? []);
    this.exemptKinds = new Set(opts.exemptKinds ?? []);
    this.batchScoped = opts.batchScoped ?? true;
  }

  check(call: ToolCallRef): 'ok' | 'warn' | 'break' {
    if (this.exemptTools.has(call.name) || (call.kind !== undefined && this.exemptKinds.has(call.kind))) return 'ok';
    const key = `${call.name}|${stableStringify(call.input)}`;
    if (this.batchScoped && call.batchId !== undefined) {
      if (call.batchId !== this.lastBatchId) {
        this.lastBatchId = call.batchId;
        this.batchKeys = new Set();
      } else if (this.batchKeys.has(key)) {
        return 'ok'; // 批内同参重复：并行语义，不再计重
      }
      this.batchKeys.add(key);
    }
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

/** 熔断档位（4.10a）：off=全放行；loose=生产默认（DESIGN 阈值 + 豁免清单）；strict=旧行为（回归用）。 */
export type LoopBreakerMode = 'off' | 'loose' | 'strict';

export function parseLoopBreakerMode(v: string | undefined): LoopBreakerMode | undefined {
  return v === 'off' || v === 'loose' || v === 'strict' ? v : undefined;
}

/** loose 档默认豁免：spawn 天然多发（并行探索）；只读/搜索类重复调用无副作用。 */
const LOOSE_EXEMPT_TOOLS = ['subagent_spawn'] as const;
const LOOSE_EXEMPT_KINDS = ['read', 'search'] as const;

/**
 * 按档位构造熔断器（4.10a，真机反馈 feedback/4.9.md：并行 spawn 被误熔断）。
 * loose 对齐 DESIGN §2.3 生产阈值（窗口 30 / break 10），warn=5 经状态提醒接缝给 LLM 自纠机会；
 * strict 保留 4.10 前行为（3/2/30、无豁免、批内计重）供回归对照。
 */
export function makeLoopBreaker(mode: LoopBreakerMode = 'loose'): LoopBreaker {
  switch (mode) {
    case 'off':
      return { check: () => 'ok' };
    case 'strict':
      return new HistoryLoopBreaker({ batchScoped: false });
    case 'loose':
      return new HistoryLoopBreaker({
        windowSize: 30,
        breakThreshold: 10,
        warnThreshold: 5,
        exemptTools: LOOSE_EXEMPT_TOOLS,
        exemptKinds: LOOSE_EXEMPT_KINDS,
      });
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
