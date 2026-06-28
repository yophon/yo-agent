import { describe, it, expect } from 'vitest';
import { decideFallback } from '@yo-agent/kernel';

describe('4F — decideFallback（纯决策）', () => {
  it('context_overflow → compact（同模型压缩重试，即便已 commit）', () => {
    expect(decideFallback('context_overflow', { hasNext: false, committed: true })).toBe('compact');
    expect(decideFallback('context_overflow', { hasNext: true, committed: false })).toBe('compact');
  });

  it('rate_limit/network/billing/auth → switch（仅未 commit 且有下家）', () => {
    for (const c of ['rate_limit', 'network', 'billing', 'auth'] as const) {
      expect(decideFallback(c, { hasNext: true, committed: false })).toBe('switch');
      expect(decideFallback(c, { hasNext: false, committed: false })).toBe('fail'); // 无下家
      expect(decideFallback(c, { hasNext: true, committed: true })).toBe('fail'); // 已 commit 不漂移
    }
  });

  it('unknown / 未分类 → fail（不盲目重试）', () => {
    expect(decideFallback('unknown', { hasNext: true, committed: false })).toBe('fail');
    expect(decideFallback(undefined, { hasNext: true, committed: false })).toBe('fail');
  });
});
