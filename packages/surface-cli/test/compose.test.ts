import { describe, it, expect } from 'vitest';
import { selectProvider, usableContextTokens, buildCondenser } from '@yo-agent/surface-cli';
import { NoopCondenser, SummarizingCondenser } from '@yo-agent/kernel';
import { FakeProvider } from '@yo-agent/provider';

describe('selectProvider', () => {
  it('ANTHROPIC → anthropic；GEMINI → gemini', () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: 'x' } as NodeJS.ProcessEnv)).toMatchObject({ model: 'claude-opus-4-8', demo: false });
    expect(selectProvider({ ANTHROPIC_API_KEY: 'x' } as NodeJS.ProcessEnv).provider.id).toBe('anthropic');
    expect(selectProvider({ GEMINI_API_KEY: 'x' } as NodeJS.ProcessEnv).provider.id).toBe('gemini');
  });

  it('OPENAI_MODE=responses → openai-responses；YO_TOOL_SHIM=1 → 套 shim', () => {
    expect(selectProvider({ OPENAI_API_KEY: 'x', OPENAI_MODE: 'responses' } as NodeJS.ProcessEnv).provider.id).toBe('openai-responses');
    expect(selectProvider({ OPENAI_API_KEY: 'x' } as NodeJS.ProcessEnv).provider.id).toBe('openai-compatible');
    expect(selectProvider({ OPENAI_API_KEY: 'x', YO_TOOL_SHIM: '1' } as NodeJS.ProcessEnv).provider.id).toBe('openai-compatible+shim');
  });

  it('无 key → FakeProvider 演示态；YO_MODEL 覆盖模型', () => {
    const c = selectProvider({} as NodeJS.ProcessEnv, 'hi');
    expect(c.demo).toBe(true);
    expect(c.provider.id).toBe('fake');
    expect(selectProvider({ ANTHROPIC_API_KEY: 'x', YO_MODEL: 'claude-haiku-4-5' } as NodeJS.ProcessEnv).model).toBe('claude-haiku-4-5');
  });
});

describe('usableContextTokens', () => {
  it('已知模型取 contextWindow 的 80%；未知退默认', () => {
    expect(usableContextTokens('claude-opus-4-8')).toBe(800_000);
    expect(usableContextTokens('no-such')).toBe(160_000);
  });
});

describe('buildCondenser', () => {
  it('默认 Noop；YO_COMPACT=1 → SummarizingCondenser', () => {
    const p = new FakeProvider();
    expect(buildCondenser({} as NodeJS.ProcessEnv, p, 'm')).toBeInstanceOf(NoopCondenser);
    expect(buildCondenser({ YO_COMPACT: '1' } as NodeJS.ProcessEnv, p, 'm')).toBeInstanceOf(SummarizingCondenser);
  });
});
