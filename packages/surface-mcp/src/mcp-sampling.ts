/**
 * MCP sampling host 端路由（3G / DESIGN §15.3 承重项）。
 *
 * 外部 server 经 `sampling/createMessage` 反向请求本 host 用「当前会话 Provider」补全。**必须限流 + 配额计费**
 * （成本计入 user 配额）——否则被入侵/恶意 server 可借此白嫖本端模型额度。
 */
import type { CreateMessageRequest, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import type { CanonMessage, Provider } from '@yo-agent/provider';

export interface RateLimiterOptions {
  /** 窗口内最大次数。 */
  maxPerWindow: number;
  /** 窗口时长（ms）。 */
  windowMs: number;
  now?: () => number;
}

/** 滑动窗口限流器（纯时钟驱动，可注入时钟离线确定性测）。 */
export class RateLimiter {
  private hits: number[] = [];
  private readonly nowFn: () => number;
  constructor(private readonly opts: RateLimiterOptions) {
    this.nowFn = opts.now ?? (() => Date.now());
  }
  tryAcquire(now: number = this.nowFn()): boolean {
    const cutoff = now - this.opts.windowMs;
    this.hits = this.hits.filter((t) => t > cutoff);
    if (this.hits.length >= this.opts.maxPerWindow) return false;
    this.hits.push(now);
    return true;
  }
}

export type SamplingHandler = (req: CreateMessageRequest) => Promise<CreateMessageResult>;

export interface SamplingHandlerOptions {
  provider: Provider;
  model: string;
  /** 限流（不传 = 不限流，仅测试可省；生产必须配，§15.3）。 */
  rateLimiter?: RateLimiter;
  /** 配额计费钩子（成本计入 user 配额）。 */
  onUsage?: (info: { outputChars: number }) => void;
}

/** 构造 sampling 请求处理器：限流 → 路由当前会话 Provider → 计费。 */
export function createSamplingHandler(opts: SamplingHandlerOptions): SamplingHandler {
  return async (req) => {
    if (opts.rateLimiter && !opts.rateLimiter.tryAcquire()) {
      throw new Error('MCP sampling 限流：超出窗口配额（§15.3）');
    }
    const messages = toCanonMessages(req.params.messages);
    let text = '';
    for await (const ev of opts.provider.streamChat({
      modelId: opts.model,
      tools: [],
      messages,
      system: req.params.systemPrompt,
    })) {
      if (ev.kind === 'TextDelta') text += ev.text;
    }
    opts.onUsage?.({ outputChars: text.length });
    return { role: 'assistant', model: opts.model, content: { type: 'text', text }, stopReason: 'endTurn' };
  };
}

function toCanonMessages(messages: CreateMessageRequest['params']['messages']): CanonMessage[] {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: contentToText(m.content),
  }));
}

/** sampling content 可为单块或数组；非文本块降级占位（MVP，§已知限制）。 */
function contentToText(content: CreateMessageRequest['params']['messages'][number]['content']): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((b) => (b.type === 'text' ? b.text : '[非文本采样内容，已忽略]')).join('\n');
}
