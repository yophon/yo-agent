import { readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RegisteredTool, ToolContext } from './index';

/** L0 路径保护：限制工具读写在 cwd 内（DESIGN §3.4 / §9.4）。 */
function confine(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界（超出 cwd）：${p}`);
  }
  return abs;
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

export const builtinTools: RegisteredTool[] = [readTool, writeTool, lsTool];
