/**
 * ACP fs/* 反向能力的路径守卫（3F / DESIGN §15.7）。
 * agent 经 client 读写文件前，强制：① 路径在 workspaceRoot 内（防 `../` 逃逸）；② 非 Protected Path。
 * 复用内核同一 Protected Paths 定义（isProtectedPath），不另起一套。
 */
import { resolve, sep } from 'node:path';
import { isProtectedPath } from '@yo-agent/kernel';

export class FsGuardError extends Error {
  constructor(
    message: string,
    readonly reason: 'escape' | 'protected',
  ) {
    super(message);
    this.name = 'FsGuardError';
  }
}

/**
 * 校验 fs 路径可被 ACP fs/* 访问。越界或命中保护路径 → 抛 FsGuardError（调用方转 ACP 错误）。
 * 注：write 目标可能尚不存在，故用 path.resolve 规范化（非 realpath）做前缀校验——足以拦 `..` 逃逸。
 */
export function ensureFsPathAllowed(path: string, workspaceRoot: string): void {
  const root = resolve(workspaceRoot);
  const target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new FsGuardError(`路径越界（不在 workspace 内）：${path}`, 'escape');
  }
  if (isProtectedPath(target)) {
    throw new FsGuardError(`命中保护路径，拒绝访问：${path}`, 'protected');
  }
}
