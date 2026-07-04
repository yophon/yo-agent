import { defineExtension } from '@yo-agent/extension-host';
import type { ExtensionApi } from '@yo-agent/extension-host';

/** 行动面测试 fixture：把 api 捕获到 globalThis，测试直接驱动 exec/steer/followUp/onEvent。 */
export default defineExtension((yo) => {
  (globalThis as Record<string, unknown>).__yoCapturedApi = yo satisfies ExtensionApi;
});
