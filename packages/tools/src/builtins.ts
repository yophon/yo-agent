import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { makeBashTool } from './bash';
import type { ExecBackend } from './exec';
import { LocalSubprocessExecBackend } from './exec-local';
import { parallelTool } from './parallel-tool';
import type { RegisteredTool, ToolContext } from './index';

/** realpath（解析符号链接）；不存在则原样返回。 */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * realpath 目标本身；不存在（如待写入新文件）则向上找最近存在祖先做 realpath，再拼回尾段——
 * 使 symlink 在「已存在前缀」里被解析（防经软链逃逸），新文件落点按其真实父目录判定。
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
      if (parent === cur) return abs;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * L0 路径保护：限制工具读写在 cwd 内（DESIGN §3.4 / §9.4）。
 * 审查 H1（4B confirmed）：词法 resolve+relative 不跟随符号链接，cwd 内一个指向外部的软链（如恶意仓库里
 * `creds -> ~/.aws/credentials`）会被词法校验放行 → fs 跟随软链落到 cwd 外（read approval:'never' 直接外泄）。
 * 故用 realpath 解析符号链接后再做前缀校验（与 surface-acp/fs-guard 同一硬化），返回 realpath 后的真实路径。
 */
function confine(cwd: string, p: string): string {
  const root = realpathOr(resolve(cwd));
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const target = realpathTargetOrParent(abs);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径越界（超出 cwd / 经符号链接逃逸）：${p}`);
  }
  return target;
}

function strField(input: unknown, key: string, fallback = ''): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  return v == null ? fallback : String(v);
}

export const readTool: RegisteredTool = {
  descriptor: {
    name: 'read',
    kind: 'read',
    description: '读取文件内容（限 cwd 内）',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    owner: 'core',
    availability: { always: true },
    approval: 'never',
  },
  executor: {
    async *execute(input, ctx: ToolContext) {
      const abs = confine(ctx.cwd, strField(input, 'path'));
      yield { kind: 'output', chunk: await readFile(abs, 'utf8') };
    },
  },
};

export const writeTool: RegisteredTool = {
  descriptor: {
    name: 'write',
    kind: 'edit',
    description: '写入/覆盖文件（限 cwd 内；mutating，需审批）',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    owner: 'core',
    availability: { always: true },
    approval: 'risk-based',
  },
  executor: {
    async *execute(input, ctx: ToolContext) {
      const path = strField(input, 'path');
      const content = strField(input, 'content');
      const abs = confine(ctx.cwd, path);
      await writeFile(abs, content, 'utf8');
      yield { kind: 'output', chunk: `已写入 ${Buffer.byteLength(content)} 字节 → ${path}` };
    },
  },
};

export const lsTool: RegisteredTool = {
  descriptor: {
    name: 'ls',
    kind: 'read',
    description: '列目录（限 cwd 内）',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    owner: 'core',
    availability: { always: true },
    approval: 'never',
  },
  executor: {
    async *execute(input, ctx: ToolContext) {
      const abs = confine(ctx.cwd, strField(input, 'path', '.'));
      yield { kind: 'output', chunk: (await readdir(abs)).join('\n') };
    },
  },
};

export const editTool: RegisteredTool = {
  descriptor: {
    name: 'edit',
    kind: 'edit',
    description: '精确字符串替换（限 cwd 内；old_string 须唯一或设 replace_all；mutating，需审批）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    owner: 'core',
    availability: { always: true },
    approval: 'risk-based',
  },
  executor: {
    async *execute(input, ctx: ToolContext) {
      const path = strField(input, 'path');
      const oldS = strField(input, 'old_string');
      const newS = strField(input, 'new_string');
      const replaceAll = Boolean((input as Record<string, unknown> | null)?.replace_all);
      if (oldS === '') throw new Error('edit：old_string 不能为空');
      const abs = confine(ctx.cwd, path);
      const orig = await readFile(abs, 'utf8');
      const count = orig.split(oldS).length - 1;
      if (count === 0) throw new Error(`edit：未找到 old_string（${path}）`);
      if (count > 1 && !replaceAll) throw new Error(`edit：old_string 命中 ${count} 处，需唯一或设 replace_all`);
      let next: string;
      if (replaceAll) {
        next = orig.split(oldS).join(newS); // 字面替换（避开 String.replace 的 $ 特殊模式）
      } else {
        const idx = orig.indexOf(oldS);
        next = orig.slice(0, idx) + newS + orig.slice(idx + oldS.length);
      }
      await writeFile(abs, next, 'utf8');
      yield { kind: 'output', chunk: `已替换 ${replaceAll ? count : 1} 处 → ${path}` };
    },
  },
};

export const grepTool: RegisteredTool = {
  descriptor: {
    name: 'grep',
    kind: 'search',
    description: '正则内容搜索（递归，限 cwd 内；跳过 .git/node_modules/.yo-agent）',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' }, flags: { type: 'string' } },
      required: ['pattern'],
    },
    owner: 'core',
    availability: { always: true },
    approval: 'risk-based',
  },
  executor: {
    async *execute(input, ctx: ToolContext) {
      const pattern = strField(input, 'pattern');
      if (pattern === '') throw new Error('grep：pattern 必填');
      const flags = strField(input, 'flags').replace(/g/g, ''); // 逐行 test，去掉 g 防 lastIndex 漂移
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags);
      } catch {
        throw new Error(`grep：无效正则 ${pattern}`);
      }
      const root = confine(ctx.cwd, strField(input, 'path', '.'));
      const base = realpathOr(resolve(ctx.cwd)); // 输出相对 realpath(cwd)：confine 已 realpath，file 在 /private/var 等真实路径下
      const results: string[] = [];
      const MAX = 200;
      outer: for await (const file of walkFiles(root)) {
        let content: string;
        try {
          content = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        const rel = relative(base, file);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            results.push(`${rel}:${i + 1}:${lines[i]}`);
            if (results.length >= MAX) break outer;
          }
        }
      }
      const note = results.length >= MAX ? `\n[截断于 ${MAX} 条]` : '';
      yield { kind: 'output', chunk: results.length ? results.join('\n') + note : '(无匹配)' };
    },
  },
};

export const globTool: RegisteredTool = {
  descriptor: {
    name: 'glob',
    kind: 'search',
    description: '文件名 glob 匹配（递归，限 cwd 内；支持 ** / * / ?）',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
    owner: 'core',
    availability: { always: true },
    approval: 'risk-based',
  },
  executor: {
    async *execute(input, ctx: ToolContext) {
      const pattern = strField(input, 'pattern');
      if (pattern === '') throw new Error('glob：pattern 必填');
      const root = confine(ctx.cwd, strField(input, 'path', '.'));
      const base = realpathOr(resolve(ctx.cwd)); // 输出相对 realpath(cwd)（confine 已 realpath）
      const re = globToRegExp(pattern);
      const out: string[] = [];
      const MAX = 500;
      for await (const file of walkFiles(root)) {
        if (re.test(relative(root, file))) {
          out.push(relative(base, file));
          if (out.length >= MAX) break;
        }
      }
      yield { kind: 'output', chunk: out.length ? out.join('\n') : '(无匹配)' };
    },
  },
};

export const todoWriteTool: RegisteredTool = {
  descriptor: {
    name: 'todo_write',
    kind: 'other',
    description: '记录/更新本 turn 任务清单（无副作用）',
    inputSchema: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] },
    owner: 'core',
    availability: { always: true },
    approval: 'never',
  },
  executor: {
    async *execute(input) {
      const raw = (input as { todos?: unknown } | null)?.todos;
      const todos = Array.isArray(raw) ? raw : [];
      const lines = todos.map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const status = typeof o.status === 'string' ? o.status : 'pending';
        const mark = status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]';
        return `${mark} ${typeof o.content === 'string' ? o.content : String(t)}`;
      });
      yield { kind: 'output', chunk: lines.length ? lines.join('\n') : '(空清单)' };
    },
  },
};

export const applyPatchTool: RegisteredTool = {
  descriptor: {
    name: 'apply_patch',
    kind: 'edit',
    description: '多文件补丁（*** Add/Update/Delete File 信封，限 cwd 内；mutating，需审批）',
    inputSchema: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] },
    owner: 'core',
    availability: { always: true },
    approval: 'risk-based',
  },
  executor: {
    async *execute(input, ctx: ToolContext) {
      const ops = parsePatch(strField(input, 'patch'));
      const changed: string[] = [];
      for (const op of ops) {
        const abs = confine(ctx.cwd, op.path);
        if (op.kind === 'add') {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, op.content, 'utf8');
          changed.push(`A ${op.path}`);
        } else if (op.kind === 'delete') {
          await rm(abs, { force: true });
          changed.push(`D ${op.path}`);
        } else {
          const orig = await readFile(abs, 'utf8');
          await writeFile(abs, applyHunks(orig, op.hunks, op.path), 'utf8');
          changed.push(`M ${op.path}`);
        }
      }
      yield { kind: 'output', chunk: changed.length ? changed.join('\n') : '(空补丁)' };
    },
  },
};

// ───────────────────────── 搜索 / 补丁辅助 ─────────────────────────

const SKIP_DIRS = new Set(['.git', 'node_modules', '.yo-agent']);

/** 递归列文件（限 root 内，跳过 SKIP_DIRS，预算上限防超大树）；root 为文件则直接产出。 */
async function* walkFiles(root: string): AsyncIterable<string> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    yield root;
    return;
  }
  let budget = 5000;
  async function* rec(dir: string): AsyncIterable<string> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget <= 0) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        yield* rec(join(dir, e.name));
      } else if (e.isFile()) {
        budget--;
        yield join(dir, e.name);
      }
    }
  }
  yield* rec(root);
}

/** glob → 锚定 RegExp：`**`→跨目录、`*`→段内、`?`→单字符；其余正则元字符转义。 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` 吸收尾随斜杠 → 匹配零或多级目录
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; hunks: PatchHunk[] };
interface PatchHunk {
  lines: Array<{ op: ' ' | '-' | '+'; text: string }>;
}

