import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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

/**
 * Windows 额外白名单：子进程（含 Git Bash / PowerShell / cmd 自身）缺这些起不来或行为异常——
 * SystemRoot（WinAPI/DLL 定位）、ComSpec/PathExt（命令解析）、Temp、用户目录、AppData（工具链配置）。
 * 均非 secret（process.env 在 Windows 上按键名大小写不敏感查找，列大写形式即可）。
 */
const ENV_WHITELIST_WIN32 = [
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

export interface LocalExecConfig {
  /** shell 可执行（默认按平台解析：POSIX `/bin/sh`；Windows 见 resolveDefaultShell）。 */
  shell?: string;
  /** shell 的「执行命令串」前置参数（默认 `['-c']`；cmd.exe 为 `['/d','/s','/c']`）。 */
  shellArgs?: string[];
  /** 额外允许透传的 env 名（叠加白名单；调用方显式 opt-in，绝不含 secret）。 */
  envWhitelist?: string[];
  /** 基线 env 来源（默认 process.env），只取白名单交集；测试可注入。 */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ResolvedShell {
  file: string;
  args: string[];
  /** 人类可读标签（注入工具描述，让模型知道该写哪种语法）。 */
  label: string;
}

/** 是否 Windows 平台（集中一处，便于测试替身）。 */
const isWin32 = (): boolean => process.platform === 'win32';

/**
 * 按平台解析默认 shell。
 * - POSIX：`/bin/sh -c`。
 * - Windows：优先 Git Bash（bash 工具语义 = POSIX shell，模型写的是 sh 语法；常见安装点 + PATH 搜索，
 *   跳过 System32\bash.exe——那是 WSL 启动器，未装发行版时报错且语义不同），其次 PowerShell（pwsh/powershell
 *   `-NoProfile -NonInteractive -Command`），兜底 cmd.exe（`/d /s /c`，与 Node shell:true 同形）。
 */
export function resolveDefaultShell(env: NodeJS.ProcessEnv = process.env): ResolvedShell {
  if (!isWin32()) return { file: '/bin/sh', args: ['-c'], label: 'POSIX sh' };

  const systemRoot = (env.SYSTEMROOT ?? env.SystemRoot ?? 'C:\\Windows').toLowerCase();
  const candidates: string[] = [];
  for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    if (dir.toLowerCase().startsWith(systemRoot)) continue; // WSL 启动器
    candidates.push(join(dir, 'bash.exe'), join(dir, 'sh.exe'));
  }
  for (const c of candidates) {
    if (existsSync(c)) return { file: c, args: ['-c'], label: 'Git Bash (POSIX sh)' };
  }

  for (const ps of ['pwsh.exe', 'powershell.exe']) {
    for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
      if (dir && existsSync(join(dir, ps))) {
        return { file: ps, args: ['-NoProfile', '-NonInteractive', '-Command'], label: 'PowerShell' };
      }
    }
  }

  return { file: env.COMSPEC ?? env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c'], label: 'cmd.exe' };
}

/**
 * L1 子进程执行后端（DESIGN §3.4 / ADR-19）。
 *
 * 隔离：① 受限 env（白名单透传，剥离 secret）；② workspace cwd 作起点；③ POSIX 下 detached 进程组，
 * abort 时杀整组（SIGKILL）不留孤儿——Windows 无进程组语义，改 `taskkill /T /F` 杀进程树；④ 流式 stdout/stderr。
 *
 * 残余风险（明示，§0.2）：L1 非完备沙箱——命令仍可访问全文件系统、起网络；真隔离用 L2 容器（Phase 6）。
 */
export class LocalSubprocessExecBackend implements ExecBackend {
  readonly kind = 'local-subprocess' as const;
  readonly shell: ResolvedShell;
  private readonly cfg: LocalExecConfig;
  constructor(cfg: LocalExecConfig = {}) {
    const def = cfg.shell ? undefined : resolveDefaultShell();
    this.shell = cfg.shell
      ? { file: cfg.shell, args: cfg.shellArgs ?? ['-c'], label: cfg.shell }
      : { ...def!, args: cfg.shellArgs ?? def!.args };
    this.cfg = cfg;
  }

  /** 工具描述用的 shell 标签。 */
  get shellLabel(): string {
    return this.shell.label;
  }

  /** 构造受限 env：白名单交集 + 调用方 extra 覆盖。绝不整体继承 process.env（防 secret 泄漏）。 */
  private buildEnv(extra?: Record<string, string>): Record<string, string> {
    const base = this.cfg.baseEnv ?? process.env;
    const wl = new Set([...ENV_WHITELIST, ...(isWin32() ? ENV_WHITELIST_WIN32 : []), ...(this.cfg.envWhitelist ?? [])]);
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
    const win = isWin32();
    const child = spawn(this.shell.file, [...this.shell.args, cmd], {
      cwd: opts.cwd,
      env: this.buildEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !win, // POSIX：自成进程组 → abort 杀整组（含孙进程）不留孤儿；Windows 无此语义（且会弹新控制台）
      windowsHide: true,
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
      if (win) {
        // Windows：taskkill /T 杀整棵进程树（shell + 孙进程），对齐 POSIX 进程组语义。
        if (child.pid) {
          try {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            return;
          } catch {
            /* 回落单杀 */
          }
        }
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        return;
      }
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
