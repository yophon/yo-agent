// 故意崩溃子 agent：worker 内抛未捕获异常（退出标准②的「Worker 内抛未捕获异常」判据）。
// 异步抛出 → 触发 Worker 'error' 事件 → runner reject → 管理器围栏收敛为 error 摘要。
setImmediate(() => {
  throw new Error('boom from subagent worker');
});
