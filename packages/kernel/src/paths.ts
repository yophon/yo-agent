/**
 * 纯路径助手（5.2a EnvAdapter）——进 core 的模块禁 node:path（check:browser 硬门），
 * context-files/skills/recipes 的路径运算改走此处。
 *
 * 内部统一形态 = 正斜杠：输入可带反斜杠（Windows 原生路径），一律归一为 `/`；输出恒为 `/` 分隔。
 * 绝对路径两种根：POSIX `/` 与 Windows 盘符 `C:/`（盘符后恒带 `/`）。Node fs 在 Windows 上接受正斜杠，
 * 调用方拿到的归一路径可直接落 fs；需与 node:path 产物比对时先 toPosixPath 再比。
 * 调用方传绝对路径（无 process.cwd() 回退）。
 */

/** 路径分隔符（内部形态恒为 POSIX）。 */
export const PATH_SEP = '/';

/** 反斜杠 → 正斜杠（Windows 原生路径归一；POSIX 路径原样）。 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 归一化路径的根：'/'（POSIX 绝对）| 'C:/'（Windows 盘符绝对）| ''（相对）。 */
function rootOf(n: string): string {
  if (/^[A-Za-z]:\//.test(n)) return n.slice(0, 3);
  if (n.startsWith('/')) return '/';
  return '';
}

/** 是否绝对路径（POSIX `/x` 或 Windows `C:/x` / `C:\x` / `C:`）。 */
export function isAbsolutePath(p: string): boolean {
  const s = toPosixPath(p);
  return s.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(s);
}

/** 规范化：分隔符归一、折叠重复分隔符、消解 `.`/`..`（绝对路径越根钳制在根；相对路径保留前导 `..`）。 */
export function normalizePath(p: string): string {
  const s = toPosixPath(p);
  const driveMatch = /^([A-Za-z]:)(\/|$)/.exec(s);
  const drive = driveMatch ? driveMatch[1]! : '';
  const rest = drive ? s.slice(drive.length) : s;
  const abs = drive !== '' || rest.startsWith('/');
  const parts: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!abs) parts.push('..');
    } else {
      parts.push(seg);
    }
  }
  const body = parts.join('/');
  if (drive) return `${drive}/${body}`;
  if (abs) return `/${body}`;
  return body || '.';
}

/** 拼接并规范化（node path.join 语义；全空 → '.'）。 */
export function joinPath(...parts: string[]): string {
  const joined = parts.filter(Boolean).join('/');
  return joined ? normalizePath(joined) : '.';
}

/** 父目录（node path.dirname 语义：'/a/b'→'/a'，'/a'→'/'，'C:/a'→'C:/'，'a'→'.'，根→根）。 */
export function dirnamePath(p: string): string {
  const n = normalizePath(p);
  const root = rootOf(n);
  if (root && n === root) return root;
  const i = n.lastIndexOf('/');
  if (i === -1) return '.';
  if (i < root.length) return root;
  return n.slice(0, i);
}

/** 从右往左找最后一个绝对段起拼接（node path.resolve 语义，但无 cwd 回退——调用方保证含绝对段）。 */
export function resolvePath(...parts: string[]): string {
  let start = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isAbsolutePath(parts[i]!)) {
      start = i;
      break;
    }
  }
  return normalizePath(parts.slice(start).join('/'));
}

/**
 * target 是否落在 root 内（含等于）。两侧先归一（分隔符/冗余段），root 为文件系统根（'/' 或 'C:/'）时
 * 不产生 '//' 前缀误拒。不做大小写折叠：两侧应同源于 realpath（Windows 下 realpath 已归一大小写）。
 */
export function isWithinPath(target: string, root: string): boolean {
  const t = normalizePath(target);
  const r = normalizePath(root);
  if (t === r) return true;
  return t.startsWith(r.endsWith('/') ? r : `${r}/`);
}
