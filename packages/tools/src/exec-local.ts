import { spawn } from 'node:child_process';
import type { ExecBackend, ExecChunk, ExecOpts } from './exec';

/**
 * 默认透传的安全 env 白名单（§3.4 L1：剥离 yo-agent 自身 secret —— API key / 设备私钥 / OAuth token）。
 * 只有这些键从 baseEnv 透传给子进程；其余（含所有 *_API_KEY / TOKEN / SECRET）一律不传。
 */
const ENV_WHITELIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  'PWD',
];

export interface LocalExecConfig {
  /** shell 可执行（默认 /bin/sh）。 */
  shell?: string;
  /** 额外允许透传的 env 名（叠加白名单；调用方显式 opt-in，绝不含 secret）。 */
  envWhitelist?: string[];
  /** 基线 env 来源（默认 process.env），只取白名单交集；测试可注入。 */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * L1 子进程执行后端（DESIGN §3.4 / ADR-19）。
 *
 * 隔离：① 受限 env（白名单透传，剥离 secret）；② workspace cwd 作起点；③ detached 进程组，
 * abort 时杀整组（SIGKILL）不留孤儿；④ 流式 stdout/stderr。
 *
 * 残余风险（明示，§0.2）：L1 非完备沙箱——命令仍可访问全文件系统、起网络；真隔离用 L2 容器（Phase 6）。
 */
export class LocalSubprocessExecBackend implements ExecBackend {
  readonly kind = 'local-subprocess' as const;
  private readonly shell: string;
  private readonly cfg: LocalExecConfig;
  constructor(cfg: LocalExecConfig = {}) {
    this.shell = cfg.shell ?? '/bin/sh';
    this.cfg = cfg;
  }

  /** 构造受限 env：白名单交集 + 调用方 extra 覆盖。绝不整体继承 process.env（防 secret 泄漏）。 */
  private buildEnv(extra?: Record<string, string>): Record<string, string> {
    const base = this.cfg.baseEnv ?? process.env;
    const wl = new Set([...ENV_WHITELIST, ...(this.cfg.envWhitelist ?? [])]);
    const env: Record<string, string> = {};
    for (const k of wl) {
      const v = base[k];
      if (typeof v === 'string') env[k] = v;
    }
    if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v;
    return env;
  }

  async *exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    if (opts.signal?.aborted) throw signalError(opts.signal);
    const child = spawn(this.shell, ['-c', cmd], {
      cwd: opts.cwd,
      env: this.buildEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 自成进程组 → abort 杀整组（含孙进程）不留孤儿
    });

    const queue: ExecChunk[] = [];
    let finished = false;
    let failure: unknown;
    let exitCode: number | undefined;
    let wake: (() => void) | null = null;
    const bump = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const push = (c: ExecChunk) => {
      queue.push(c);
      bump();
    };
    const finish = (err?: unknown) => {
      if (err !== undefined && failure === undefined) failure = err;
      finished = true;
      bump();
    };

    child.stdout.on('data', (b: Buffer) => push({ chunk: b.toString('utf8') }));
    child.stderr.on('data', (b: Buffer) => push({ chunk: b.toString('utf8') }));
    child.on('error', (e) => finish(e)); // spawn 失败（如 shell 不存在）
    child.on('close', (code) => {
      exitCode = code ?? undefined;
      finish();
    });

    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL'); // 杀整个进程组
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
    };
    const onAbort = () => {
      finish(signalError(opts.signal!));
      kill();
    };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // 赋值 wake 后再查一次（防 push/finish 发生在外层判断与赋值之间的竞态）。
          if (queue.length || finished) {
            wake = null;
            resolve();
          }
        });
      }
      if (failure !== undefined) throw failure;
      yield { chunk: '', exitCode: exitCode ?? 0 }; // 终帧带退出码
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      // 消费方提前 break（未读到 close）→ 杀进程，绝不留孤儿。
      if (exitCode === undefined && failure === undefined) kill();
    }
  }
}

/** abort reason 归一为 Error（区分超时 TimeoutError 与用户中断，沿用 kernel callSignal 约定）。 */
function signalError(signal: AbortSignal): Error {
  const r = signal.reason;
  return r instanceof Error ? r : new Error('命令已取消');
}
