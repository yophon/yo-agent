/**
 * GeminiProvider —— 真实 BYOK adapter（DESIGN §4.2 / §4.3）。
 * 直连 POST /v1beta/models/{model}:streamGenerateContent?alt=sse；
 * JSON Schema 降 OpenAPI-3.0 子集（剥 minLength/maxLength/pattern/minimum/maximum…）；
 * tool_result → functionResponse parts；functionCall 整块（args 是对象，非分片）；id 合成。
 *
 * 注：live 路径需 GEMINI_API_KEY（计费），本阶段只对 SSE 解码 + body 构造 + schema 降级做单测。
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

export interface GeminiProviderOpts {
  apiKey?: string;
  baseUrl?: string;
  defaultMaxTokens?: number;
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini';
  readonly capabilities: ProviderCapabilities = {
    nativeToolCalling: true,
    thinking: false,
    promptCache: false,
    effort: false,
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: GeminiProviderOpts = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 8192;
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    if (!this.apiKey) {
      yield { kind: 'Error', error: { message: '缺少 GEMINI_API_KEY' } };
      return;
    }
    const body = buildGeminiBody(req, this.defaultMaxTokens);
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(req.modelId)}:streamGenerateContent?alt=sse`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
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
    const decoder = new GeminiSseDecoder();
    for await (const data of sseDataLines(res.body)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      for (const ev of decoder.push(parsed as GeminiResponse)) yield ev;
    }
    for (const ev of decoder.flush()) yield ev;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'gemini-2.0-flash', contextWindow: 1_000_000, maxOutput: 8192, inputPricePerMTok: 0.1, outputPricePerMTok: 0.4 },
      { id: 'gemini-1.5-pro', contextWindow: 2_000_000, maxOutput: 8192, inputPricePerMTok: 1.25, outputPricePerMTok: 5 },
    ];
  }
}

// ───────────────────────── schema 降级（OpenAPI-3.0 子集）─────────────────────────

/**
 * Gemini 不接受的 JSON Schema 关键字（DESIGN §4.2：剥 minLength/pattern/maximum…）。
 * oneOf/allOf/not Gemini OpenAPI-3.0 子集不支持（仅 anyOf 支持，且需递归降级其分支）。
 */
const GEMINI_UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'const',
  'examples',
  'default',
  'title',
  'format',
  'oneOf',
  'allOf',
  'not',
]);

function collectDefs(root: unknown): Record<string, unknown> {
  if (!root || typeof root !== 'object') return {};
  const r = root as Record<string, unknown>;
  return {
    ...((r.$defs as Record<string, unknown>) ?? {}),
    ...((r.definitions as Record<string, unknown>) ?? {}),
  };
}

function resolveRef(ref: string, defs: Record<string, unknown>): unknown {
  const m = ref.match(/#\/(?:\$defs|definitions)\/(.+)$/);
  return m && defs[m[1]!] !== undefined ? defs[m[1]!] : undefined;
}

/**
 * 把标准 JSON Schema 7 降级为 Gemini 接受的 OpenAPI-3.0 子集：
 * - $ref 先解引用（inline $defs），解不开退化 {type:'object'}，避免发出空壳；
 * - 剥除不支持关键字（minLength/pattern/maximum/oneOf/allOf/not…）；
 * - 递归 properties / items / anyOf 分支（剥除其内部不支持字段，过滤 {type:'null'} 并设 nullable）；
 * - type 数组 ['string','null'] 归一为单 type + nullable:true（Gemini 不接受 type 数组）。
 */
export function downgradeSchemaForGemini(schema: unknown): unknown {
  return down(schema, collectDefs(schema));
}

function down(schema: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) return schema.map((s) => down(s, defs));
  if (schema === null || typeof schema !== 'object') return schema;
  const obj = schema as Record<string, unknown>;

  if (typeof obj.$ref === 'string') {
    const target = resolveRef(obj.$ref, defs);
    return target !== undefined ? down(target, defs) : { type: 'object' };
  }

  const out: Record<string, unknown> = {};
  let nullable = obj.nullable === true;

  for (const [k, v] of Object.entries(obj)) {
    if (GEMINI_UNSUPPORTED_KEYS.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const types = v.filter((t) => t !== 'null');
      if (v.includes('null')) nullable = true;
      if (types.length > 0) out.type = types[0];
      continue;
    }
    if (k === 'anyOf' && Array.isArray(v)) {
      const branches = v.filter((b) => !(b && typeof b === 'object' && (b as { type?: unknown }).type === 'null'));
      if (branches.length < v.length) nullable = true;
      out.anyOf = branches.map((b) => down(b, defs));
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = down(pv, defs);
      out.properties = props;
      continue;
    }
    if (k === 'items') {
      out.items = down(v, defs);
      continue;
    }
    out[k] = v;
  }
  if (nullable) out.nullable = true;
  return out;
}

