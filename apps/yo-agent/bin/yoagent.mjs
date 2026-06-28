#!/usr/bin/env node
/**
 * yoagent 全局启动器。
 *
 * 本仓库是「源码态 workspace」（无构建产物，CLI 经 tsx 直跑、`exports` 指向 src），
 * 所以全局命令不能简单地 `node main.js`，而是：用仓库自带的 tsx loader 注册 TS/路径别名解析，
 * 再以「用户当前工作目录（cwd）」为 agent 的操作根目录加载 main.ts。
 *
 * 安装：在仓库根执行 `pnpm run install:cli`（把本文件软链到 PATH 上的某个目录）。
 * 之后任意目录 `yoagent -p "提问"` 即可；所有原 CLI 子命令/开关原样透传。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * 加载私密运行配置（KEY=VALUE，# 注释）。默认 ~/.config/yo-agent/config.env，
 * 可用 YO_CONFIG 覆盖路径。已在 shell 显式 export 的同名变量优先（不被覆盖），
 * 便于临时 `YO_MODEL=... yoagent ...` 一次性切换。
 */
function loadConfigEnv() {
  const path = process.env.YO_CONFIG ?? join(homedir(), '.config', 'yo-agent', 'config.env');
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

loadConfigEnv();

const here = dirname(fileURLToPath(import.meta.url)); // apps/yo-agent/bin
const app = resolve(here, '..'); // apps/yo-agent
const repo = resolve(app, '..', '..'); // 仓库根
const loader = join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const main = join(app, 'src', 'main.ts');

if (!existsSync(loader)) {
  process.stderr.write(
    `[yoagent] 找不到 tsx loader：${loader}\n` +
      `请先在仓库根（${repo}）执行 \`pnpm install\`。\n`,
  );
  process.exit(127);
}

const child = spawn(process.execPath, ['--import', loader, main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // tsconfig 路径别名（@yo-agent/* → packages/*/src）以仓库根 tsconfig 为准，
    // 与用户当前 cwd 解耦，保证从任意目录启动都能解析。
    TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH ?? join(repo, 'tsconfig.json'),
  },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
