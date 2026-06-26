import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandVars,
  loadMcpServers,
  loadTrustedProjectServers,
  parseMcpConfig,
  resolveServer,
} from '@yo-agent/surface-mcp';

describe('mcp-config —— 纯解析', () => {
  it('parseMcpConfig 提取 stdio server，缺 mcpServers 返空', () => {
    const m = parseMcpConfig({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x'] } } }, 'user');
    expect(m.get('fs')).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', 'x'] });
    expect(parseMcpConfig({}, 'user').size).toBe(0);
  });

  it('parseMcpConfig 拒非法形状（顶层非对象 / 缺 command / 非 stdio）', () => {
    expect(() => parseMcpConfig([], 'user')).toThrow(/顶层必须是对象/);
    expect(() => parseMcpConfig({ mcpServers: { x: {} } }, 'user')).toThrow(/缺少 command/);
    expect(() => parseMcpConfig({ mcpServers: { x: { type: 'http', command: 'c' } } }, 'user')).toThrow(/仅支持 stdio/);
    expect(() => parseMcpConfig({ mcpServers: { x: { command: 'c', args: [1] } } }, 'user')).toThrow(/args 必须/);
    expect(() => parseMcpConfig({ mcpServers: { x: { command: 'c', env: { K: 1 } } } }, 'user')).toThrow(/必须是字符串/);
  });

  it('expandVars 展开 ${VAR}，缺失变量报错（不静默空）', () => {
    expect(expandVars('Bearer ${TOK}', { TOK: 'abc' })).toBe('Bearer abc');
    expect(() => expandVars('${MISSING}', {})).toThrow(/未定义的环境变量.*MISSING/);
  });

  it('resolveServer 在 args/env 展开 ${VAR}', () => {
    const r = resolveServer('s', { command: 'c', args: ['${A}'], env: { K: '${B}' } }, 'user', { A: 'aa', B: 'bb' });
    expect(r).toMatchObject({ name: 's', source: 'user', args: ['aa'], env: { K: 'bb' } });
  });
});

describe('mcp-config —— 三层加载 + 信任门（fs）', () => {
  let home: string;
  let project: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yo-mcp-home-'));
    project = await mkdtemp(join(tmpdir(), 'yo-mcp-proj-'));
    await mkdir(join(home, '.yo-agent'), { recursive: true });
    await mkdir(join(project, '.yo-agent'), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  const writeCfg = (dir: string, file: string, obj: unknown) =>
    writeFile(join(dir, '.yo-agent', file), JSON.stringify(obj));

  it('缺文件 → 空列表（默认无 MCP，普通用户零影响）', async () => {
    const servers = await loadMcpServers({ homeDir: home, projectDir: project, processEnv: {} });
    expect(servers).toEqual([]);
  });

  it('project server 默认 inactive，opt-in 信任后才出现（供应链防护）', async () => {
    await writeCfg(project, 'mcp.json', { mcpServers: { evil: { command: 'x' } } });

    const skipped = await loadMcpServers({ homeDir: home, projectDir: project, processEnv: {} });
    expect(skipped).toEqual([]); // 未信任 → 不进列表

    const trusted = await loadMcpServers({
      homeDir: home,
      projectDir: project,
      processEnv: {},
      isProjectServerTrusted: (n) => n === 'evil',
    });
    expect(trusted.map((s) => s.name)).toEqual(['evil']);
    expect(trusted[0]!.source).toBe('project');
  });

  it('user 层激活；local 覆盖 user（后覆盖前）', async () => {
    await writeCfg(home, 'mcp.json', { mcpServers: { fs: { command: 'user-cmd' } } });
    await writeCfg(project, 'mcp.local.json', { mcpServers: { fs: { command: 'local-cmd' } } });
    const servers = await loadMcpServers({ homeDir: home, projectDir: project, processEnv: {} });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'fs', source: 'local', command: 'local-cmd' });
  });

  it('${VAR} 展开走 process.env，配置文件不被改写', async () => {
    const cfgPath = join(home, '.yo-agent', 'mcp.json');
    const raw = { mcpServers: { fs: { command: 'c', env: { TOKEN: '${SECRET}' } } } };
    await writeFile(cfgPath, JSON.stringify(raw));
    const servers = await loadMcpServers({ homeDir: home, projectDir: project, processEnv: { SECRET: 's3cr3t' } });
    expect(servers[0]!.env).toEqual({ TOKEN: 's3cr3t' });
    // 关键：磁盘配置仍是 ${SECRET}，明文未写回（不泄密）
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(cfgPath, 'utf8')).toContain('${SECRET}');
  });

  it('缺失 env 变量 → 加载报错（不静默连错 server）', async () => {
    await writeCfg(home, 'mcp.json', { mcpServers: { fs: { command: 'c', env: { K: '${NOPE}' } } } });
    await expect(loadMcpServers({ homeDir: home, projectDir: project, processEnv: {} })).rejects.toThrow(/NOPE/);
  });

  it('loadTrustedProjectServers 按 project 路径读信任清单', async () => {
    await writeFile(
      join(home, '.yo-agent', 'mcp-trust.json'),
      JSON.stringify({ [project]: ['fs', 'git'], '/other': ['x'] }),
    );
    const trusted = await loadTrustedProjectServers(home, project);
    expect([...trusted].sort()).toEqual(['fs', 'git']);
    expect(await loadTrustedProjectServers(home, '/unknown')).toEqual(new Set());
  });
});
