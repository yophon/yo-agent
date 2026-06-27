// 故意主动退出子 agent：未回 message 即 process.exit(非0)（退出标准②的「主动退出等价物」判据）。
// 触发 Worker 'exit' 事件（无 message）→ runner reject → 管理器围栏收敛为 error 摘要。
process.exit(7);
