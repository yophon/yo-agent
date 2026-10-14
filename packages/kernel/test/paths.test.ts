import { describe, expect, it } from 'vitest';
import { dirnamePath, isAbsolutePath, isWithinPath, joinPath, normalizePath, resolvePath, toPosixPath } from '@yo-agent/kernel';

/** 纯函数，跨平台同一断言（Windows 盘符形态在 macOS/Linux CI 上同样覆盖）。 */
describe('paths —— POSIX', () => {
  it('normalize/join/dirname/resolve 对齐 node:path.posix', () => {
    expect(normalizePath('/a//b/./c/../d')).toBe('/a/b/d');
    expect(normalizePath('/../x')).toBe('/x'); // 越根钳制
    expect(normalizePath('a/../../b')).toBe('../b'); // 相对保留前导 ..
    expect(normalizePath('')).toBe('.');
    expect(joinPath('/a', 'b', 'c.md')).toBe('/a/b/c.md');
    expect(joinPath()).toBe('.');
    expect(dirnamePath('/a/b')).toBe('/a');
    expect(dirnamePath('/a')).toBe('/');
    expect(dirnamePath('/')).toBe('/');
    expect(dirnamePath('a')).toBe('.');
    expect(resolvePath('/x', 'y', '/z', 'w')).toBe('/z/w');
    expect(resolvePath('/x', '../y')).toBe('/y');
  });

  it('isWithinPath：含等于、根边界不产生 //、前缀同名目录不误放行', () => {
    expect(isWithinPath('/a/b', '/a')).toBe(true);
    expect(isWithinPath('/a', '/a')).toBe(true);
    expect(isWithinPath('/a/b', '/')).toBe(true);
    expect(isWithinPath('/ab', '/a')).toBe(false);
    expect(isWithinPath('/x', '/a')).toBe(false);
  });
});

describe('paths —— Windows 盘符路径（反斜杠输入归一为正斜杠内部形态）', () => {
  it('toPosixPath / isAbsolutePath', () => {
    expect(toPosixPath('C:\\Users\\x\\repo')).toBe('C:/Users/x/repo');
    expect(isAbsolutePath('C:\\x')).toBe(true);
    expect(isAbsolutePath('C:/x')).toBe(true);
    expect(isAbsolutePath('C:')).toBe(true);
    expect(isAbsolutePath('/x')).toBe(true);
    expect(isAbsolutePath('x\\y')).toBe(false);
  });

  it('normalize：盘符根恒带 /，.. 钳制在盘符根', () => {
    expect(normalizePath('C:\\a\\.\\b\\..\\c')).toBe('C:/a/c');
    expect(normalizePath('C:\\')).toBe('C:/');
    expect(normalizePath('C:')).toBe('C:/');
    expect(normalizePath('C:\\..\\x')).toBe('C:/x');
  });

  it('dirname 链到盘符根终止（dirChain 的 parent===cur 终止条件成立）', () => {
    expect(dirnamePath('C:\\a\\b')).toBe('C:/a');
    expect(dirnamePath('C:/a')).toBe('C:/');
    expect(dirnamePath('C:/')).toBe('C:/');
    expect(dirnamePath('C:\\')).toBe('C:/');
  });

  it('resolve：盘符段视为绝对，覆盖其左侧', () => {
    expect(resolvePath('/posix', 'C:\\w', 'sub')).toBe('C:/w/sub');
    expect(resolvePath('C:\\w\\a', '..\\b')).toBe('C:/w/b');
    expect(resolvePath('C:\\w', 'D:\\other')).toBe('D:/other');
  });

  it('isWithinPath：两侧分隔符混用也能比；前缀同名目录拒；盘符根边界', () => {
    expect(isWithinPath('C:\\w\\MEMORY.md', 'C:/w')).toBe(true);
    expect(isWithinPath('C:/w', 'C:\\w\\')).toBe(true);
    expect(isWithinPath('C:/wx/a', 'C:/w')).toBe(false);
    expect(isWithinPath('C:/x', 'C:/')).toBe(true);
    expect(isWithinPath('D:/w/a', 'C:/w')).toBe(false);
    expect(isWithinPath('C:/w/../secret.md', 'C:/w')).toBe(false);
  });

  it('joinPath：反斜杠段拼接后统一正斜杠', () => {
    expect(joinPath('C:\\Users\\x', '.yo-agent', 'skills')).toBe('C:/Users/x/.yo-agent/skills');
  });
});
