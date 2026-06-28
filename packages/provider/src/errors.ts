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
  // 文本优先识别两类 status 可能含糊的情形（各家把 context 超限/计费耗尽都回 400/429）。
  // 审查 4F-MED：补 Anthropic「prompt is too long: N tokens > M maximum」、Gemini「exceeds the maximum number of tokens
  // / input token count」等文案——否则 flagship provider 真实超窗（HTTP 400）漏判 → 压缩重试安全网失效、turn 直接 fail。
  if (
    /context.{0,3}length|maximum context|too many tokens|context_length_exceeded|reduce the length|prompt is too long|too long|exceeds the maximum number of tokens|input token count|maximum.{0,12}tokens/.test(
      m,
    )
  ) {
    return 'context_overflow';
  }
  if (/insufficient_quota|billing|payment|insufficient funds|credit/.test(m)) return 'billing';
  if (status !== undefined) {
    if (status === 429) return 'rate_limit';
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'billing';
    if (status === 413) return 'context_overflow';
    if (status >= 500) return 'network';
    // 400 + token 字样兜底：超窗常回 400，与 billing 400 区分（billing 已在上面文本命中）。
    if (status === 400 && /token/.test(m)) return 'context_overflow';
  }
  // 审查 4F-MED：overload(ed) 属瞬时可重试（Anthropic overloaded_error），归 rate_limit 以驱动 fallback 换路由。
  if (/rate.?limit|quota|too many requests|overload(ed)?/.test(m)) return 'rate_limit';
  if (/invalid.{0,3}api.?key|unauthorized|authentication|permission denied|invalid x-api-key/.test(m)) return 'auth';
  if (/timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|network|fetch failed/.test(m)) return 'network';
  return 'unknown';
}
