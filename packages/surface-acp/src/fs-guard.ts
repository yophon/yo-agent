/**
 * ACP fs/* 反向能力的路径守卫（3F / DESIGN §15.7）。
 * agent 经 client 读写文件前，强制：① 路径在 workspaceRoot 内（防 `../` 与 **symlink** 逃逸）；② 非 Protected Path。
 * 复用内核同一 Protected Paths 定义（isProtectedPath），不另起一套。
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
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

/** realpath（解析符号链接）；目标不存在则原样返回。 */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * realpath 目标本身；若不存在（如待写入的新文件），向上找最近存在祖先做 realpath，再拼回不存在的尾段。
 * 这样 symlink 在「已存在前缀」里会被解析（防经软链逃逸），新文件落点仍按其真实父目录判定。
 */
function realpathTargetOrParent(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // 抵达根仍不可 realpath → 原样（已 resolve 规范化）
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * 校验 fs 路径可被 ACP fs/* 访问。越界或命中保护路径 → 抛 FsGuardError（调用方转 ACP 错误）。
 * - 相对路径锚定 **会话 workspaceRoot**（非进程 cwd，审查 M4-anchor）。
 * - 用 realpath 解析符号链接后再做前缀与 Protected Paths 校验（审查 H3：path.resolve 不跟随 symlink，会被软链绕过）。
 */
export function ensureFsPathAllowed(path: string, workspaceRoot: string): void {
  const root = realpathOr(resolve(workspaceRoot));
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const target = realpathTargetOrParent(abs);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new FsGuardError(`路径越界（不在 workspace 内 / 经符号链接逃逸）：${path}`, 'escape');
  }
  if (isProtectedPath(target)) {
    throw new FsGuardError(`命中保护路径，拒绝访问：${path}`, 'protected');
  }
}
