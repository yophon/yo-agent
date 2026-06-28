import { describe, it, expect } from 'vitest';
import { classifyError } from '@yo-agent/provider';

describe('4F — classifyError（错误归类驱动 fallback）', () => {
  it('按 HTTP status 归类', () => {
    expect(classifyError(429, 'Too Many Requests')).toBe('rate_limit');
    expect(classifyError(401, 'unauthorized')).toBe('auth');
    expect(classifyError(403, 'forbidden')).toBe('auth');
    expect(classifyError(402, 'payment required')).toBe('billing');
    expect(classifyError(413, 'payload too large')).toBe('context_overflow');
    expect(classifyError(503, 'service unavailable')).toBe('network');
  });

  it('按文本归类（status 缺失/含糊时）', () => {
    expect(classifyError(400, 'This model maximum context length is 200000 tokens')).toBe('context_overflow');
    expect(classifyError(400, 'context_length_exceeded')).toBe('context_overflow');
    expect(classifyError(429, 'insufficient_quota: billing hard limit reached')).toBe('billing'); // 文本优先于 429
    expect(classifyError(undefined, 'Invalid API key provided')).toBe('auth');
    expect(classifyError(undefined, 'fetch failed: ECONNRESET')).toBe('network');
    expect(classifyError(undefined, 'rate limit exceeded')).toBe('rate_limit');
  });

  it('无法识别 → unknown（不盲目重试）', () => {
    expect(classifyError(undefined, '某些奇怪的错误')).toBe('unknown');
    expect(classifyError(418, "I'm a teapot")).toBe('unknown');
  });

  // ───── 收口安全修复回归（4F-MED）─────

  it('收口：Anthropic/Gemini context-overflow 文案归 context_overflow（压缩重试安全网不失效）', () => {
    expect(classifyError(400, 'prompt is too long: 215534 tokens > 204798 maximum')).toBe('context_overflow');
    expect(classifyError(400, 'input exceeds the maximum number of tokens')).toBe('context_overflow');
    expect(classifyError(400, 'The input token count exceeds the limit')).toBe('context_overflow');
    expect(classifyError(400, 'request failed for token reasons')).toBe('context_overflow'); // 400+token 兜底
  });

  it('收口：overloaded 归 rate_limit（早期瞬时错误驱动 fallback 换路由）', () => {
    expect(classifyError(undefined, 'overloaded_error Overloaded')).toBe('rate_limit');
    expect(classifyError(undefined, 'Overloaded')).toBe('rate_limit');
  });
});
