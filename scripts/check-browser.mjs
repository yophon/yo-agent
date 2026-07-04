/**
 * check:browser（5A）—— 浏览器打包冒烟硬门。
 * esbuild platform=browser 打包冒烟入口：模块图里任何 node: 前缀或 Node 内建在解析期直接报错
 * （不能指望摇树——resolve 发生在 tree-shaking 之前）。防「往 core 入口依赖里加 node: import」回归。
 * 顺带打印 bundle 体积（观测项，不设硬门）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { compilerOptions } = JSON.parse(readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8'));
const tsPaths = compilerOptions.paths ?? {};

/** @yo-agent/* → tsconfig.base.json paths（与 tsx/vitest/tsc 同一事实源，不另立映射）。 */
const tsconfigPathsPlugin = {
  name: 'tsconfig-paths',
  setup(b) {
    b.onResolve({ filter: /^@yo-agent\// }, (args) => {
      const target = tsPaths[args.path]?.[0];
      if (!target) {
        return { errors: [{ text: `别名未在 tsconfig.base.json paths 登记：${args.path}` }] };
      }
      return { path: path.join(root, target) };
    });
  },
};

const entries = [
  path.join(root, 'scripts/browser-smoke-entry.ts'),
  // 5B：surface-web 真入口（tsconfig paths 登记后自动生效）
  ...(tsPaths['@yo-agent/surface-web'] ? [path.join(root, tsPaths['@yo-agent/surface-web'][0])] : []),
];

try {
  const result = await build({
    entryPoints: entries,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
    logLevel: 'error',
    plugins: [tsconfigPathsPlugin],
  });
  const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
  console.log(
    `check:browser ✓ ${entries.length} 个入口浏览器打包干净（无 node: 前缀/Node 内建），bundle 合计 ${(bytes / 1024).toFixed(1)} KB（未压缩，观测项）`,
  );
} catch {
  console.error('check:browser ✗ 浏览器打包失败——core 入口的模块图被牵入了 node: 前缀/Node 内建（错误见上）');
  process.exit(1);
}
