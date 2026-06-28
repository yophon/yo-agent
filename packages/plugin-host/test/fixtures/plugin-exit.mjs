// 主动退出插件：被调用即 process.exit(7)（worker 非 0 'exit'）——验证 invoke 触发的崩溃也被围栏收敛、主进程存活。
export default {
  name: 'exit',
  tools: [
    {
      name: 'exit_now',
      kind: 'other',
      description: '自杀',
      inputSchema: { type: 'object' },
      handler: () => {
        process.exit(7);
      },
    },
  ],
};
