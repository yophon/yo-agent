/**
 * WebAgentConfig —— 双连接模式的统一配置（PHASE-5 §0）。
 * 模式 A「自建后端」：baseUrl 指自建 LLM 代理，apiKey 可空（代理侧注入），鉴权走 headers 宿主令牌/同域 cookie；
 * 模式 B「中转站直连」：用户自带 OpenAI 兼容 / Anthropic 端点 + 自己的 key；tools 可选（零工具纯对话）。
 * 两种模式 = 同一结构的不同取值，不设模式开关字段。
 */
import type { ApprovalGate } from '@yo-agent/kernel/core';
import type { Provider } from '@yo-agent/provider';
import { AnthropicProvider, GeminiProvider, OpenAiCompatibleProvider, OpenAiResponsesProvider } from '@yo-agent/provider';
import type { RegisteredTool } from '@yo-agent/tools/core';

export type WebProviderKind = 'anthropic' | 'openai' | 'openai-responses' | 'gemini';

const PROVIDER_KINDS: readonly WebProviderKind[] = ['anthropic', 'openai', 'openai-responses', 'gemini'];

export interface WebConnection {
  provider: WebProviderKind;
  model: string;
  /** 模式 A：自建代理；模式 B：中转站。缺省 = 官方端点（此时 apiKey 必填）。 */
  baseUrl?: string;
  /** 模式 B 必填；模式 A 可空（key 由代理侧注入）。 */
  apiKey?: string;
  /** 宿主鉴权令牌 / anthropic-dangerous-direct-browser-access 等追加请求头。 */
  headers?: Record<string, string>;
  defaultMaxTokens?: number;
}

export interface WebAgentConfig {
  connection: WebConnection;
  /** system prompt：宿主可先从后端取一段再传入；缺省不注入（内核允许空 system）。 */
  system?: string;
  /** 可选——模式 B 可零工具纯对话；配 defineHttpTool 把后端业务 API 声明成工具。 */
  tools?: RegisteredTool[];
  /**
   * 审批策略。缺省 'auto'（全自动放行）：客服场景的安全边界在后端工具 API 的服务端鉴权
   * ——agent loop 在客户端、可被用户篡改，工具必须按公开 API 标准防御，审批 UI 不是防线。
   * 宿主要弹确认条时传自定义 ApprovalGate。
   */
  approval?: 'auto' | ApprovalGate;
  /** true → SummarizingCondenser 上下文压缩（用同一连接的模型摘要）；缺省 Noop。 */
  compaction?: boolean;
  /** 死循环熔断档位，缺省 'loose'（对齐 CLI 默认）。 */
  loopBreakerMode?: 'off' | 'loose' | 'strict';
  maxStepsPerTurn?: number;
  /** 注入自定义 Provider（测试 FakeProvider / 非内置协议）；设了则 connection 仅 model 生效。 */
  providerOverride?: Provider;
}

export interface ResolvedWebAgentConfig {
  connection: WebConnection;
  system?: string;
  tools: RegisteredTool[];
  approval: 'auto' | ApprovalGate;
  compaction: boolean;
  loopBreakerMode: 'off' | 'loose' | 'strict';
  maxStepsPerTurn?: number;
  providerOverride?: Provider;
}

/** 配置解析校验（纯函数）：错误全部可行动——报缺什么、该怎么给。 */
export function resolveWebAgentConfig(cfg: WebAgentConfig): ResolvedWebAgentConfig {
  const c = cfg.connection;
  if (!c?.model?.trim()) {
    throw new Error('WebAgentConfig 缺少 connection.model：必填，如 "claude-sonnet-5"');
  }
  if (!cfg.providerOverride) {
    if (!PROVIDER_KINDS.includes(c.provider)) {
      throw new Error(`未知 connection.provider：${String(c.provider)}（可选：${PROVIDER_KINDS.join(' / ')}）`);
    }
    if (!c.baseUrl && !c.apiKey) {
      throw new Error('缺少 connection.apiKey：直连官方端点必须自带 key；接自建代理/中转站请设 baseUrl（key 可由代理侧注入）');
    }
  }
  return {
    connection: { ...c, model: c.model.trim() },
    system: cfg.system,
    tools: cfg.tools ?? [],
    approval: cfg.approval ?? 'auto',
    compaction: cfg.compaction ?? false,
    loopBreakerMode: cfg.loopBreakerMode ?? 'loose',
    maxStepsPerTurn: cfg.maxStepsPerTurn,
    providerOverride: cfg.providerOverride,
  };
}

/** 按连接配置实例化内置 provider（5A 起四家全支持 baseUrl/headers 注入 + 浏览器安全）。 */
export function makeWebProvider(c: WebConnection): Provider {
  const opts = { apiKey: c.apiKey, baseUrl: c.baseUrl, headers: c.headers, defaultMaxTokens: c.defaultMaxTokens };
  switch (c.provider) {
    case 'anthropic':
      return new AnthropicProvider(opts);
    case 'openai':
      return new OpenAiCompatibleProvider(opts);
    case 'openai-responses':
      return new OpenAiResponsesProvider(opts);
    case 'gemini':
      return new GeminiProvider(opts);
  }
}
