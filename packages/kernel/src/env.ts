/**
 * EnvAdapter（5.2a，抄 pi ExecutionEnv 精华）——内核自身 I/O 需求接口化。
 * 窄 FileSystem 接口按 context-files/skills/recipes 的真实 fs 调用裁剪（非照抄 pi 15 方法）；
 * 三模块注入此接口后变纯逻辑进 core → 浏览器场景（surface-web）解锁 skills/约定文件能力。
 * 产品层工具（tools/builtins）继续 Node 直连——「内核 I/O 接口化」与「工具现实妥协」并存（pi 同款分层）。
 */
import { normalizePath, resolvePath } from './paths';

export interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * 内核 I/O 能力接口。实现须保证：
 * - readTextFile/listDir/stat/realpath 对不存在的路径**抛错**（调用方以 try/catch 走静默跳过/fail-closed 分支）；
 * - realpath 返回**符号链接解析后的真实绝对路径**（@import 防逃逸依赖此语义，无链接语义的实现返回规范化路径即可）。
 */
export interface FileSystem {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  /** 目录直接子项名（不含路径前缀）。 */
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
}

/** UTF-8 字节长（Buffer 是 Node 全局，core 模块改用 TextEncoder——与 Buffer.byteLength 等价，含孤立代理项替换）。 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * 内存文件系统（测试 / 浏览器注入用）：绝对 POSIX 路径 → 内容；目录由文件路径隐式派生（'/' 恒存在）；
 * 无符号链接 → realpath = 规范化（存在性校验保留，对齐 node realpath 对缺失路径抛错）。
 */
export class MemoryFileSystem implements FileSystem {
  private files = new Map<string, string>();

  constructor(seed?: Record<string, string>) {
    if (seed) for (const [p, content] of Object.entries(seed)) this.files.set(this.norm(p), content);
  }

  private norm(p: string): string {
    return p.startsWith('/') ? normalizePath(p) : resolvePath('/', p);
  }

  private isDir(p: string): boolean {
    if (p === '/') return true;
    const prefix = `${p}/`;
    for (const key of this.files.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  async readTextFile(path: string): Promise<string> {
    const p = this.norm(path);
    const content = this.files.get(p);
    if (content === undefined) throw new Error(`ENOENT: no such file: ${p}`);
    return content;
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(this.norm(path), content);
  }

  async listDir(path: string): Promise<string[]> {
    const p = this.norm(path);
    if (!this.isDir(p)) throw new Error(`ENOENT: no such directory: ${p}`);
    const prefix = p === '/' ? '/' : `${p}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const name = rest.split('/', 1)[0]!;
      if (name) names.add(name);
    }
    return [...names].sort();
  }

  async stat(path: string): Promise<FileStat> {
    const p = this.norm(path);
    const content = this.files.get(p);
    if (content !== undefined) return { size: utf8ByteLength(content), isFile: true, isDirectory: false };
    if (this.isDir(p)) return { size: 0, isFile: false, isDirectory: true };
    throw new Error(`ENOENT: no such file or directory: ${p}`);
  }

  async exists(path: string): Promise<boolean> {
    const p = this.norm(path);
    return this.files.has(p) || this.isDir(p);
  }

  async realpath(path: string): Promise<string> {
    const p = this.norm(path);
    if (!(await this.exists(p))) throw new Error(`ENOENT: no such file or directory: ${p}`);
    return p;
  }
}

// 供 MemoryFileSystem 使用方组虚拟路径（core 内不导出 node:path）。
export { dirnamePath, joinPath, normalizePath, resolvePath } from './paths';
