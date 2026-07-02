/**
 * 补全引擎(4.6d):纯函数计算当前光标处的补全上下文与候选。
 * 两种触发:行首 `/` → slash 命令;任意处 `@` → 文件路径(模糊匹配)。
 * 候选列表由 app 注入(命令注册表 / 文件清单),引擎只做 token 解析 + 过滤排序。
 */

export interface CompletionItem {
  /** 接受后替换 token 的完整文本。 */
  value: string;
  label: string;
  hint?: string;
}

export interface Completion {
  kind: 'slash' | 'file';
  /** 被替换 token 在 buffer 中的 [start, cursor) 区间。 */
  tokenStart: number;
  token: string;
  items: CompletionItem[];
}

export const COMPLETION_LIMIT = 8;

/**
 * 模糊匹配打分:前缀 > 词段前缀(路径段起始)> 子串 > 有序子序列;不匹配 → -1。
 * 平分时短者优先。
 */
export function fuzzyScore(candidate: string, query: string): number {
  if (!query) return 1;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (c.startsWith(q)) return 1000 - candidate.length;
  const segIdx = c.split(/[/._-]/).findIndex((seg) => seg.startsWith(q));
  if (segIdx >= 0) return 800 - candidate.length;
  const at = c.indexOf(q);
  if (at >= 0) return 600 - at - candidate.length;
  // 有序子序列
  let i = 0;
  for (const ch of c) {
    if (ch === q[i]) i++;
    if (i === q.length) return 300 - candidate.length;
  }
  return -1;
}

export function fuzzyFilter(candidates: readonly string[], query: string, limit = COMPLETION_LIMIT): string[] {
  return candidates
    .map((value) => ({ value, score: fuzzyScore(value, query) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.value);
}

export interface CompletionSources {
  /** slash 命令名(含 `/` 前缀)+ 描述。 */
  commands: ReadonlyArray<{ name: string; desc: string }>;
  /** 相对路径文件清单(null = 尚未加载,menu 显示加载中)。 */
  files: readonly string[] | null;
}

/** 解析光标前 token 并产出补全;无触发返回 null。 */
export function computeCompletion(text: string, cursor: number, sources: CompletionSources): Completion | null {
  const before = text.slice(0, cursor);

  // slash:仅当 buffer 以 `/` 开头且光标仍在首个词内(命令名阶段)。
  const slash = before.match(/^\/([\w-]*)$/);
  if (slash && text.startsWith('/')) {
    const token = `/${slash[1]!}`;
    // 匹配去掉 `/` 前缀的命令名(否则前缀打分永远落空)。
    const names = sources.commands.map((c) => c.name.slice(1));
    const matched = fuzzyFilter(names, slash[1]!, COMPLETION_LIMIT);
    const items = matched.map((name) => ({
      value: `/${name}`,
      label: `/${name}`,
      hint: sources.commands.find((c) => c.name === `/${name}`)?.desc,
    }));
    return items.length ? { kind: 'slash', tokenStart: 0, token, items } : null;
  }

  // 文件:光标前最近的 `@` 起 token(不含空白)。
  const file = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (file) {
    const token = `@${file[1]!}`;
    const tokenStart = cursor - token.length;
    if (sources.files === null) {
      return { kind: 'file', tokenStart, token, items: [] }; // 加载中
    }
    const matched = fuzzyFilter(sources.files, file[1]!, COMPLETION_LIMIT);
    const items = matched.map((path) => ({ value: `@${path}`, label: path }));
    return items.length ? { kind: 'file', tokenStart, token, items } : null;
  }

  return null;
}

/** 接受补全:替换 token,文件补全追加空格,返回新 text 与光标。 */
export function acceptCompletion(text: string, comp: Completion, item: CompletionItem): { text: string; cursor: number } {
  const suffix = comp.kind === 'file' ? ' ' : '';
  const inserted = item.value + suffix;
  const next = text.slice(0, comp.tokenStart) + inserted + text.slice(comp.tokenStart + comp.token.length);
  return { text: next, cursor: comp.tokenStart + inserted.length };
}

// ── 文件清单(@ 补全数据源;唯一的非纯部分,app 缓存一次)────────────────
export const FILE_LIST_LIMIT = 5000;

const SKIP_DIRS = new Set(['node_modules', '.git', '.yo-agent', 'dist', 'build', '.next']);

/** git ls-files 优先(快 + 尊重 .gitignore),退回 fs 遍历;上限截断。 */
export async function listFiles(cwd: string, limit = FILE_LIST_LIMIT): Promise<string[]> {
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard'],
        { cwd, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
      );
    });
    const files = out.split('\n').filter(Boolean);
    if (files.length) return files.slice(0, limit);
  } catch {
    // 非 git 仓库 → fs 遍历
  }
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const acc: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (acc.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (acc.length >= limit) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), r);
      else acc.push(r);
    }
  };
  await walk(cwd, '');
  return acc;
}
