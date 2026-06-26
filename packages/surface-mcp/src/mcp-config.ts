/**
 * MCP host 三层信任配置（DESIGN §15.3）—— 解析 mcp.json + opt-in 信任门 + `${VAR}` 展开。
 *
 * 供应链防护核心：
 *  - **project 层（`.yo-agent/mcp.json`）默认 inactive**：仓库里带的 server 配置不被自动信任，
 *    必须显式 opt-in（`~/.yo-agent/mcp-trust.json` 按 project 路径记名）才启用——防 clone 即跑恶意 server。
 *  - **`${VAR}` 走 `process.env` 展开**，仅在内存中、绝不写回配置文件、缺失变量报错而非静默空值。
 *  - 解析层为纯函数（`parseMcpConfig`/`expandVars`/`resolveServer`），fs 仅在 `loadMcpServers`/
 *    `loadTrustedProjectServers` 薄包一层，便于离线单测。
 *
 * 当前仅 stdio（HTTP/OAuth 见 3G）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type McpConfigSource = 'user' | 'project' | 'local';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export type McpServerConfig = McpStdioServerConfig;

export interface ResolvedMcpServer {
  name: string;
  source: McpConfigSource;
  command: string;
  args: string[];
  /** `${VAR}` 已展开（仅内存，未写回磁盘）。 */
  env: Record<string, string>;
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 展开 `${VAR}` → process.env；缺失变量抛错（绝不静默空值，防误连错 server）。 */
export function expandVars(value: string, processEnv: Record<string, string | undefined>): string {
  return value.replace(VAR_RE, (_m, name: string) => {
    const v = processEnv[name];
    if (v === undefined) {
      throw new Error(`MCP 配置引用了未定义的环境变量 \${${name}}（缺失则报错，绝不静默空值）`);
    }
    return v;
  });
}

/** 解析单个配置文件 JSON（纯函数）：校验形状，非法即抛（不静默忽略，防配置静默失效）。 */
export function parseMcpConfig(json: unknown, sourceLabel: string): Map<string, McpServerConfig> {
  const out = new Map<string, McpServerConfig>();
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`MCP 配置（${sourceLabel}）顶层必须是对象`);
  }
  const servers = (json as Record<string, unknown>).mcpServers;
  if (servers === undefined) return out; // 无 mcpServers 字段 = 空（合法）
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`MCP 配置（${sourceLabel}）的 mcpServers 必须是对象`);
  }
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!name) throw new Error(`MCP server 名不能为空（${sourceLabel}）`);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`MCP server「${name}」配置必须是对象（${sourceLabel}）`);
    }
    const r = raw as Record<string, unknown>;
    const type = r.type ?? 'stdio';
    if (type !== 'stdio') {
      throw new Error(`MCP server「${name}」暂仅支持 stdio 传输（${sourceLabel}；HTTP/OAuth 见 Phase 3G）`);
    }
    if (typeof r.command !== 'string' || !r.command) {
      throw new Error(`MCP server「${name}」缺少 command（${sourceLabel}）`);
    }
    const args = r.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
      throw new Error(`MCP server「${name}」args 必须是字符串数组（${sourceLabel}）`);
    }
    const env = r.env ?? {};
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new Error(`MCP server「${name}」env 必须是对象（${sourceLabel}）`);
    }
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new Error(`MCP server「${name}」env.${k} 必须是字符串（${sourceLabel}）`);
    }
    out.set(name, { type: 'stdio', command: r.command, args: args as string[], env: env as Record<string, string> });
  }
  return out;
}

/** 把一个配置项解析为可启动 server：args/env 内 `${VAR}` 展开（纯函数）。 */
export function resolveServer(
  name: string,
  cfg: McpServerConfig,
  source: McpConfigSource,
  processEnv: Record<string, string | undefined>,
): ResolvedMcpServer {
  return {
    name,
    source,
    command: cfg.command,
    args: (cfg.args ?? []).map((a) => expandVars(a, processEnv)),
    env: Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, expandVars(v, processEnv)])),
  };
}

export interface LoadMcpOpts {
  /** ~（user 层 mcp.json / 信任清单所在）。 */
  homeDir: string;
  /** 当前 workspace（project / local 层 mcp.json 所在）。 */
  projectDir: string;
  processEnv: Record<string, string | undefined>;
  /** project 层 server 信任判定；默认全不信任（opt-in 防供应链）。 */
  isProjectServerTrusted?: (name: string) => boolean;
  log?: (msg: string) => void;
}

/**
 * 加载并合并三层配置 → 可启动 server 列表。
 * 合并顺序（后覆盖前）：project(已信任) < user < local。
 *  - user（`~/.yo-agent/mcp.json`）：默认激活。
 *  - project（`<cwd>/.yo-agent/mcp.json`）：**默认 inactive**，未 opt-in 信任则跳过（供应链防护）。
 *  - local（`<cwd>/.yo-agent/mcp.local.json`）：开发者机器本地、gitignore，优先级最高。
 */
export async function loadMcpServers(opts: LoadMcpOpts): Promise<ResolvedMcpServer[]> {
  const trust = opts.isProjectServerTrusted ?? (() => false);
  const userCfg = await readConfigFile(join(opts.homeDir, '.yo-agent', 'mcp.json'), 'user');
  const projectCfg = await readConfigFile(join(opts.projectDir, '.yo-agent', 'mcp.json'), 'project');
  const localCfg = await readConfigFile(join(opts.projectDir, '.yo-agent', 'mcp.local.json'), 'local');

  const merged = new Map<string, { cfg: McpServerConfig; source: McpConfigSource }>();
  for (const [name, cfg] of projectCfg) {
    if (!trust(name)) {
      opts.log?.(`[mcp] project server「${name}」未 opt-in 信任，已跳过（供应链防护；信任后启用）`);
      continue;
    }
    merged.set(name, { cfg, source: 'project' });
  }
  for (const [name, cfg] of userCfg) merged.set(name, { cfg, source: 'user' });
  for (const [name, cfg] of localCfg) merged.set(name, { cfg, source: 'local' });

  return [...merged].map(([name, { cfg, source }]) => resolveServer(name, cfg, source, opts.processEnv));
}

/** 读 `~/.yo-agent/mcp-trust.json`（`{ "<projectDir>": ["serverName", ...] }`）→ 该 project 的信任 server 名集。 */
export async function loadTrustedProjectServers(homeDir: string, projectDir: string): Promise<Set<string>> {
  const path = join(homeDir, '.yo-agent', 'mcp-trust.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw e;
  }
  const json = JSON.parse(text) as Record<string, unknown>;
  const entry = json[projectDir];
  if (!Array.isArray(entry)) return new Set();
  return new Set(entry.filter((x): x is string => typeof x === 'string'));
}

async function readConfigFile(path: string, label: McpConfigSource): Promise<Map<string, McpServerConfig>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`MCP 配置解析失败（${label}，${path}）：${e instanceof Error ? e.message : String(e)}`);
  }
  return parseMcpConfig(json, label);
}
