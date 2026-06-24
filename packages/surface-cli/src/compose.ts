/**
 * 组合根辅助（DESIGN §4 / §5.1）：按环境变量选 provider（多 provider BYOK + 双轨 shim），
 * 从模型目录推算可用上下文窗口、构建 Condenser。纯函数化（注入 env），便于离线单测。
 */
import {
  AnthropicProvider,
  FakeProvider,
  GeminiProvider,
  ModelCatalog,
  OpenAiCompatibleProvider,
  OpenAiResponsesProvider,
  PromptShimProvider,
  textTurn,
} from '@yo-agent/provider';
import type { Provider } from '@yo-agent/provider';
import { NoopCondenser, SummarizingCondenser, makeProviderSummarizer } from '@yo-agent/kernel';
import type { Condenser } from '@yo-agent/kernel';

export interface ProviderChoice {
  provider: Provider;
  model: string;
  /** FakeProvider 演示态（无 key），用于 UI 提示。 */
  demo: boolean;
}

/**
 * provider 选择优先级：ANTHROPIC → GEMINI → OPENAI(responses|chat，可叠 shim) → FakeProvider 演示。
 * YO_MODEL 覆盖默认模型；OPENAI_MODE=responses 走 /v1/responses；YO_TOOL_SHIM=1 给弱/本地模型套 prompt-shim。
 */
export function selectProvider(env: NodeJS.ProcessEnv, prompt = ''): ProviderChoice {
  const model = env.YO_MODEL;
  if (env.ANTHROPIC_API_KEY) return { provider: new AnthropicProvider(), model: model ?? 'claude-opus-4-8', demo: false };
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return { provider: new GeminiProvider(), model: model ?? 'gemini-2.0-flash', demo: false };
  if (env.OPENAI_API_KEY) {
    if (env.OPENAI_MODE === 'responses') {
      return { provider: new OpenAiResponsesProvider(), model: model ?? 'gpt-4o', demo: false };
    }
    let provider: Provider = new OpenAiCompatibleProvider({ baseUrl: env.OPENAI_BASE_URL });
    if (env.YO_TOOL_SHIM === '1') provider = new PromptShimProvider(provider); // 双轨：弱/本地模型回退
    return { provider, model: model ?? 'gpt-4o', demo: false };
  }
  const fake = new FakeProvider();
  fake.script(
    textTurn(`（FakeProvider 演示）收到："${prompt}"。设置 ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY 接真实模型。`),
  );
  return { provider: fake, model: model ?? 'fake-model', demo: true };
}

/** 可用上下文窗口（token）：模型目录 contextWindow 的 80%，未知模型退默认。 */
export function usableContextTokens(model: string, catalog: ModelCatalog = ModelCatalog.bundled()): number {
  const cw = catalog.contextWindow(model);
  return cw ? Math.floor(cw * 0.8) : 160_000;
}

/**
 * 构建 Condenser：YO_COMPACT=1 时启用真 Condenser（用便宜模型摘要，缺省 YO_COMPACT_MODEL 或同 provider 模型），
 * 否则 NoopCondenser。
 */
export function buildCondenser(env: NodeJS.ProcessEnv, provider: Provider, model: string): Condenser {
  if (env.YO_COMPACT !== '1') return new NoopCondenser();
  const summaryModel = env.YO_COMPACT_MODEL ?? model;
  return new SummarizingCondenser({ summarize: makeProviderSummarizer(provider, summaryModel) });
}
