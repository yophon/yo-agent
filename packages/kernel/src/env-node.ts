/**
 * NodeFileSystem（5.2a）——FileSystem 的 Node 实现，把 context-files/skills/recipes 原有的
 * node:fs 调用语义原样搬入。**不进 core**（仅主入口 index.ts 导出）；浏览器面注入 MemoryFileSystem 或宿主自实现。
 */
import { access, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import type { FileStat, FileSystem } from './env';
import { toPosixPath } from './paths';

export class NodeFileSystem implements FileSystem {
  readTextFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  writeTextFile(path: string, content: string): Promise<void> {
    return writeFile(path, content, 'utf8');
  }

  listDir(path: string): Promise<string[]> {
    return readdir(path);
  }

  async stat(path: string): Promise<FileStat> {
    const s = await stat(path);
    return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** realpath 结果归一为正斜杠（内核路径内部形态，见 paths.ts）——Windows 下 node 返回反斜杠，否则 isWithinPath 前缀比对失配。 */
  async realpath(path: string): Promise<string> {
    return toPosixPath(await realpath(path));
  }
}
