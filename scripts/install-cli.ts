/**
 * 把 `yoagent` 装到 PATH 上的一个目录，使任意目录可直接调用。
 *
 * POSIX：软链 launcher → `<binDir>/yoagent`。选址优先级：YO_BIN_DIR（显式覆盖）> 第一个「在 $PATH 中且可写」
 *   的常见目录（/opt/homebrew/bin、~/.local/bin、/usr/local/bin）。软链而非拷贝：源码态仓库随 git pull 即时生效。
 * Windows：无可靠软链（需特权/开发者模式），改写两个 shim 到 `%LOCALAPPDATA%\yo-agent\bin`——
 *   `yoagent.cmd`（cmd / PowerShell 用）+ `yoagent`（Git Bash 用的 sh 脚本），均以安装时的 node 绝对路径
 *   执行 launcher，同样随 git pull 即时生效。
 *
 *   pnpm run install:cli            # 自动选址
 *   YO_BIN_DIR=~/.local/bin pnpm run install:cli
 */
import { chmodSync, mkdirSync, accessSync, constants, symlinkSync, unlinkSync, existsSync, lstatSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = join(repo, 'apps', 'yo-agent', 'bin', 'yoagent.mjs');
const win = process.platform === 'win32';

if (!win) chmodSync(launcher, 0o755);

const pathDirs = (process.env.PATH ?? '').split(delimiter);
const norm = (d: string) => (win ? d.toLowerCase().replace(/[\\/]+$/, '') : d);
const inPath = (d: string) => pathDirs.some((p) => norm(p) === norm(d) || norm(p) === norm(d.replace(homedir(), '~')));
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
  if (win) {
    const d = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'yo-agent', 'bin');
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

/** lstat + unlink：两者都不追链接。rmSync(force) 对「死链接」会顺链探测到 ENOENT 静默跳过不删，随后 symlinkSync 撞 EEXIST。 */
function removeIfExists(p: string): void {
  try {
    lstatSync(p);
    unlinkSync(p);
  } catch {
    /* 不存在即无需删 */
  }
}

const binDir = pickBinDir();

if (win) {
  const cmdShim = join(binDir, 'yoagent.cmd');
  const shShim = join(binDir, 'yoagent');
  const node = process.execPath;
  removeIfExists(cmdShim);
  removeIfExists(shShim);
  writeFileSync(cmdShim, `@echo off\r\n"${node}" "${launcher}" %*\r\n`);
  // Git Bash：sh 脚本（无扩展名），Windows 路径用正斜杠引用即可。
  writeFileSync(shShim, `#!/bin/sh\nexec "${node.replace(/\\/g, '/')}" "${launcher.replace(/\\/g, '/')}" "$@"\n`);
  process.stdout.write(`✅ 已安装：${cmdShim}（cmd / PowerShell）与 ${shShim}（Git Bash）→ ${launcher}\n`);
  if (!inPath(binDir)) {
    process.stdout.write(
      `⚠️  ${binDir} 不在 PATH。请在 PowerShell 执行一次（写入用户级 PATH，重开终端生效）：\n` +
        `   [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${binDir}', 'User')\n`,
    );
  }
} else {
  const target = join(binDir, 'yoagent');
  removeIfExists(target);
  symlinkSync(launcher, target);
  process.stdout.write(`✅ 已安装：${target} → ${launcher}\n`);
  if (!inPath(binDir)) {
    process.stdout.write(
      `⚠️  ${binDir} 不在 PATH。请加到 shell 配置（~/.zshrc）：\n` +
        `   export PATH="${binDir}:$PATH"\n`,
    );
  }
}
process.stdout.write(`现在任意目录可运行：  yoagent -p "你的提问"\n`);
