import type { ToolKind } from '@yo-agent/protocol';
import type { HookPoint, PreToolUseDecision } from '@yo-agent/kernel';
import type { PluginHookCtx, PluginToolCtx } from './protocol';

/**
 * 插件作者 SDK（4E）：类型化定义插件的工具与 hook，default export 给 worker-entry.mjs 加载。
 * 纯类型 + 恒等函数——运行时形状即插件模块的默认导出（插件也可不依赖本 SDK 直接导出同形状对象）。
 *
 * 示例（插件作者写 plugin.mjs / plugin.js）：
 *   import { definePlugin } from '@yo-agent/plugin-host';
 *   export default definePlugin({
 *     name: 'hello',
 *     tools: [{ name: 'hello_echo', kind: 'other', description: '回声', inputSchema: { type: 'object' },
 *               handler: (input) => `echo:${JSON.stringify(input)}` }],
 *     hooks: [{ point: 'PreToolUse', handler: (ctx, p) => undefined }],
 *   });
 */

/** 工具 handler：返回 string / Promise<string> / 异步分片（流式输出）；抛错 → 工具 isError。 */
export type PluginToolHandler = (
  input: unknown,
  ctx: PluginToolCtx,
) => string | Promise<string> | AsyncIterable<string>;

export interface PluginToolDef {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 至多 'always' | 'risk-based'；host 恒钳制掉 'never'（插件工具不可绕审批）。 */
  approval?: 'always' | 'risk-based';
  handler: PluginToolHandler;
}

/** hook handler：PreToolUse 返回裁决（allow/deny，可改写 input）；其余观测型返回 void。 */
export type PluginHookHandler = (
  ctx: PluginHookCtx,
  payload: unknown,
) => PreToolUseDecision | void | Promise<PreToolUseDecision | void>;

export interface PluginHookDef {
  point: HookPoint;
  handler: PluginHookHandler;
}

export interface PluginDefinition {
  name: string;
  tools?: PluginToolDef[];
  hooks?: PluginHookDef[];
}

/** 恒等定义器（仅给作者类型推断；运行时直接返回入参）。 */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
