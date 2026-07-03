// 审批往返 worker fixture（4.9c）：发一条 approval_request，等 decision 帧回来后把决定作为摘要返回。
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  if (msg?.type === 'approval_decision' && msg.id === 'a1') {
    parentPort.postMessage({
      summary: `decision:${msg.decision}${msg.autoReason ? `:${msg.autoReason}` : ''}`,
      isError: false,
    });
    parentPort.close(); // 摘要已发，关端口让 worker 自然退出（runner 在 exit 时 resolve）
  }
});
parentPort.postMessage({ type: 'approval_request', id: 'a1', tool: 'write', input: { path: '/tmp/x' }, risk: 'high' });
