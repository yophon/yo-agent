import { describe, expect, it } from 'vitest';
import { FakeProvider } from '@yo-agent/provider';
import { resolveWebAgentConfig } from '@yo-agent/surface-web';

describe('resolveWebAgentConfig（双模式统一配置）', () => {
  it('模式 B（中转站直连）：缺省项按约定填充', () => {
    const r = resolveWebAgentConfig({
      connection: { provider: 'openai', model: ' gpt-5.5 ', baseUrl: 'https://relay.example/v1', apiKey: 'sk-x' },
    });
    expect(r.connection.model).toBe('gpt-5.5'); // trim
    expect(r.tools).toEqual([]);
    expect(r.approval).toBe('auto');
    expect(r.compaction).toBe(false);
    expect(r.loopBreakerMode).toBe('loose');
  });

  it('模式 A（自建后端代理）：有 baseUrl 时 apiKey 可空', () => {
    const r = resolveWebAgentConfig({
      connection: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        baseUrl: 'https://api.example.com/llm',
        headers: { authorization: 'Bearer host-token' },
      },
    });
    expect(r.connection.apiKey).toBeUndefined();
  });

  it('直连官方端点（无 baseUrl）且无 apiKey → 可行动错误', () => {
    expect(() =>
      resolveWebAgentConfig({ connection: { provider: 'anthropic', model: 'claude-sonnet-5' } }),
    ).toThrow(/缺少 connection\.apiKey/);
  });

  it('缺 model → 可行动错误', () => {
    expect(() =>
      resolveWebAgentConfig({ connection: { provider: 'openai', model: '  ', apiKey: 'sk-x' } }),
    ).toThrow(/connection\.model/);
  });

  it('未知 provider 种类 → 可行动错误（列出可选值）', () => {
    expect(() =>
      resolveWebAgentConfig({
        connection: { provider: 'llama' as never, model: 'm', apiKey: 'k' },
      }),
    ).toThrow(/未知 connection\.provider.*anthropic/);
  });

  it('providerOverride（自定义 provider）跳过连接校验，只要 model', () => {
    const r = resolveWebAgentConfig({
      connection: { provider: 'x' as never, model: 'fake-model' },
      providerOverride: new FakeProvider(),
    });
    expect(r.providerOverride).toBeDefined();
  });
});
