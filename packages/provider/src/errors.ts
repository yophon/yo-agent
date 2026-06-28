import type { ErrorCategory } from './types';

/**
 * 把 HTTP status + 错误文本归类（4F / DESIGN §4.4），驱动内核 fallback 决策：
 *   - 429 / quota / rate limit            → rate_limit（换 key / 换 provider）
 *   - 401 / 403 / invalid api key         → auth（换 provider）
 *   - 402 / billing / insufficient_quota / payment → billing（换 provider）
 *   - context length / too many tokens / 413 → context_overflow（触发压缩重试）
 *   - 5xx / fetch 失败 / timeout / ECONN* → network（重试 / 换路由）
 *   - 其余                                 → unknown（不盲目重试）
 *
 * 文本匹配大小写不敏感；status 优先于文本（更可靠）。纯函数、可单测。
 */
export function classifyError(status: number | undefined, message: string): ErrorCategory {
  const m = message.toLowerCase();
  // 文本优先识别两类 status 可能含糊的情形（OpenAI 把 context 超限/计费耗尽都回 400/429）。
  if (/context.{0,3}length|maximum context|too many tokens|context_length_exceeded|reduce the length/.test(m)) {
    return 'context_overflow';
  }
  if (/insufficient_quota|billing|payment|insufficient funds|credit/.test(m)) return 'billing';
  if (status !== undefined) {
    if (status === 429) return 'rate_limit';
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'billing';
    if (status === 413) return 'context_overflow';
    if (status >= 500) return 'network';
  }
  if (/rate.?limit|quota|too many requests/.test(m)) return 'rate_limit';
  if (/invalid.{0,3}api.?key|unauthorized|authentication|permission denied|invalid x-api-key/.test(m)) return 'auth';
  if (/timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|network|fetch failed/.test(m)) return 'network';
  return 'unknown';
}
