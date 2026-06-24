import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface ConventionOpts {
  /** 文件名优先级（每个目录取第一个存在的）。默认 yo.md → AGENTS.md → CLAUDE.md（§5.2 兼容生态）。 */
  filenames?: string[];
  /** 合并上限（DESIGN §5.2：32 KiB，Codex project_doc_max_bytes）。 */
  maxBytes?: number;
  /** 全局约定文件（最先注入，最低优先级）。如 ~/.yo-agent/yo.md。 */
  globalPath?: string;
}

/**
 * 约定文件发现链（DESIGN §5.2）：全局 → 文件系统根 → cwd 逐级拼接合并（非覆盖），
 * 更具体的 cwd 文件排在后面。兼容 AGENTS.md / CLAUDE.md，使任何有约定文件的 repo 开箱即用。
 * 软约束：返回文本由调用方作为 system / user 注入；硬约束须走 hook（见 §9.5）。
 */
export async function loadConventionFiles(cwd: string, opts: ConventionOpts = {}): Promise<string> {
  const filenames = opts.filenames ?? ['yo.md', 'AGENTS.md', 'CLAUDE.md'];
  const maxBytes = opts.maxBytes ?? 32 * 1024;
  const parts: string[] = [];

  if (opts.globalPath) {
    const text = await tryRead(opts.globalPath);
    if (text) parts.push(text);
  }

  for (const dir of dirChain(cwd)) {
    for (const fn of filenames) {
      const text = await tryRead(join(dir, fn));
      if (text) {
        parts.push(text);
        break; // 每个目录只取第一个存在的文件
      }
    }
  }

  const merged = parts.join('\n\n');
  return merged.length > maxBytes ? merged.slice(0, maxBytes) : merged;
}

/** 文件系统根 → cwd 的目录链（root 在前，cwd 在后）。 */
export function dirChain(cwd: string): string[] {
  const dirs: string[] = [];
  let cur = resolve(cwd);
  for (;;) {
    dirs.unshift(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}
