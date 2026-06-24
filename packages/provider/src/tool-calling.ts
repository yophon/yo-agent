/**
 * 双轨函数调用归一（DESIGN §4.3 / ADR-3）。
 * 强模型走 native function-calling；弱/本地模型（Ollama / LM Studio 等无 native）走 prompt-and-parse 回退
 * （借鉴 Cline Native-JSON+XML / OpenHands NonNativeToolCallingMixin / Goose Tool Shim）。
 *
 * 本文件全离线可测：encodeToolsAsPrompt / parseToolCallsFromText 是纯函数；
 * PromptShimProvider 包一个 native=false 的 base Provider，把工具声明注入 prompt，
 * 并把模型吐出的 tool_call JSON 文本解析回 ToolCall*（合成 id）。
 */
import type { ChatRequest, ProviderEvent, ToolSpec } from './types';
import type { Provider, ProviderCapabilities } from './types';

export interface ParsedToolCall {
  name: string;
  arguments: unknown;
}

/** 把工具声明编码进 system prompt（弱模型无 native function-calling 时）。 */
export function encodeToolsAsPrompt(tools: ToolSpec[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map(
    (t) => `- ${t.name}: ${t.description}\n  参数 JSON Schema: ${JSON.stringify(t.jsonSchema)}`,
  );
  return [
    '你可以调用以下工具。需要调用时，只输出一个 fenced 代码块，语言标记为 `tool_call`，',
    '块内是单个 JSON 对象 `{"name": "<工具名>", "arguments": {<参数>}}`，不要附加其它解释。',
    '可在一条回复中输出多个 tool_call 块以并行调用。无需调用工具时正常作答。',
    '',
    '可用工具：',
    ...lines,
  ].join('\n');
}

const TOOL_CALL_BLOCK = /```tool_call\s*\n([\s\S]*?)```/g;
// 未闭合的尾部 tool_call 块（模型 max_tokens 截断在 JSON 中途）：不应作为可见文本泄漏。
const UNCLOSED_TOOL_CALL = /```tool_call\s*\n[\s\S]*$/;

/**
 * 从模型文本中解析 tool_call fenced 块；返回解析出的调用与剥除调用块后的"干净文本"。
 * 解析失败的块整体忽略（容错），不抛；未闭合的尾部块也一并剥除（避免内部语法泄漏给用户）。
 */
export function parseToolCallsFromText(text: string): { calls: ParsedToolCall[]; cleanedText: string } {
  const calls: ParsedToolCall[] = [];
  for (const m of text.matchAll(TOOL_CALL_BLOCK)) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw) as { name?: unknown; arguments?: unknown };
      if (obj && typeof obj.name === 'string') {
        calls.push({ name: obj.name, arguments: obj.arguments ?? {} });
      }
    } catch {
      /* 容错：忽略无法解析的块 */
    }
  }
  const cleaned = text.replace(TOOL_CALL_BLOCK, '').replace(UNCLOSED_TOOL_CALL, '').trim();
  return { calls, cleanedText: cleaned };
}

export interface ToolCallingStrategy {
  readonly mode: 'native' | 'prompt-shim';
  /** 是否需要把 tools 从请求里抽走、改注入 prompt。 */
  shimRequest(req: ChatRequest): ChatRequest;
}

/** native：透传，工具走原生字段（强模型）。 */
export const nativeStrategy: ToolCallingStrategy = {
  mode: 'native',
  shimRequest: (req) => req,
};

/** prompt-shim：工具声明注入 system，清空 native tools（弱/本地模型）。 */
export const promptShimStrategy: ToolCallingStrategy = {
  mode: 'prompt-shim',
  shimRequest: (req) => {
    if (req.tools.length === 0) return req;
    const instructions = encodeToolsAsPrompt(req.tools);
    const system = [req.system, instructions].filter(Boolean).join('\n\n');
    return { ...req, system, tools: [] };
  },
};

/** 按 provider 能力自动选择双轨策略（§4.3）。 */
export function selectStrategy(caps: ProviderCapabilities): ToolCallingStrategy {
  return caps.nativeToolCalling ? nativeStrategy : promptShimStrategy;
}

/**
 * PromptShimProvider —— 给无 native function-calling 的弱/本地模型补上工具调用能力。
 * 包一个 base Provider：注入工具声明 → 缓冲全部文本 → Stop 时解析 tool_call → 合成 ToolCall* 事件。
 * 缓冲（而非边流边发）是为正确性：tool_call JSON 不应作为可见文本泄漏给用户（弱模型可接受非流式）。
 */
export class PromptShimProvider implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly base: Provider;

  constructor(base: Provider) {
    this.base = base;
    this.id = `${base.id}+shim`;
    this.capabilities = { ...base.capabilities, nativeToolCalling: true };
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const shimmed = promptShimStrategy.shimRequest(req);
    let buf = '';
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' = 'end_turn';
    let stopped = false;
    let callSeq = 0;

    for await (const ev of this.base.streamChat(shimmed)) {
      switch (ev.kind) {
        case 'TextDelta':
          buf += ev.text; // 缓冲，先不外发
          break;
        case 'Stop':
          stopReason = ev.reason;
          stopped = true;
          break;
        case 'ThinkingDelta':
        case 'UsageUpdate':
        case 'Error':
          yield ev; // 透传
          break;
        default:
          break; // base 无 native 工具事件，忽略
      }
      if (ev.kind === 'Error') return;
    }

    const { calls, cleanedText } = parseToolCallsFromText(buf);
    if (cleanedText) yield { kind: 'TextDelta', text: cleanedText };
    if (calls.length > 0) {
      for (const c of calls) {
        const id = `shim_call_${++callSeq}`;
        yield { kind: 'ToolCallStart', id, name: c.name };
        yield { kind: 'ToolCallArgsDelta', id, delta: JSON.stringify(c.arguments ?? {}) };
        yield { kind: 'ToolCallEnd', id };
      }
      yield { kind: 'Stop', reason: 'tool_use' };
      return;
    }
    yield { kind: 'Stop', reason: stopped ? stopReason : 'end_turn' };
  }

  listModels(): ReturnType<Provider['listModels']> {
    return this.base.listModels();
  }
}
