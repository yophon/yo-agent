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

/** sampling 输出硬上限（默认）：限制单次反向请求驱动的补全规模，防额度被白嫖（审查 H4）。 */
export const DEFAULT_SAMPLING_MAX_TOKENS = 4096;

export interface SamplingHandlerOptions {
  provider: Provider;
  model: string;
  /** 限流器：**必填**（fail-closed，§15.3）——缺失即等于关闭唯一防线，绝不允许 fail-open。 */
  rateLimiter: RateLimiter;
  /** 输出 token 硬上限（默认 4096）；与请求 maxTokens 取 min，防对端用超大 maxTokens 放大成本。 */
  maxOutputTokens?: number;
  /** 配额计费钩子（成本计入 user 配额）：含输入与输出，且在异常路径也补记（finally）。 */
  onUsage?: (info: { inputChars: number; outputChars: number }) => void;
}

/** 构造 sampling 请求处理器：限流（必经）→ 上限钳制 → 路由当前会话 Provider → 输入/输出计费（含异常补记）。 */
export function createSamplingHandler(opts: SamplingHandlerOptions): SamplingHandler {
  const cap = opts.maxOutputTokens ?? DEFAULT_SAMPLING_MAX_TOKENS;
  return async (req) => {
    if (!opts.rateLimiter.tryAcquire()) {
      throw new Error('MCP sampling 限流：超出窗口配额（§15.3）');
    }
    const messages = toCanonMessages(req.params.messages);
    const inputChars =
      messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) +
      (req.params.systemPrompt ? req.params.systemPrompt.length : 0);
    const maxTokens = Math.min(req.params.maxTokens, cap); // 对端 maxTokens 必经硬上限钳制
    let text = '';
    try {
      for await (const ev of opts.provider.streamChat({
        modelId: opts.model,
        tools: [],
        messages,
        system: req.params.systemPrompt,
        maxTokens,
      })) {
        if (ev.kind === 'TextDelta') text += ev.text;
      }
    } finally {
      // 异常路径（部分产出后抛错）也归因，避免成本泄漏不计费（审查 H4）。
      opts.onUsage?.({ inputChars, outputChars: text.length });
    }
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