/** 解析 *** Add/Update/Delete File 信封（Codex apply_patch 格式子集）。 */
function parsePatch(text: string): PatchOp[] {
  const lines = text.split('\n');
  const ops: PatchOp[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i++;
      const content: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const l = lines[i]!;
        content.push(l.startsWith('+') ? l.slice(1) : l);
        i++;
      }
      ops.push({ kind: 'add', path, content: content.join('\n') });
    } else if (line.startsWith('*** Delete File:')) {
      ops.push({ kind: 'delete', path: line.slice('*** Delete File:'.length).trim() });
      i++;
    } else if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      i++;
      const hunks: PatchHunk[] = [];
      let cur: PatchHunk | null = null;
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          cur = { lines: [] };
          hunks.push(cur);
        } else {
          if (!cur) {
            cur = { lines: [] };
            hunks.push(cur);
          }
          const ch = l[0];
          const op = ch === '+' ? '+' : ch === '-' ? '-' : ' ';
          cur.lines.push({ op, text: l.slice(1) });
        }
        i++;
      }
      ops.push({ kind: 'update', path, hunks });
    } else {
      i++; // 跳过 *** Begin/End Patch、空行
    }
  }
  if (ops.length === 0) throw new Error('apply_patch：未解析到任何操作（需 *** Add/Update/Delete File: 信封）');
  return ops;
}

