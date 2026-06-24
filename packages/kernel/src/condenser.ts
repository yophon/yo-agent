/**
 * Condenser 实现（DESIGN §5.1 / ADR-6）。
 * - NoopCondenser：恒不压缩（测试 / 短会话）。
 * - SummarizingCondenser：保首 keepFirst + 保尾 keepTail 原始 + 中段 LLM 结构化 Handoff 摘要，
 *   摘要 prompt 强制逐字保留不透明标识符（OpenClaw IDENTIFIER_PRESERVATION），用便宜模型（opencode）。
 *
 * 压缩只影响"送 LLM 的消息窗口"；原始 EventLog 不删（§5.1）。tokensSaved 由内核估算并随 ContextCompacted 落库。
 */
import type { CanonMessage, ChatRequest, ContentBlock, Provider } from '@yo-agent/provider';
import type { Condenser, CondenseOpts, ContextState } from './index';

/** 占位 Condenser：恒不压缩。 */
export class NoopCondenser implements Condenser {
  shouldCompact(_ctx: ContextState): boolean {
    return false;
  }
  async condense(messages: CanonMessage[]): Promise<CanonMessage[]> {
    return messages;
  }
}

/** 中段摘要器：把一段历史文本压成结构化交接摘要。便宜模型即可，可注入 fake 离线测试。 */
export type Summarizer = (text: string, hint?: string) => Promise<string>;

export interface SummarizingCondenserOpts {
  summarize: Summarizer;
  /** 触发阈值（默认 0.8，可配至 0.85，§15.10 C1）。 */
  thresholdRatio?: number;
  /** 保留开头条数（system + 首个 user，默认 2）。 */
  keepFirst?: number;
  /** 保留结尾原始轮数（默认 6）。 */
  keepTail?: number;
}

const SUMMARY_SYSTEM = [
  '你是上下文压缩器。把给定的对话历史压成结构化交接摘要，必须包含四节：',
  '## 目标 / ## 已发生 / ## 当前状态 / ## 下一步。',
  '逐字保留所有不透明标识符（UUID、hash、文件路径、URL、变量/函数名、错误码），',
  '不得缩写、改写或重构标识符。只输出摘要本身，不要寒暄。',
].join('\n');

export class SummarizingCondenser implements Condenser {
  private readonly summarize: Summarizer;
  private readonly thresholdRatio: number;
  private readonly keepFirst: number;
  private readonly keepTail: number;

  constructor(opts: SummarizingCondenserOpts) {
    this.summarize = opts.summarize;
    this.thresholdRatio = opts.thresholdRatio ?? 0.8;
    this.keepFirst = opts.keepFirst ?? 2;
    this.keepTail = opts.keepTail ?? 6;
  }

  shouldCompact(ctx: ContextState): boolean {
    if (ctx.usableTokens <= 0) return false;
    return ctx.usedTokens >= this.thresholdRatio * ctx.usableTokens;
  }

  async condense(messages: CanonMessage[], opts: CondenseOpts = {}): Promise<CanonMessage[]> {
    let keepFirst = opts.keepFirst ?? this.keepFirst;
    let tailStart = messages.length - (opts.keepTail ?? this.keepTail);

    // 中段太短不值得压缩。
    if (tailStart <= keepFirst) return messages;

    // head 边界保护：head 末条不能以未配对 tool_use 结尾（其 tool_result 落中段被摘 → 孤儿 tool_use，Anthropic 400）。
    // 回退 keepFirst，把该 assistant(tool_use) 推进中段一并摘要。
    while (keepFirst > 1 && hasToolUse(messages[keepFirst - 1]!)) keepFirst--;

    // tail 边界保护：尾段不能以"孤儿 tool_result"开头（其配对 tool_use 会被摘进中段，provider 报错）。
    while (tailStart > keepFirst && hasToolResult(messages[tailStart]!)) tailStart--;
    if (tailStart <= keepFirst) return messages;

    const head = messages.slice(0, keepFirst);
    const middle = messages.slice(keepFirst, tailStart);
    const tail = messages.slice(tailStart);

    const summaryText = await this.summarize(renderForSummary(middle), opts.hint);
    const summaryMsg: CanonMessage = {
      role: 'user',
      content: `[上下文已压缩 —— 以下为中段 ${middle.length} 条历史的结构化摘要]\n\n${summaryText}`,
    };
    // 合并相邻 user 消息：摘要(user) 与 head 末/tail 首的 user 相邻会破坏 Anthropic 严格 user/assistant 交替（400）。
    return mergeAdjacentUser([...head, summaryMsg, ...tail]);
  }
}

function hasToolUse(m: CanonMessage): boolean {
  return Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use');
}

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content;
}

/** 合并相邻的 user 消息为单条（content 拼成 block 数组），保证 user/assistant 交替合法。 */
function mergeAdjacentUser(messages: CanonMessage[]): CanonMessage[] {
  const out: CanonMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user' && m.role === 'user') {
      out[out.length - 1] = { role: 'user', content: [...toBlocks(prev.content), ...toBlocks(m.content)] };
    } else {
      out.push(m);
    }
  }
  return out;
}

/** 把 Provider 包成便宜模型摘要器（CLI 用同 provider 换便宜 model）。 */
export function makeProviderSummarizer(provider: Provider, model: string): Summarizer {
  return async (text, hint) => {
    const req: ChatRequest = {
      modelId: model,
      tools: [],
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: (hint ? `压缩指令：${hint}\n\n` : '') + text },
      ],
    };
    let out = '';
    for await (const ev of provider.streamChat(req)) {
      if (ev.kind === 'TextDelta') out += ev.text;
    }
    return out.trim() || '(摘要为空)';
  };
}

function hasToolResult(m: CanonMessage): boolean {
  if (m.role === 'tool') return true;
  return Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
}

function renderForSummary(messages: CanonMessage[]): string {
  return messages.map((m) => `### ${m.role}\n${renderContent(m.content)}`).join('\n\n');
}

function renderContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      switch (b.type) {
        case 'text':
        case 'thinking':
          return b.text;
        case 'tool_use':
          return `[调用 ${b.name}(${safeJson(b.input)})]`;
        case 'tool_result':
          return `[结果${b.isError ? '(错误)' : ''}: ${b.content}]`;
      }
    })
    .join('\n');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
