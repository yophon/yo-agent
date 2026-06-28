/**
 * 把 `yoagent` 软链到 PATH 上的一个目录，使任意目录可直接调用。
 *
 * 选址优先级：YO_BIN_DIR（显式覆盖）> 第一个「在 $PATH 中且可写」的常见目录
 *   （/opt/homebrew/bin、~/.local/bin、/usr/local/bin）。
 * 软链而非拷贝：源码态仓库随 git pull 即时生效，无需重装。
 *
 *   pnpm run install:cli            # 自动选址
 *   YO_BIN_DIR=~/.local/bin pnpm run install:cli
 */
import { chmodSync, mkdirSync, accessSync, constants, symlinkSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = join(repo, 'apps', 'yo-agent', 'bin', 'yoagent.mjs');

chmodSync(launcher, 0o755);

const pathDirs = (process.env.PATH ?? '').split(':');
const inPath = (d: string) => pathDirs.includes(d) || pathDirs.includes(d.replace(homedir(), '~'));
const writable = (d: string) => {
  try {
    accessSync(d, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

function pickBinDir(): string {
  const override = process.env.YO_BIN_DIR;
  if (override) {
    const d = override.replace(/^~/, homedir());
    mkdirSync(d, { recursive: true });
    return d;
  }
  const candidates = ['/opt/homebrew/bin', join(homedir(), '.local/bin'), '/usr/local/bin'];
  for (const d of candidates) {
    if (existsSync(d) && inPath(d) && writable(d)) return d;
  }
  // 兜底：~/.local/bin（建好；若不在 PATH 提示用户加）
  const fallback = join(homedir(), '.local/bin');
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

const binDir = pickBinDir();
const target = join(binDir, 'yoagent');

if (existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })()) {
  rmSync(target, { force: true });
}
symlinkSync(launcher, target);

process.stdout.write(`✅ 已安装：${target} → ${launcher}\n`);
if (!inPath(binDir)) {
  process.stdout.write(
    `⚠️  ${binDir} 不在 PATH。请加到 shell 配置（~/.zshrc）：\n` +
      `   export PATH="${binDir}:$PATH"\n`,
  );
}
process.stdout.write(`现在任意目录可运行：  yoagent -p "你的提问"\n`);
