/**
 * 扩展发现 + 项目信任门（5.2b，抄 plugin-host/loader 与 mcp-trust 范式）。
 *
 * 发现（best-effort，目录缺失/读失败跳过不抛）：
 *   - `<dir>/<name>.ts|.mts|.mjs` —— 单文件式
 *   - `<dir>/<name>/extension.ts|.mts|.mjs` —— 目录式
 * 双目录 global（~/.yo-agent/extensions）在前、project（<wsRoot>/.yo-agent/extensions）在后，同名 project 覆盖。
 *
 * 信任门（主进程跑用户 TS = 任意代码执行，供应链防护）：全局目录默认信任（用户自己放的）；
 * 项目目录扩展（可随仓库带入）须 opt-in——交互态首次加载确认并落 `~/.yo-agent/extension-trust.json`
 * （`{ "<projectDir>": ["extName", ...] }`，同 mcp-trust 形制）；headless 未信任则跳过 + onWarn。
 */
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ExtensionSource = 'global' | 'project';

export interface ExtensionSpec {
  name: string;
  modulePath: string;
  source: ExtensionSource;
  /**
   * project 同名覆盖 global 时被遮蔽的 global spec（审查 MED-3）：该 project 扩展未过信任门时
   * host 回落加载此 global 版——恶意仓库放同名空壳不能零确认拆掉用户的 global 守卫扩展。
   */
  shadowedGlobal?: ExtensionSpec;
}

const FILE_EXTS = ['.ts', '.mts', '.mjs'];
const ENTRY_NAMES = FILE_EXTS.map((e) => `extension${e}`);

/** 从多个目录发现扩展（后目录同名覆盖前目录 → global 在前、project 在后，project 优先）。 */
export async function discoverExtensions(dirs: Array<{ dir: string; source: ExtensionSource }>): Promise<ExtensionSpec[]> {
  const byName = new Map<string, ExtensionSpec>();
  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // 目录不存在 → 跳过
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = (await stat(full)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        for (const name of ENTRY_NAMES) {
          const p = join(full, name);
          if (await isFile(p)) {
            byName.set(entry, withShadow(byName.get(entry), { name: entry, modulePath: p, source }));
            break;
          }
        }
      } else {
        const ext = FILE_EXTS.find((e) => entry.endsWith(e));
        if (ext) {
          const name = entry.slice(0, -ext.length);
          byName.set(name, withShadow(byName.get(name), { name, modulePath: full, source }));
        }
      }
    }
  }
  return [...byName.values()];
}

/** project 覆盖 global 时把被遮蔽的 global spec 挂到 shadowedGlobal（同源覆盖不挂）。 */
function withShadow(prev: ExtensionSpec | undefined, next: ExtensionSpec): ExtensionSpec {
  if (prev && prev.source === 'global' && next.source === 'project') return { ...next, shadowedGlobal: prev };
  return next;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 信任清单路径（`~/.yo-agent/extension-trust.json`）。 */
export function extensionTrustPath(homeDir: string): string {
  return join(homeDir, '.yo-agent', 'extension-trust.json');
}

/**
 * 读该 project 已信任的扩展名集（照 loadTrustedProjectServers 范式：ENOENT → 空集；
 * 解析失败抛错由调用方接——fail-closed 按空信任集处理）。
 */
export async function loadTrustedExtensions(homeDir: string, projectDir: string): Promise<Set<string>> {
  const path = extensionTrustPath(homeDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`扩展信任清单解析失败（${path}）：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return new Set();
  const entry = (json as Record<string, unknown>)[projectDir];
  if (!Array.isArray(entry)) return new Set();
  return new Set(entry.filter((x): x is string => typeof x === 'string'));
}

/** 把一个扩展记入该 project 的信任清单（交互确认后落盘；文件/目录不存在则创建）。 */
export async function saveTrustedExtension(homeDir: string, projectDir: string, name: string): Promise<void> {
  const path = extensionTrustPath(homeDir);
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    // 不存在/损坏 → 重建（损坏文件本就等价空信任集，重写不丢有效授权）
  }
  const cur = Array.isArray(json[projectDir]) ? (json[projectDir] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (!cur.includes(name)) cur.push(name);
  json[projectDir] = cur;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}
