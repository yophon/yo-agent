// 正常子 agent worker：回一条摘要后退出（验证 WorkerSubagentRunner 正常路径）。
import { parentPort, workerData } from 'node:worker_threads';
parentPort.postMessage({ summary: `worker-ok:${workerData?.task ?? ''}`, isError: false });
