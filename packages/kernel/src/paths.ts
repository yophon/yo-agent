/**
 * 纯 POSIX 路径助手（5.2a EnvAdapter）——进 core 的模块禁 node:path（check:browser 硬门），
 * context-files/skills/recipes 的路径运算改走此处。语义对齐 node:path.posix（本仓库仅支持
 * POSIX 平台，见 exec-local 的进程组语义）；调用方传绝对路径（无 process.cwd() 回退）。
 */

/** 路径分隔符（POSIX）。 */
export const PATH_SEP = '/';

/** 规范化：折叠重复分隔符、消解 `.`/`..`（绝对路径越根钳制在根；相对路径保留前导 `..`）。 */
export function normalizePath(p: string): string {
  const abs = p.startsWith('/');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!abs) parts.push('..');
    } else {
      parts.push(seg);
    }
  }
  const body = parts.join('/');
  if (abs) return `/${body}`;
  return body || '.';
}

/** 拼接并规范化（node path.join 语义；全空 → '.'）。 */
export function joinPath(...parts: string[]): string {
  const joined = parts.filter(Boolean).join('/');
  return joined ? normalizePath(joined) : '.';
}

/** 父目录（node path.dirname 语义：'/a/b'→'/a'，'/a'→'/'，'a'→'.'，'/'→'/'）。 */
export function dirnamePath(p: string): string {
  const n = normalizePath(p);
  if (n === '/') return '/';
  const i = n.lastIndexOf('/');
  if (i === -1) return '.';
  if (i === 0) return '/';
  return n.slice(0, i);
}

/** 从右往左找最后一个绝对段起拼接（node path.resolve 语义，但无 cwd 回退——调用方保证含绝对段）。 */
export function resolvePath(...parts: string[]): string {
  let start = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.startsWith('/')) {
      start = i;
      break;
    }
  }
  return normalizePath(parts.slice(start).join('/'));
}

/** target 是否落在 root 内（含等于）。root='/' 的边界正确（不产生 '//' 前缀误拒）。 */
export function isWithinPath(target: string, root: string): boolean {
  return target === root || target.startsWith(root === '/' ? '/' : root + '/');
}
