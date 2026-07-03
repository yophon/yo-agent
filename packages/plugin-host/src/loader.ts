import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginSpec } from './host';
import { WorkerPluginTransport } from './transport';
import type { PluginTransport } from './transport';

/** 可被 WorkerPluginTransport 加载的插件规格（id + 模块绝对路径）。 */
export interface WorkerPluginSpec extends PluginSpec {
  modulePath: string;
}

const ENTRY_NAMES = ['plugin.mjs', 'plugin.js'];
const FILE_EXTS = ['.mjs', '.js'];

/**
 * 从若干目录发现插件（best-effort，目录不存在/读失败即跳过，绝不抛——外部插件不应阻断本机 agent）：
 *   - `<dir>/<name>/plugin.mjs`（或 plugin.js）——目录式
 *   - `<dir>/<name>.mjs`（或 .js）——单文件式
 * 后目录同名覆盖前目录（与 skills/recipes 一致：global 在前、project 在后）。
 */
export async function loadPluginSpecs(dirs: string[]): Promise<WorkerPluginSpec[]> {
  const byId = new Map<string, WorkerPluginSpec>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // 目录不存在 → 跳过
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        for (const name of ENTRY_NAMES) {
          const p = join(full, name);
          if (await isFile(p)) {
            byId.set(entry, { id: entry, modulePath: p });
            break;
          }
        }
      } else {
        const ext = FILE_EXTS.find((e) => entry.endsWith(e));
        if (ext) {
          const id = entry.slice(0, -ext.length);
          byId.set(id, { id, modulePath: full });
        }
      }
    }
  }
  return [...byId.values()];
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 通用 Worker 运行时入口（纯 ESM，无 tsx 依赖）。 */
export function workerEntryUrl(): URL {
  return new URL('./worker-entry.mjs', import.meta.url);
}

/**
 * 造 WorkerPluginTransport 工厂（喂 DefaultPluginHost.transportFor）：每个插件指向通用 worker-entry.mjs，
 * 经 workerData.modulePath 加载其模块。env 默认按白名单剥离 secret（transport 内置）。
 */
export function workerTransportFactory(
  specs: WorkerPluginSpec[],
): (spec: PluginSpec, attempt: number) => PluginTransport {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const entry = workerEntryUrl();
  return (spec) => {
    const ws = byId.get(spec.id);
    if (!ws) throw new Error(`未知插件规格：${spec.id}`);
    return new WorkerPluginTransport({
      id: spec.id,
      entry,
      workerData: { id: spec.id, modulePath: pathToFileURL(ws.modulePath).href },
    });
  };
}
