import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface ConventionOpts {
  /** 文件名优先级（每个目录取第一个存在的）。默认 yo.md → AGENTS.md → CLAUDE.md（§5.2 兼容生态）。 */
  filenames?: string[];
  /** 合并上限（DESIGN §5.2：32 KiB，Codex project_doc_max_bytes）。UTF-8 字节安全截断。 */
  maxBytes?: number;
  /** 全局约定文件（最先注入，最低优先级）。如 ~/.yo-agent/yo.md。 */
  globalPath?: string;
  /**
   * workspace 隔离根（3E / §15.5）：git repo 根或显式根。**设此项才启用 auto-memory（MEMORY.md）加载与
   * @import 展开**——MEMORY.md 仅从此根读取（不沿 dirChain 上溯，否则跨 workspace 泄漏记忆）；@import 目标经
   * realpath 校验须落在此根内（拒逃逸）。不设则行为同既有（仅约定文件发现链，无 memory / 无 @import）。
   */
  workspaceRoot?: string;
  /** auto-memory 索引文件名（默认 MEMORY.md，§15.5）。 */
  memoryFilename?: string;
  /** @import 递归深度上限（默认 5）。 */
  maxImportDepth?: number;
}

/** MEMORY.md 索引两级懒加载上限（§15.5）：前 200 行 / 25 KB；per-topic 文件按需 read（不在此加载）。 */
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25 * 1024;
const DEFAULT_IMPORT_DEPTH = 5;

/**
 * 约定文件发现链（DESIGN §5.2）：全局 → 文件系统根 → cwd 逐级拼接合并（非覆盖），
 * 更具体的 cwd 文件排在后面。兼容 AGENTS.md / CLAUDE.md，使任何有约定文件的 repo 开箱即用。
 *
 * 3E：传 workspaceRoot 时额外加载 **workspace 私有的 MEMORY.md**（仅从根读取、cap 200 行/25KB、展开 @import）。
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

  // 3E：workspace 私有 auto-memory 索引（仅从 workspaceRoot 读，保隔离）。最具体 → 排最后（最高显著性）。
  if (opts.workspaceRoot) {
    const mem = await loadMemoryIndex(opts.workspaceRoot, opts.memoryFilename ?? 'MEMORY.md', opts.maxImportDepth);
    if (mem) parts.push(mem);
  }

  const merged = parts.join('\n\n');
  return safeTruncateBytes(merged, maxBytes);
}

/** 加载 MEMORY.md 索引：仅从 workspaceRoot 读 → cap 200 行/25KB → 展开 @import（逃逸/循环/深度防护）。 */
async function loadMemoryIndex(workspaceRoot: string, memoryFilename: string, maxDepth?: number): Promise<string | null> {
  const raw = await tryRead(join(workspaceRoot, memoryFilename));
  if (!raw) return null;
  const capped = capMemoryIndex(raw);
  return expandImports(capped, workspaceRoot, workspaceRoot, maxDepth);
}

/** MEMORY.md 索引 cap：前 200 行后再 25KB 字节安全截断（§15.5）。 */
export function capMemoryIndex(text: string): string {
  const lines = text.split('\n');
  const head = lines.length > MEMORY_MAX_LINES ? lines.slice(0, MEMORY_MAX_LINES).join('\n') : text;
  return safeTruncateBytes(head, MEMORY_MAX_BYTES);
}

/**
 * 递归展开 `@path` 导入（3E / §15.5）。与 skill @-reference 共用此 resolver。
 * - 相对路径相对 **引用文件所在目录**（baseDir，非 cwd）解析；
 * - realpath 校验目标落在 workspaceRoot 内（拒 `../../etc/passwd` 一类逃逸 + 符号链接逃逸）；
 * - visited（realpath 去重）防 A↔B 循环；depth 上限兜底。
 * 越界/循环/超深/缺失 → 注入可观测占位标记，**绝不内联越界内容**。
 */
export async function expandImports(
  text: string,
  baseDir: string,
  workspaceRoot: string,
  maxDepth: number = DEFAULT_IMPORT_DEPTH,
): Promise<string> {
  let wsReal: string;
  try {
    wsReal = await realpath(workspaceRoot);
  } catch {
    return text; // workspaceRoot 不存在 → 不展开（fail-closed）
  }
  return resolveImports(text, baseDir, wsReal, new Set<string>(), 0, maxDepth);
}

