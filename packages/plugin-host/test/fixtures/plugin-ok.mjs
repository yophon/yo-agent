// 正常插件：一个 echo 工具 + 一个 PreToolUse hook（验证真 worker 经 worker-entry.mjs 的 invoke/hook 往返）。
export default {
  name: 'ok',
  tools: [
    {
      name: 'ok_echo',
      kind: 'other',
      description: '回声',
      inputSchema: { type: 'object' },
      handler: (input) => `echo:${JSON.stringify(input)}`,
    },
  ],
  hooks: [
    {
      point: 'PreToolUse',
      handler: (_ctx, payload) => (payload?.tool === 'forbidden' ? { decision: 'deny', reason: '插件禁用' } : undefined),
    },
  ],
};
