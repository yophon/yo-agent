import { Worker } from 'node:worker_threads';
import type { HostToWorker, PluginManifest, WorkerToHost } from './protocol';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from './protocol';
import type { PreToolUseDecision } from '@yo-agent/kernel';

/**
 * 插件传输档抽象（仿 ExecBackend/SubagentRunner，ADR-19/ADR-17 范式）：把「Worker 进程隔离」收成可换接口——
 *   - {@link WorkerPluginTransport}：生产默认，真 worker_threads + secret 剥离（退出标准③的硬隔离形态）。
 *   - 测试用内存假传输直接驱动事件（确定性模拟崩溃/心跳丢失），不碰 worker loader 脆弱性（4C 教训）。
 *
 * host 只依赖此接口；崩溃（Worker 'error' / 非 0 'exit'）经 onCrash 上抛，由 host 收敛为「降级 + 重连」。
 */

/** host 侧事件回调（transport 收到 Worker 消息 / 崩溃时调用）。 */
export interface PluginTransportEvents {
  onReady(manifest: PluginManifest): void;
  onChunk(callId: number, chunk: string): void;
  onDone(callId: number, isError: boolean, error: string | undefined): void;
  onHookResult(callId: number, decision: PreToolUseDecision | undefined): void;
  onHeartbeat(seq: number): void;
  onLog(level: string, msg: string): void;
  /** Worker 崩溃/异常退出（未捕获异常 / 非 0 退出 / terminate）；host 据此降级该插件。 */
  onCrash(reason: string): void;
}

export interface PluginTransport {
  readonly id: string;
  /** 装上事件回调并启动底层 Worker。 */
  start(events: PluginTransportEvents): void;
  /** 下发主→Worker 消息（结构化克隆）。 */
  send(msg: HostToWorker): void;
  /** 终止底层 Worker（幂等）。 */
  terminate(): Promise<void>;
}

/** 子 agent worker 默认环境白名单同源（剥离 yo-agent 自身 secret：API key/设备私钥/OAuth token）。 */
const ENV_WHITELIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ', 'PWD'];

export interface WorkerTransportOpts {
  /** 插件 id（= 健康标志 plugin:<id> 的后缀）。 */
  id: string;
  /** Worker 入口（生产指向自洽的 worker-entry.mjs；测试可传自洽 .mjs fixture）。 */
  entry: string | URL;
  /** 传给 Worker 的 workerData（如 { modulePath, heartbeatIntervalMs }）。 */
  workerData?: unknown;
  /** 传给 Worker 的环境；缺省按白名单从 process.env 过滤（剥离 secret）。传 null 给空环境。 */
  env?: NodeJS.ProcessEnv | null;
}

/**
 * worker_threads 隔离档（ADR-18 默认）：插件跑在独立 Worker 线程——
 * **崩溃围栏的硬隔离形态**：worker 'error'（未捕获异常）/ 非 0 'exit'（主动退出/越权被杀）/ terminate（看门狗判死）
 * 全部经 onCrash 上抛；host 据此撤健康标志（工具消失）+ 拒在飞调用 + 重连。worker env 默认剥离 secret。
 */
export class WorkerPluginTransport implements PluginTransport {
  readonly id: string;
  private worker?: Worker;
  private terminated = false;

  constructor(private readonly opts: WorkerTransportOpts) {
    this.id = opts.id;
  }

  start(events: PluginTransportEvents): void {
    const env = this.opts.env === undefined ? filterEnv(process.env) : (this.opts.env ?? {});
    const workerData = { heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, ...(this.opts.workerData as object | undefined) };
    const worker = new Worker(this.opts.entry, { workerData, env });
    this.worker = worker;

    worker.on('message', (msg: WorkerToHost) => {
      switch (msg.type) {
        case 'ready':
          events.onReady(msg.manifest);
          break;
        case 'chunk':
          events.onChunk(msg.id, msg.chunk);
          break;
        case 'done':
          events.onDone(msg.id, msg.isError ?? false, msg.error);
          break;
        case 'hook-result':
          events.onHookResult(msg.id, msg.decision);
          break;
        case 'heartbeat':
          events.onHeartbeat(msg.seq);
          break;
        case 'log':
          events.onLog(msg.level, msg.msg);
          break;
      }
    });
    worker.on('error', (err) => {
      if (!this.terminated) events.onCrash(err instanceof Error ? err.message : String(err));
    });
    worker.on('exit', (code) => {
      if (!this.terminated && code !== 0) events.onCrash(`插件 worker 异常退出（code=${code}）`);
    });
  }

  send(msg: HostToWorker): void {
    this.worker?.postMessage(msg);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}

function filterEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_WHITELIST) if (src[k] !== undefined) out[k] = src[k];
  return out;
}
