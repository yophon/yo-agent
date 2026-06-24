/**
 * ModelCatalog —— models.dev 风的 bundled 模型目录（DESIGN §4.4 / §15.4）。
 * caps + pricing 随包内置，运行时 /models 发现可 merge 覆盖、未知 id 优雅降级（不硬编码 context window）。
 * 成本估算遵守 §15.4：cache read ≈ 0.1×、cache write ≈ 1.25×/2× 已折进各模型单价。
 */
import type { Usage } from '@yo-agent/protocol';
import bundled from './catalog.json';

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  displayName?: string;
  contextWindow: number;
  maxOutput: number;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  /** 缓存读单价（缺省按 input 的 0.1× 估，§15.4）。 */
  cacheReadPricePerMTok?: number;
  /** 缓存写单价（缺省按 input 的 1.25× 估，§15.4）。 */
  cacheWritePricePerMTok?: number;
  minCacheablePrefixTokens?: number;
  capabilities?: {
    nativeToolCalling?: boolean;
    thinking?: boolean;
    effort?: boolean;
    promptCache?: boolean;
  };
}

export class ModelCatalog {
  private readonly byId = new Map<string, ModelCatalogEntry>();

  constructor(entries: ModelCatalogEntry[] = bundled as ModelCatalogEntry[]) {
    for (const e of entries) this.byId.set(e.id, e);
  }

  /** 内置目录（随包发布）。 */
  static bundled(): ModelCatalog {
    return new ModelCatalog();
  }

  get(id: string): ModelCatalogEntry | undefined {
    return this.byId.get(id);
  }

  all(): ModelCatalogEntry[] {
    return [...this.byId.values()];
  }

  list(provider?: string): ModelCatalogEntry[] {
    const out = [...this.byId.values()];
    return provider ? out.filter((e) => e.provider === provider) : out;
  }

  /**
   * 运行时刷新（models.dev / provider /models 发现）：按 id 合并覆盖，未知 id 优雅新增。
   * 部分字段缺失时保留旧值（浅合并）。
   */
  merge(entries: ModelCatalogEntry[]): void {
    for (const e of entries) {
      const prev = this.byId.get(e.id);
      if (!prev) {
        this.byId.set(e.id, e);
        continue;
      }
      // 嵌套 capabilities 深合并：/models 发现常只回部分能力位，浅合并会整体覆盖丢 thinking/effort/promptCache。
      const capabilities = e.capabilities ? { ...prev.capabilities, ...e.capabilities } : prev.capabilities;
      this.byId.set(e.id, { ...prev, ...e, capabilities });
    }
  }

  /**
   * 成本估算（USD）。未知模型返回 undefined（优雅降级，不抛、不臆造）。
   * Anthropic 语义：input_tokens 已不含 cache 读/写，分别按各自单价计（§15.4）。
   */
  estimateCost(id: string, usage: Usage): number | undefined {
    const m = this.byId.get(id);
    if (!m) return undefined;
    const cacheReadPrice = m.cacheReadPricePerMTok ?? m.inputPricePerMTok * 0.1;
    const cacheWritePrice = m.cacheWritePricePerMTok ?? m.inputPricePerMTok * 1.25;
    const usd =
      (usage.inputTokens * m.inputPricePerMTok +
        usage.outputTokens * m.outputPricePerMTok +
        (usage.cacheReadTokens ?? 0) * cacheReadPrice +
        (usage.cacheCreationTokens ?? 0) * cacheWritePrice) /
      1_000_000;
    return usd;
  }

  /** 给 ContextAssembler 取目标模型最小可缓存前缀阈值（§15.4，低于则不打 cache_control）。 */
  minCacheablePrefix(id: string): number | undefined {
    return this.byId.get(id)?.minCacheablePrefixTokens;
  }

  /** 上下文窗口（usableTokens 触发 Condenser 用）；未知模型返回 undefined。 */
  contextWindow(id: string): number | undefined {
    return this.byId.get(id)?.contextWindow;
  }
}
