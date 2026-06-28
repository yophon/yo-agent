import type { ErrorCategory } from '@yo-agent/protocol';
import type { Provider } from '@yo-agent/provider';

/**
 * Provider fallback 链 / auth rotation（4F / DESIGN §4.4）。
 *
 * 一条「路由」= 一个 provider 实例 + 模型 id（+ 可选标签）。fallback 链 = [主, 备1, 备2…]；
 * 「换 key」建模为同 provider 不同 key 的另一条路由，「换 provider」= 不同 provider 的路由。
 *
 * 教训（LangBot）：**工具调用循环内 commit 首个成功模型**——一旦某 turn 已产出（含工具调用），
 * 后续 step 不得换模型，否则跨模型解读 tool_result 不一致。故 fallback 只在「本 turn 尚未产出」时允许换路由。
 */
export interface ProviderRoute {
  provider: Provider;
  model: string;
  label?: string;
}

/** 内核对一次 provider 错误的 fallback 决策。 */
export type FallbackAction = 'switch' | 'compact' | 'fail';

export interface FallbackContext {
  /** 链中是否还有下一条路由可换。 */
  hasNext: boolean;
  /** 本 turn 是否已 commit 成功模型（已产出）；已 commit 则不得换模型（防跨模型漂移）。 */
  committed: boolean;
}

/**
 * 据错误归类决策（纯函数，可单测）：
 *   - `context_overflow` → **compact**（同模型压缩后重试，即便已 commit——不换模型，只缩窗口）。
 *   - `rate_limit` / `network` / `billing` / `auth` → **switch**（换路由：换 key / 换 provider）——
 *     仅当**未 commit 且有下家**；否则 **fail**（已产出则不漂移、无下家则放弃）。
 *   - 其余（`unknown`/未分类）→ **fail**（不盲目重试）。
 */
export function decideFallback(category: ErrorCategory | undefined, ctx: FallbackContext): FallbackAction {
  switch (category) {
    case 'context_overflow':
      return 'compact';
    case 'rate_limit':
    case 'network':
    case 'billing':
    case 'auth':
      return !ctx.committed && ctx.hasNext ? 'switch' : 'fail';
    default:
      return 'fail';
  }
}
