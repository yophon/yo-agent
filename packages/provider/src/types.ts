/**
 * Provider 抽象的类型契约（DESIGN §4 / §15.4）。
 * 内核永不按 provider 分支；BYOK 多家归一成一条 Stream<ProviderEvent> + 双轨 tool-calling。
 */
import type { Effort, Usage } from '@yo-agent/protocol';

export interface ToolSpec {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'none' };

/** 归一消息内容块。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  // name：工具函数名。Gemini 靠 functionResponse.name（非 id）关联回 functionCall，故必须携带真名（非合成 call id）。
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; name?: string };

/** 归一消息（含 tool_result）。 */
export interface CanonMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
}

export interface ChatRequest {
  modelId: string;
  messages: CanonMessage[];
  tools: ToolSpec[];
  toolChoice?: ToolChoice;
  system?: string;
  /** 推理力度独立归一轴；AnthropicProvider 译为 output_config.effort（§15.4，非 budget_tokens）。 */
  effort?: Effort;
  maxTokens?: number;
  /** metadata.user_id 滥用检测归因（§15.4）。 */
  userId?: string;
  /** 逃生口：透传 provider 专属参数。 */
  providerOptions?: Record<string, unknown>;
}

export type ProviderEvent =
  | { kind: 'TextDelta'; text: string }
  | { kind: 'ThinkingDelta'; text: string }
  | { kind: 'ToolCallStart'; id: string; name: string }
  | { kind: 'ToolCallArgsDelta'; id: string; delta: string } // 累积拼完才 JSON.parse（§15.4）
  | { kind: 'ToolCallEnd'; id: string }
  | { kind: 'UsageUpdate'; usage: Usage }
  | { kind: 'Stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' }
  | { kind: 'Error'; error: { message: string; status?: number; retryable?: boolean } };

export interface ProviderCapabilities {
  nativeToolCalling: boolean;
  thinking: boolean;
  promptCache: boolean;
  /** 最小可缓存前缀按模型不同（§15.4：Opus 4.8=4096，Sonnet 4.6=2048…）。 */
  minCacheablePrefixTokens?: number;
  effort: boolean;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutput?: number;
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
}

export interface Provider {
  readonly id: string;
  streamChat(req: ChatRequest): AsyncIterable<ProviderEvent>;
  listModels(): Promise<ModelInfo[]>;
  readonly capabilities: ProviderCapabilities;
}
