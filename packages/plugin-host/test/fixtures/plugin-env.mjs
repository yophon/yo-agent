// 环境探针插件：回报自身可见 env，验证 secret 不泄漏给插件 Worker（默认白名单剥离）。
export default {
  name: 'env',
  tools: [
    {
      name: 'env_probe',
      kind: 'other',
      description: '探测 env',
      inputSchema: { type: 'object' },
      handler: () =>
        JSON.stringify({
          hasSecret: process.env.YO_SECRET_SENTINEL !== undefined,
          hasPath: !!process.env.PATH,
        }),
    },
  ],
};
