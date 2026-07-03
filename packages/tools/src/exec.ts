/**
 * ExecBackend —— exec 沙箱抽象（DESIGN §3.4 / ADR-19，"同一 API 多档实现，对工具代码透明"）。
 *
 * 分档：
 *   - `local-subprocess`（L1，默认生产）—— 实现在 Phase 4B（受限 env/cwd + 超时 + abort）。
 *   - `docker`（L2，opt-in 严格）—— 接口预留，实现顺延 Phase 6。
 *   - `ssh-remote` —— 接口预留，实现顺延 Phase 6。
 *
 * 本期（Phase 4A）只定义接口 + 未配置占位（误调即抛），不接任何真实执行——
 * bash/execute 工具与 LocalSubprocessExecBackend 在 4B 落地。
 */
export type ExecBackendKind = 'local-subprocess' | 'docker' | 'ssh-remote';

export interface ExecOpts {
  /** 受限工作目录（须在 workspace 内，§3.4 L1）。 */
  cwd: string;
  /** 受限环境变量（白名单透传；默认剥离 yo-agent 自身 secret，4B 落地）。缺省=后端实现决定基线。 */
  env?: Record<string, string>;
  /** per-call 超时与用户中断的组合信号（接 turn/interrupt，内核 callSignal 提供）。 */
  signal?: AbortSignal;
  /** 后台进程（§2.2 BackgroundProcess）；缺省=前台同步流式。 */
  background?: boolean;
}

export interface ExecChunk {
  chunk: string;
  /** 进程退出码（仅最后一帧带）。 */
  exitCode?: number;
}

export interface ExecBackend {
  readonly kind: ExecBackendKind;
  /** 流式执行命令；受 opts.signal 取消。实现须保证 cwd/env 限制（§3.4）。 */
  exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk>;
}

/**
 * 未配置后端的占位：被误调即抛错（4A 接口先行，无 bash 工具注册时调不到；4B 用真实后端替换）。
 * 存在的意义是让「接口已就位但实现未到」可被显式断言（退出标准：占位不被误用）。
 */
export class UnconfiguredExecBackend implements ExecBackend {
  readonly kind: ExecBackendKind;
  constructor(kind: ExecBackendKind = 'local-subprocess') {
    this.kind = kind;
  }
  // biome-ignore lint/correctness/useYield: 未配置后端即抛错,签名需保持 AsyncIterable 契约
  async *exec(): AsyncIterable<ExecChunk> {
    throw new Error('ExecBackend 未配置：bash/execute 工具与真实后端在 Phase 4B 落地');
  }
}
