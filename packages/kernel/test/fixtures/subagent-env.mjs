// 环境探针子 agent：回报自身可见 env，验证 secret 不泄漏给子 agent worker（默认白名单剥离）。
import { parentPort } from 'node:worker_threads';
parentPort.postMessage({
  summary: JSON.stringify({
    hasSecret: process.env.YO_SECRET_SENTINEL !== undefined,
    hasPath: !!process.env.PATH,
  }),
});
