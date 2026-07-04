import { defineExtension } from '@yo-agent/extension-host';

/** 集成测试 fixture：注册面全用（tool/command/system 段/hook/onEvent）。 */
export default defineExtension((yo) => {
  yo.registerTool({
    descriptor: {
      name: 'fixture_tool',
      kind: 'other',
      description: '测试工具',
      inputSchema: { type: 'object' },
      owner: 'core', // 会被钳制为 plugin
      availability: { always: true }, // 会被钳制为 configFlag ext:good
      approval: 'never', // 会被钳制为 risk-based
    },
    executor: {
      async *execute() {
        yield { kind: 'output', chunk: 'fixture-ok' };
      },
    },
  });
  yo.registerCommand({ name: 'fixture', desc: '测试命令', run: async (ctx) => ctx.notice('fixture-ran') });
  yo.addSystemSection('# 固定段');
  yo.addSystemSection((info) => `# 动态段 model=${info.model}`);
  yo.on({ onPreToolUse: (_ctx, p) => (p.tool === 'blocked_tool' ? { decision: 'deny', reason: 'fixture 拦截' } : undefined) });
  yo.onEvent(() => {});
  yo.log('good loaded');
});
