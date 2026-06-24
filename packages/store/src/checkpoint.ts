/**
 * ShadowGitCheckpointer —— L3 checkpoint 回滚（DESIGN §3.4 / §10.1 / ADR-5）。
 * 用 isomorphic-git（纯 JS，免宿主 git、跨平台一致）在独立 gitdir 维护工作区影子快照，
 * 与用户真实 .git 隔离。每次写操作后 snapshot()，rollback(ref) 把工作区恢复到某快照。
 *
 * 兜底安全网（TS/Node 无 OS 级强沙箱时的最低保障），与沙箱正交。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import git from 'isomorphic-git';

const AUTHOR = { name: 'yo-agent', email: 'checkpoint@yo-agent.local' } as const;

/** 影子仓库内不纳入快照的路径前缀（避开真实 .git、影子库自身、依赖）。 */
const IGNORED_PREFIXES = ['.git/', '.yo-agent/', 'node_modules/'];
const IGNORED_EXACT = new Set(['.git', '.yo-agent', 'node_modules']);

export interface SnapshotResult {
  checkpointId: string;
  ref: string; // git oid
  createdAt: number;
}

export interface ShadowGitOpts {
  /** 工作区根（被快照的目录）。 */
  dir: string;
  /** 影子 gitdir（默认 <dir>/.yo-agent/shadow.git，与真实 .git 隔离）。 */
  gitdir?: string;
}

export class ShadowGitCheckpointer {
  private readonly dir: string;
  private readonly gitdir: string;
  private initialized = false;

  constructor(opts: ShadowGitOpts) {
    this.dir = opts.dir;
    this.gitdir = opts.gitdir ?? join(opts.dir, '.yo-agent', 'shadow.git');
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await git.init({ fs, dir: this.dir, gitdir: this.gitdir, defaultBranch: 'main' });
    this.initialized = true;
  }

  private isIgnored(filepath: string): boolean {
    if (IGNORED_EXACT.has(filepath)) return true;
    return IGNORED_PREFIXES.some((p) => filepath.startsWith(p));
  }

  /** 快照当前工作区（仅非忽略文件）；返回 checkpointId + git oid。 */
  async snapshot(label = 'checkpoint'): Promise<SnapshotResult> {
    await this.ensureInit();
    const matrix = await git.statusMatrix({
      fs,
      dir: this.dir,
      gitdir: this.gitdir,
      filter: (f) => !this.isIgnored(f),
    });
    for (const [filepath, , workdirStatus] of matrix) {
      if (this.isIgnored(filepath)) continue;
      if (workdirStatus === 0) {
        await git.remove({ fs, dir: this.dir, gitdir: this.gitdir, filepath });
      } else {
        await git.add({ fs, dir: this.dir, gitdir: this.gitdir, filepath });
      }
    }
    const ref = await git.commit({
      fs,
      dir: this.dir,
      gitdir: this.gitdir,
      message: label,
      author: AUTHOR,
      committer: AUTHOR,
    });
    return { checkpointId: randomUUID(), ref, createdAt: Date.now() };
  }

  /**
   * 把工作区精确恢复到某快照。git.checkout 还原 tracked 文件，但不触碰 untracked 文件；
   * 故 checkout 后再删除"快照后新建、从未被快照"的 untracked 文件（HEAD=0 且 workdir 存在），
   * 确保工作区即该快照的精确状态（兜底安全网须能清掉被回滚的危险写入）。
   */
  async rollback(ref: string): Promise<void> {
    await this.ensureInit();
    await git.checkout({ fs, dir: this.dir, gitdir: this.gitdir, ref, force: true });
    const matrix = await git.statusMatrix({
      fs,
      dir: this.dir,
      gitdir: this.gitdir,
      filter: (f) => !this.isIgnored(f),
    });
    for (const [filepath, headStatus, workdirStatus] of matrix) {
      if (this.isIgnored(filepath)) continue;
      if (headStatus === 0 && workdirStatus !== 0) {
        await rm(join(this.dir, filepath), { force: true });
      }
    }
  }

  /** 列出快照提交（最新在前）。 */
  async list(): Promise<Array<{ ref: string; message: string; ts: number }>> {
    await this.ensureInit();
    try {
      const log = await git.log({ fs, dir: this.dir, gitdir: this.gitdir });
      return log.map((c) => ({ ref: c.oid, message: c.commit.message.trim(), ts: c.commit.author.timestamp * 1000 }));
    } catch {
      return []; // 尚无提交
    }
  }
}
