import { describe, it, expect } from 'vitest';
import { ModelCatalog } from '@yo-agent/provider';

describe('ModelCatalog', () => {
  it('bundled 目录可查 caps/pricing/context window', () => {
    const cat = ModelCatalog.bundled();
    const opus = cat.get('claude-opus-4-8');
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.capabilities?.effort).toBe(true);
    expect(cat.contextWindow('claude-opus-4-8')).toBe(1_000_000);
    expect(cat.minCacheablePrefix('claude-opus-4-8')).toBe(4096);
    expect(cat.list('anthropic').length).toBeGreaterThanOrEqual(3);
  });

  it('estimateCost：input/output/cacheRead/cacheCreation 分别计价', () => {
    const cat = ModelCatalog.bundled();
    // opus: in 5 / out 25 / cacheRead 0.5 / cacheWrite 6.25（每 MTok）
    const cost = cat.estimateCost('claude-opus-4-8', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6);
  });

  it('未知模型 → estimateCost/get 优雅降级（undefined，不抛）', () => {
    const cat = ModelCatalog.bundled();
    expect(cat.get('no-such-model')).toBeUndefined();
    expect(cat.estimateCost('no-such-model', { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0 })).toBeUndefined();
  });

  it('merge 运行时刷新：覆盖已知 + 新增未知（浅合并保留旧字段）', () => {
    const cat = ModelCatalog.bundled();
    cat.merge([
      { id: 'claude-opus-4-8', provider: 'anthropic', contextWindow: 2_000_000, maxOutput: 128_000, inputPricePerMTok: 5, outputPricePerMTok: 25 },
      { id: 'brand-new', provider: 'x', contextWindow: 999, maxOutput: 1, inputPricePerMTok: 1, outputPricePerMTok: 1 },
    ]);
    expect(cat.get('claude-opus-4-8')?.contextWindow).toBe(2_000_000);
    expect(cat.get('claude-opus-4-8')?.capabilities?.effort).toBe(true); // 旧字段保留
    expect(cat.get('brand-new')?.contextWindow).toBe(999);
  });

  it('merge 对 capabilities 深合并：partial 能力位不丢旧子字段', () => {
    const cat = ModelCatalog.bundled();
    // /models 发现只回部分能力位（仅 nativeToolCalling）。
    cat.merge([
      { id: 'claude-opus-4-8', provider: 'anthropic', contextWindow: 1_000_000, maxOutput: 128_000, inputPricePerMTok: 5, outputPricePerMTok: 25, capabilities: { nativeToolCalling: true } },
    ]);
    const caps = cat.get('claude-opus-4-8')?.capabilities;
    expect(caps?.nativeToolCalling).toBe(true);
    expect(caps?.thinking).toBe(true); // 旧子字段不被覆盖丢失
    expect(caps?.effort).toBe(true);
  });
});