/** 应用 Update 补丁：每个 hunk 按「上下文 + 删除行」定位连续块，替换为「上下文 + 新增行」。 */
function applyHunks(orig: string, hunks: PatchHunk[], path: string): string {
  let lines = orig.split('\n');
  for (const h of hunks) {
    const before = h.lines.filter((l) => l.op === ' ' || l.op === '-').map((l) => l.text);
    const after = h.lines.filter((l) => l.op === ' ' || l.op === '+').map((l) => l.text);
    if (before.length === 0) throw new Error(`apply_patch：hunk 缺少上下文/删除行，无法定位（${path}）`);
    const idx = indexOfSeq(lines, before);
    if (idx < 0) throw new Error(`apply_patch：上下文未匹配（${path}）`);
    lines = [...lines.slice(0, idx), ...after, ...lines.slice(idx + before.length)];
  }
  return lines.join('\n');
}

function indexOfSeq(hay: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * 内置工具集（5.2a ExecBackend 单例提升）：装配层构造共享 ExecBackend 传入——bash 工具与
 * extension-host 的 exec 面共用同一后端实例（沙箱档位/secret 剥离策略单点生效）。缺省自建 L1 后端。
 */
export function makeBuiltinTools(execBackend: ExecBackend = new LocalSubprocessExecBackend()): RegisteredTool[] {
  return [
    readTool,
    writeTool,
    editTool,
    lsTool,
    grepTool,
    globTool,
    todoWriteTool,
    applyPatchTool,
    makeBashTool(execBackend),
    parallelTool, // 批量并行调用(feedback/4.10):内核内联展开,子调用逐一过准入链
  ];
}

/** 缺省内置工具集（自建 L1 后端）；需要共享 ExecBackend 时用 makeBuiltinTools(backend)。 */
export const builtinTools: RegisteredTool[] = makeBuiltinTools();
