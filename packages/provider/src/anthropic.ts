/**
 * AnthropicProvider —— 真实 BYOK adapter（DESIGN §4.2 / §15.4）。
 * 直连 POST /v1/messages，typed SSE → ProviderEvent。effort 译为 output_config.effort
 * （原生 GA 字段，非 budget_tokens）；4.x 不发 temperature/top_p。
 *
 * 注：live 路径需 ANTHROPIC_API_KEY（计费），本阶段只对 SSE 解码 + body 构造做单测。
 */
import type {
  CanonMessage,
  ChatRequest,
  ContentBlock,
  ModelInfo,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ToolChoice,
} from './types';
import { sseDataLines } from './sse';
import { classifyError } from './errors';

const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOpts {
  apiKey?: string;
  baseUrl?: string;
  defaultMaxTokens?: number;
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly capabilities: ProviderCapabilities = {
    nativeToolCalling: true,
    thinking: true,
    promptCache: true,
    minCacheablePrefixTokens: 4096, // Opus 4.8（§15.4）
    effort: true,
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicProviderOpts = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 16_000;
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    if (!this.apiKey) {
      yield { kind: 'Error', error: { message: '缺少 ANTHROPIC_API_KEY' } };
      return;
    }
    const body = buildAnthropicBody(req, this.defaultMaxTokens);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      yield {
        kind: 'Error',
        error: { message: e instanceof Error ? e.message : String(e), retryable: true, category: classifyError(undefined, e instanceof Error ? e.message : String(e)) },
      };
      return;
    }
    if (!res.ok || !res.body) {
      const text = await safeText(res);
      yield {
        kind: 'Error',
        error: {
          message: `HTTP ${res.status}: ${text}`,
          status: res.status,
          retryable: res.status >= 500 || res.status === 429,
          category: classifyError(res.status, text),
        },
      };
      return;
    }
    const decoder = new AnthropicSseDecoder();
    for await (const data of sseDataLines(res.body)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      for (const ev of decoder.push(parsed as AnthropicSseEvent)) yield ev;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'claude-opus-4-8', contextWindow: 1_000_000, maxOutput: 128_000, inputPricePerMTok: 5, outputPricePerMTok: 25 },
      { id: 'claude-sonnet-4-6', contextWindow: 1_000_000, maxOutput: 64_000, inputPricePerMTok: 3, outputPricePerMTok: 15 },
    ];
  }
}

// ───────────────────────── body 构造 ─────────────────────────

export function buildAnthropicBody(req: ChatRequest, defaultMaxTokens: number): Record<string, unknown> {
  const system = req.system ?? collectSystem(req.messages);
  const nonSystem = req.messages.filter((m) => m.role !== 'system');
  const body: Record<string, unknown> = {
    model: req.modelId,
    max_tokens: req.maxTokens ?? defaultMaxTokens,
    stream: true,
    messages: nonSystem.map(toAnthropicMessage),
  };
  if (system) body.system = system;
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema,
    }));
  }
  if (req.toolChoice) body.tool_choice = toAnthropicToolChoice(req.toolChoice);
  if (req.effort) body.output_config = { effort: req.effort }; // §15.4：原生 GA，非 budget_tokens
  if (req.userId) body.metadata = { user_id: req.userId };
  return body;
}

function collectSystem(messages: CanonMessage[]): string | undefined {
  const parts = messages.filter((m) => m.role === 'system').map(textOf).filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}

function textOf(m: CanonMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function toAnthropicMessage(m: CanonMessage): { role: 'user' | 'assistant'; content: unknown } {
  const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
  if (typeof m.content === 'string') return { role, content: m.content };
  return { role, content: m.content.map(toAnthropicBlock) };
}

function toAnthropicBlock(b: ContentBlock): Record<string, unknown> {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'thinking':
      return { type: 'thinking', thinking: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      };
  }
}

function toAnthropicToolChoice(tc: ToolChoice): Record<string, unknown> {
  switch (tc.type) {
    case 'tool':
      return { type: 'tool', name: tc.name };
    default:
      return { type: tc.type };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// ───────────────────────── SSE 解码 ─────────────────────────

export type AnthropicSseEvent =
  | { type: 'message_start'; message?: unknown }
  | { type: 'content_block_start'; index: number; content_block: { type: string; id?: string; name?: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: string; text?: string; thinking?: string; partial_json?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string }; usage?: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { message?: string; type?: string } };

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** 有状态解码器（index→tool_use id 映射）。可单测，无网络。 */
export class AnthropicSseDecoder {
  private readonly toolByIndex = new Map<number, string>();

  push(ev: AnthropicSseEvent): ProviderEvent[] {
    switch (ev.type) {
      case 'content_block_start': {
        const cb = ev.content_block;
        if (cb.type === 'tool_use' && cb.id) {
          this.toolByIndex.set(ev.index, cb.id);
          return [{ kind: 'ToolCallStart', id: cb.id, name: cb.name ?? '' }];
        }
        return [];
      }
      case 'content_block_delta': {
        const d = ev.delta;
        if (d.type === 'text_delta' && d.text != null) return [{ kind: 'TextDelta', text: d.text }];
        if (d.type === 'thinking_delta' && d.thinking != null) return [{ kind: 'ThinkingDelta', text: d.thinking }];
        if (d.type === 'input_json_delta' && d.partial_json != null) {
          const id = this.toolByIndex.get(ev.index);
          if (id) return [{ kind: 'ToolCallArgsDelta', id, delta: d.partial_json }];
        }
        return [];
      }
      case 'content_block_stop': {
        const id = this.toolByIndex.get(ev.index);
        if (id) {
          this.toolByIndex.delete(ev.index);
          return [{ kind: 'ToolCallEnd', id }];
        }
        return [];
      }
      case 'message_delta': {
        const out: ProviderEvent[] = [];
        if (ev.usage) {
          out.push({
            kind: 'UsageUpdate',
            usage: {
              inputTokens: ev.usage.input_tokens ?? 0,
              outputTokens: ev.usage.output_tokens ?? 0,
              cacheReadTokens: ev.usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: ev.usage.cache_creation_input_tokens,
            },
          });
        }
        if (ev.delta?.stop_reason) out.push({ kind: 'Stop', reason: mapStopReason(ev.delta.stop_reason) });
        return out;
      }
      case 'error': {
        // 审查 4F-MED：SSE 流内 error 事件（如 overloaded_error，常在 content 前推送）原丢弃 category →
        // fallback 链对早期瞬时错误不触发。归类后带上 category，使 kernel 能据此换路由/压缩重试。
        const message = ev.error?.message ?? 'anthropic error';
        return [{ kind: 'Error', error: { message, category: classifyError(undefined, `${ev.error?.type ?? ''} ${message}`) } }];
      }
      default:
        return [];
    }
  }
}

export function mapStopReason(r: string): 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' {
  switch (r) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause_turn';
    default:
      return 'end_turn';
  }
}
