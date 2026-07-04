import { defineExtension } from '@yo-agent/extension-host';

/**
 * 围栏测试 fixture：全部注册面用上再 setup 抛错（审查 HIGH-1）——hook/system 段/命令/onEvent
 * 须随 staging 回滚（半初始化 PreToolUse 残留会 fail-closed deny 一切）；工具靠健康 flag 显隐免回滚。
 */
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
  yo.on({
    onPreToolUse: () => {
      throw new Error('半初始化闭包炸了'); // 若残留进 HookBus → 全部工具被 fail-closed deny
    },
  });
  yo.addSystemSection('# 坏扩展的段');
  yo.registerCommand({ name: 'badcmd', desc: '坏扩展的命令', run: async () => {} });
  yo.onEvent(() => {
    throw new Error('坏监听');
  });
  throw new Error('setup 崩溃');
});