async function resolveImports(
  text: string,
  baseDir: string,
  wsReal: string,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<string> {
  // matchAll 预先收集（每层独立 regex）——避免递归共享 /g lastIndex 互相污染。
  const matches = [...text.matchAll(/(^|[\s(])@([^\s)]+)/g)];
  if (matches.length === 0) return text;
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.index) + m[1]; // 保留前导字符（行首/空白/括号）
    out += await resolveOne(m[2]!, baseDir, wsReal, visited, depth, maxDepth);
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  return out;
}

async function resolveOne(
  rel: string,
  baseDir: string,
  wsReal: string,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<string> {
  if (depth >= maxDepth) return `[@import 跳过：超过最大深度 ${maxDepth}]`;
  let real: string;
  try {
    real = await realpath(resolve(baseDir, rel));
  } catch {
    return `[@import 未找到：${rel}]`;
  }
  // 逃逸防护：realpath 后须 === wsReal 或在其子树内。
  if (real !== wsReal && !real.startsWith(wsReal + sep)) return `[@import 拒绝：越界 ${rel}]`;
  if (visited.has(real)) return `[@import 跳过：循环 ${rel}]`;
  const content = await tryRead(real);
  if (content === null) return `[@import 空：${rel}]`;
  const next = new Set(visited);
  next.add(real);
  return resolveImports(content, dirname(real), wsReal, next, depth + 1, maxDepth);
}

/**
 * UTF-8 字节安全截断（§15.5）：按字节上限切，且不切断多字节字符；尽量回退到最近空白/换行，
 * 避免切断标识符（路径/UUID/hash）。返回的 JS 字符串字节长度 ≤ maxBytes。
 */
export function safeTruncateBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // 二分找不超过 maxBytes 的最大字符（UTF-16 code unit）边界——slice 永远落在码元边界，不产生半个码点。
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  // 回退到最近的空白/换行（仅当不至于丢弃过半），避免切断标识符。
  const slice = text.slice(0, cut);
  const ws = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  if (ws > cut * 0.5) cut = ws;
  return text.slice(0, cut);
}

/**
 * 手动记忆指令解析（3E / §15.5）：`#remember <文本>` → 提取记忆内容。非该指令 → null。
 * 这是 auto-memory 的"动态"主路（手动落盘）；自动蒸馏管线留 Phase N（见 PHASE-3 §已知限制）。
 */
export function parseRememberDirective(input: string): { content: string } | null {
  const m = /^\s*#remember\s+([\s\S]+?)\s*$/.exec(input);
  if (!m) return null;
  const content = m[1]!.trim();
  return content ? { content } : null;
}

/**
 * 向 workspaceRoot 的 MEMORY.md 追加一条记忆条目（落盘主路，§15.5）。文件不存在则建索引骨架。
 * 返回写入的行。下次会话经 loadConventionFiles 两级懒加载读回。
 */
export async function appendMemoryLine(
  workspaceRoot: string,
  content: string,
  memoryFilename = 'MEMORY.md',
): Promise<string> {
  const file = join(workspaceRoot, memoryFilename);
  const line = `- ${content.replace(/\s*\n\s*/g, ' ')}`;
  const existing = await tryRead(file);
  const body = existing ? `${existing}\n${line}\n` : `# MEMORY\n\n${line}\n`;
  await writeFile(file, body, 'utf8');
  return line;
}

/** 从内容派生稳定记忆键（djb2，幂等：同内容同键 → MemoryStore upsert 覆盖，不重复堆积）。 */
export function memoryKeyFor(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
  return `m_${h.toString(36)}`;
}

/**
 * 向上查找 git repo 根（含 .git 的最近祖先），找不到回退 cwd。auto-memory 的 workspace 隔离边界（§15.5）。
 */
export function findWorkspaceRoot(cwd: string): string {
  const chain = dirChain(cwd);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (existsSync(join(chain[i]!, '.git'))) return chain[i]!;
  }
  return resolve(cwd);
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
