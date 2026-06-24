/**
 * OpenAiCompatibleProvider —— /v1/chat/completions 兼容端点（DESIGN §4.2）。
 * 一个 adapter 覆盖 OpenAI Chat / DeepSeek / Ollama / LM Studio / OpenRouter / Groq（配 baseUrl + headers）。
 * 注：live 路径需 API key（计费），本阶段只对 SSE 解码 + body 构造做单测。
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

export interface OpenAiProviderOpts {
  apiKey?: string;
  baseUrl?: string;
  defaultMaxTokens?: number;
  headers?: Record<string, string>;
  id?: string;
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = {
    nativeToolCalling: true,
    thinking: false,
    promptCache: false,
    effort: false,
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: OpenAiProviderOpts = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 16_000;
    this.extraHeaders = opts.headers ?? {};
    this.id = opts.id ?? 'openai-compatible';
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    if (!this.apiKey) {
      yield { kind: 'Error', error: { message: `缺少 API key（${this.id}）` } };
      return;
    }
    const body = buildOpenAiBody(req, this.defaultMaxTokens);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      yield { kind: 'Error', error: { message: e instanceof Error ? e.message : String(e), retryable: true } };
      return;
    }
    if (!res.ok || !res.body) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        /* ignore */
      }
      yield {
        kind: 'Error',
        error: { message: `HTTP ${res.status}: ${text}`, status: res.status, retryable: res.status >= 500 || res.status === 429 },
      };
      return;
    }
    const decoder = new OpenAiSseDecoder();
    for await (const data of sseDataLines(res.body)) {
      if (data === '[DONE]') break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      for (const ev of decoder.push(parsed as OpenAiChunk)) yield ev;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}

// ───────────────────────── body 构造 ─────────────────────────

export function buildOpenAiBody(req: ChatRequest, defaultMaxTokens: number): Record<string, unknown> {
  const system = req.system ?? collectSystem(req.messages);
  const body: Record<string, unknown> = {
    model: req.modelId,
    messages: toOpenAiMessages(req.messages, system),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens ?? defaultMaxTokens,
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.jsonSchema },
    }));
  }
  if (req.toolChoice) body.tool_choice = toOpenAiToolChoice(req.toolChoice);
  if (req.userId) body.user = req.userId;
  if (req.providerOptions) Object.assign(body, req.providerOptions); // effort/reasoning_effort 等经逃生口透传
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

function toOpenAiMessages(messages: CanonMessage[], system?: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'system') continue; // 已合并到顶部 system
    if (m.role === 'tool') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
      }
      continue;
    }
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = m.content
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
    const msg: Record<string, unknown> = { role: m.role, content: text || null };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    out.push(msg);
  }
  return out;
}

function toOpenAiToolChoice(tc: ToolChoice): unknown {
  switch (tc.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: tc.name } };
  }
}

// ───────────────────────── SSE 解码 ─────────────────────────

export interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiSseDecoder {
  private readonly toolByIndex = new Map<number, { id: string; started: boolean }>();

  push(chunk: OpenAiChunk): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    const choice = chunk.choices?.[0];
    if (choice) {
      const d = choice.delta;
      if (d?.content) out.push({ kind: 'TextDelta', text: d.content });
      if (d?.tool_calls) {
        for (const tc of d.tool_calls) {
          let rec = this.toolByIndex.get(tc.index);
          if (!rec) {
            rec = { id: tc.id ?? `tc_${tc.index}`, started: false };
            this.toolByIndex.set(tc.index, rec);
          }
          if (!rec.started && (tc.id || tc.function?.name)) {
            rec.started = true;
            out.push({ kind: 'ToolCallStart', id: rec.id, name: tc.function?.name ?? '' });
          }
          if (tc.function?.arguments) out.push({ kind: 'ToolCallArgsDelta', id: rec.id, delta: tc.function.arguments });
        }
      }
      if (choice.finish_reason) {
        for (const rec of this.toolByIndex.values()) out.push({ kind: 'ToolCallEnd', id: rec.id });
        this.toolByIndex.clear();
        out.push({ kind: 'Stop', reason: mapFinishReason(choice.finish_reason) });
      }
    }
    if (chunk.usage) {
      out.push({
        kind: 'UsageUpdate',
        usage: {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: 0,
        },
      });
    }
    return out;
  }
}

export function mapFinishReason(r: string): 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' {
  switch (r) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}