// ───────────────────────── body 构造 ─────────────────────────

export function buildGeminiBody(req: ChatRequest, defaultMaxTokens: number): Record<string, unknown> {
  const system = req.system ?? collectSystem(req.messages);
  const body: Record<string, unknown> = {
    contents: toGeminiContents(req.messages),
    generationConfig: { maxOutputTokens: req.maxTokens ?? defaultMaxTokens },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (req.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: downgradeSchemaForGemini(t.jsonSchema),
        })),
      },
    ];
  }
  if (req.toolChoice) body.toolConfig = toGeminiToolConfig(req.toolChoice);
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

function toGeminiContents(messages: CanonMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // → systemInstruction
    if (m.role === 'tool') {
      const parts = (Array.isArray(m.content) ? m.content : [])
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        // Gemini 靠 name 关联 functionResponse↔functionCall：必须用真实函数名（b.name），非合成 call id。
        .map((b) => ({ functionResponse: { name: b.name ?? b.toolUseId, response: { content: b.content } } }));
      if (parts.length) out.push({ role: 'user', parts });
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') {
      out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input } });
      else if (b.type === 'tool_result') parts.push({ functionResponse: { name: b.name ?? b.toolUseId, response: { content: b.content } } });
    }
    out.push({ role, parts });
  }
  return out;
}

function toGeminiToolConfig(tc: ToolChoice): Record<string, unknown> {
  switch (tc.type) {
    case 'any':
      return { functionCallingConfig: { mode: 'ANY' } };
    case 'none':
      return { functionCallingConfig: { mode: 'NONE' } };
    case 'tool':
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.name] } };
    default:
      return { functionCallingConfig: { mode: 'AUTO' } };
  }
}

// ───────────────────────── SSE 解码 ─────────────────────────

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: unknown };
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
}

/**
 * 有状态解码器：合成 functionCall id（Gemini 不给 id），追踪是否出现工具调用以正确映射 Stop。
 * functionCall 是整块（args 对象），一次性 Start+ArgsDelta+End（DESIGN §4.3）。
 */
export class GeminiSseDecoder {
  private callSeq = 0;
  private sawToolCall = false;
  private finished = false;

  push(resp: GeminiResponse): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    for (const cand of resp.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        if (part.thought && part.text != null) {
          out.push({ kind: 'ThinkingDelta', text: part.text });
        } else if (part.text != null) {
          out.push({ kind: 'TextDelta', text: part.text });
        }
        if (part.functionCall) {
          const id = `gemini_call_${++this.callSeq}`;
          this.sawToolCall = true;
          out.push({ kind: 'ToolCallStart', id, name: part.functionCall.name });
          out.push({ kind: 'ToolCallArgsDelta', id, delta: JSON.stringify(part.functionCall.args ?? {}) });
          out.push({ kind: 'ToolCallEnd', id });
        }
      }
    }
    if (resp.usageMetadata) {
      // Gemini promptTokenCount 已含 cachedContentTokenCount（与 Anthropic input 不含 cache 相反）；
      // 减去 cached 使 inputTokens/cacheReadTokens 互斥，对齐 ModelCatalog.estimateCost 的 Anthropic 语义（不重复计费）。
      const cached = resp.usageMetadata.cachedContentTokenCount ?? 0;
      const prompt = resp.usageMetadata.promptTokenCount ?? 0;
      out.push({
        kind: 'UsageUpdate',
        usage: {
          inputTokens: Math.max(0, prompt - cached),
          outputTokens: resp.usageMetadata.candidatesTokenCount ?? 0,
          cacheReadTokens: cached,
        },
      });
    }
    const finishReason = resp.candidates?.find((c) => c.finishReason)?.finishReason;
    if (finishReason) {
      this.finished = true;
      out.push({ kind: 'Stop', reason: this.mapFinish(finishReason) });
    }
    return out;
  }

  /** 流结束但从未收到 finishReason（异常截断）时兜底 Stop。 */
  flush(): ProviderEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [{ kind: 'Stop', reason: this.sawToolCall ? 'tool_use' : 'end_turn' }];
  }

  private mapFinish(r: string): 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' {
    if (this.sawToolCall) return 'tool_use';
    switch (r) {
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
      case 'RECITATION':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
        return 'refusal';
      default:
        return 'end_turn';
    }
  }
}
