import type { EventEnvelope } from '@yo-agent/protocol';
import type { Condenser, ContextState } from './index';

/** 占位 Condenser（Slice A 不压缩）。真正的"保首+保尾+中段摘要"实现见 §5.1，后续阶段补。 */
export class NoopCondenser implements Condenser {
  shouldCompact(_ctx: ContextState): boolean {
    return false;
  }
  async condense(events: EventEnvelope[]): Promise<EventEnvelope[]> {
    return events;
  }
}
