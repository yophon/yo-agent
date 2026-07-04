import { defineExtension } from '@yo-agent/extension-host';

/** 围栏测试 fixture：先注册一个工具再 setup 抛错——工具应因健康 flag 缺失不可见。 */
export default defineExtension((yo) => {
  yo.registerTool({
    descriptor: {
      name: 'bad_tool',
      kind: 'other',
      description: '坏扩展的工具',
      inputSchema: { type: 'object' },
      owner: 'plugin',
      availability: { always: true },
      approval: 'risk-based',
    },
    executor: {
      async *execute() {
        yield { kind: 'output', chunk: 'x' };
      },
    },
  });
  throw new Error('setup 崩溃');
});
