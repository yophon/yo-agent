/**
 * OpenAiResponsesProvider —— openai.com 主路 POST /v1/responses（DESIGN §4.2）。
 * 与 chat/completions 形态不同：input 是 item 数组（function_call / function_call_output），
 * SSE 是 typed 事件（response.output_text.delta / response.function_call_arguments.delta / response.completed）。
 *
 * 注：live 路径需 OPENAI_API_KEY（计费），本阶段只对 SSE 解码 + body 构造做单测。
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

export interface ResponsesProviderOpts {
  apiKey?: string;
  baseUrl?: string;
  defaultMaxTokens?: number;
  headers?: Record<string, string>;
}

export class OpenAiResponsesProvider implements Provider {
  readonly id = 'openai-responses';
  readonly capabilities: ProviderCapabilities = {
    nativeToolCalling: true,
    thinking: true,
    promptCache: true,
    effort: true,
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly extraHeaders: Record<string, string>;

  /** baseUrl 被显式覆盖（自建代理/中转站）：key 可由代理侧注入，空 key 不再早退（5A 双模式）。 */
  private readonly hasCustomBase: boolean;

  constructor(opts: ResponsesProviderOpts = {}) {
    this.apiKey = opts.apiKey ?? globalThis.process?.env?.OPENAI_API_KEY ?? '';
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.hasCustomBase = opts.baseUrl !== undefined;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 16_000;
    this.extraHeaders = opts.headers ?? {};
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    if (!this.apiKey && !this.hasCustomBase) {
      yield { kind: 'Error', error: { message: '缺少 OPENAI_API_KEY' } };
      return;
    }
    const body = buildResponsesBody(req, this.defaultMaxTokens);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    Object.assign(headers, this.extraHeaders);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      yield { kind: 'Error', error: { message: e instanceof Error ? e.message : String(e), retryable: true, category: classifyError(undefined, e instanceof Error ? e.message : String(e)) } };
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
        error: { message: `HTTP ${res.status}: ${text}`, status: res.status, retryable: res.status >= 500 || res.status === 429, category: classifyError(res.status, text) },
      };
      return;
    }
    const decoder = new ResponsesSseDecoder();
    for await (const data of sseDataLines(res.body)) {
      if (data === '[DONE]') break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      for (const ev of decoder.push(parsed as ResponsesEvent)) yield ev;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-4o', contextWindow: 128_000, maxOutput: 16_384, inputPricePerMTok: 2.5, outputPricePerMTok: 10 },
      { id: 'gpt-4o-mini', contextWindow: 128_000, maxOutput: 16_384, inputPricePerMTok: 0.15, outputPricePerMTok: 0.6 },
    ];
  }
}

// ───────────────────────── body 构造 ─────────────────────────

export function buildResponsesBody(req: ChatRequest, defaultMaxTokens: number): Record<string, unknown> {
  const system = req.system ?? collectSystem(req.messages);
  const body: Record<string, unknown> = {
    model: req.modelId,
    input: toResponsesInput(req.messages),
    stream: true,
    max_output_tokens: req.maxTokens ?? defaultMaxTokens,
  };
  if (system) body.instructions = system;
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema,
    }));
  }
  if (req.toolChoice) body.tool_choice = toResponsesToolChoice(req.toolChoice);
  if (req.effort) body.reasoning = { effort: req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort };
  if (req.userId) body.user = req.userId;
  if (req.providerOptions) Object.assign(body, req.providerOptions);
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

function toResponsesInput(messages: CanonMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // → instructions
    if (m.role === 'tool') {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'tool_result') {
          out.push({ type: 'function_call_output', call_id: b.toolUseId, output: b.content });
        }
      }
      continue;
    }
    if (typeof m.content === 'string') {
      const partType = m.role === 'assistant' ? 'output_text' : 'input_text';
      out.push({ role: m.role, content: [{ type: partType, text: m.content }] });
      continue;
    }
    const textParts: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === 'text') {
        textParts.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: b.text });
      } else if (b.type === 'tool_use') {
        // 先把已累计的文本作为一条 message，再追加 function_call item。
        if (textParts.length) {
          out.push({ role: m.role, content: [...textParts] });
          textParts.length = 0;
        }
        out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      } else if (b.type === 'tool_result') {
        out.push({ type: 'function_call_output', call_id: b.toolUseId, output: b.content });
      }
    }
    if (textParts.length) out.push({ role: m.role, content: textParts });
  }
  return out;
}

function toResponsesToolChoice(tc: ToolChoice): unknown {
  switch (tc.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', name: tc.name };
  }
}

// ───────────────────────── SSE 解码 ─────────────────────────

export interface ResponsesEvent {
  type: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  item?: { type?: string; id?: string; call_id?: string; name?: string };
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
}

/** 有状态解码器：映射 item_id → call_id（参数 delta 用 item_id 引用），追踪是否出现工具调用。 */
export class ResponsesSseDecoder {
  private readonly callIdByItem = new Map<string, string>();
  private sawToolCall = false;

  push(ev: ResponsesEvent): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    switch (ev.type) {
      case 'response.output_text.delta':
        if (ev.delta) out.push({ kind: 'TextDelta', text: ev.delta });
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (ev.delta) out.push({ kind: 'ThinkingDelta', text: ev.delta });
        break;
      case 'response.refusal.delta':
        if (ev.delta) out.push({ kind: 'TextDelta', text: ev.delta });
        break;
      case 'response.output_item.added':
        if (ev.item?.type === 'function_call') {
          const id = ev.item.call_id ?? ev.item.id ?? `resp_call_${this.callIdByItem.size}`;
          if (ev.item.id) this.callIdByItem.set(ev.item.id, id);
          this.sawToolCall = true;
          out.push({ kind: 'ToolCallStart', id, name: ev.item.name ?? '' });
        }
        break;
      case 'response.function_call_arguments.delta': {
        const id = (ev.item_id && this.callIdByItem.get(ev.item_id)) || ev.item_id;
        if (id && ev.delta) out.push({ kind: 'ToolCallArgsDelta', id, delta: ev.delta });
        break;
      }
      case 'response.output_item.done':
        if (ev.item?.type === 'function_call') {
          const id = (ev.item.id && this.callIdByItem.get(ev.item.id)) || ev.item.call_id || ev.item.id;
          if (id) out.push({ kind: 'ToolCallEnd', id });
        }
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const usage = ev.response?.usage;
        if (usage) {
          out.push({
            kind: 'UsageUpdate',
            usage: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
            },
          });
        }
        const incomplete = ev.type === 'response.incomplete' || ev.response?.status === 'incomplete';
        const reason: 'end_turn' | 'tool_use' | 'max_tokens' =
          incomplete && ev.response?.incomplete_details?.reason === 'max_output_tokens'
            ? 'max_tokens'
            : this.sawToolCall
              ? 'tool_use'
              : 'end_turn';
        out.push({ kind: 'Stop', reason });
        break;
      }
      case 'response.failed':
      case 'error':
        out.push({ kind: 'Error', error: { message: 'openai responses error' } });
        break;
      default:
        break;
    }
    return out;
  }
}
