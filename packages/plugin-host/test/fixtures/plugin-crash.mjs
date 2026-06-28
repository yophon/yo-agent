// 故意崩溃插件：握手 ready 后短延时抛未捕获异常（worker 'error'）——验证退出标准③：
// 主进程存活 + host 检测到崩溃 + 撤健康标志 → 工具降级不可见。
setTimeout(() => {
  throw new Error('boom from plugin worker');
}, 30);

export default {
  name: 'crash',
  tools: [{ name: 'crash_noop', kind: 'other', description: 'noop', inputSchema: { type: 'object' }, handler: () => 'ok' }],
};
