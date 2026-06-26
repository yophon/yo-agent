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

  it('local 层默认 inactive 需 opt-in（不假定 gitignore，防随仓库带入绕过信任）', async () => {
    await writeCfg(home, 'mcp.json', { mcpServers: { fs: { command: 'user-cmd' } } });
    await writeCfg(project, 'mcp.local.json', { mcpServers: { fs: { command: 'local-cmd' } } });

    // local 未信任 → 被跳过，仅 user 层生效（不被仓库内 local 覆盖）
    const untrusted = await loadMcpServers({ homeDir: home, projectDir: project, processEnv: {} });
    expect(untrusted).toHaveLength(1);
    expect(untrusted[0]).toMatchObject({ name: 'fs', source: 'user', command: 'user-cmd' });

    // local opt-in 信任后 → 覆盖 user（后覆盖前）
    const trusted = await loadMcpServers({
      homeDir: home,
      projectDir: project,
      processEnv: {},
      isProjectServerTrusted: (n) => n === 'fs',
    });
    expect(trusted[0]).toMatchObject({ name: 'fs', source: 'local', command: 'local-cmd' });
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

  it('缺失 env 的 server 被 per-server 跳过并记错，不连累同层其余 server（隔离）', async () => {
    await writeCfg(home, 'mcp.json', {
      mcpServers: { bad: { command: 'c', env: { K: '${NOPE}' } }, good: { command: 'ok' } },
    });
    const logs: string[] = [];
    const servers = await loadMcpServers({
      homeDir: home,
      projectDir: project,
      processEnv: {},
      log: (m) => logs.push(m),
    });
    expect(servers.map((s) => s.name)).toEqual(['good']); // good 照常，bad 被跳过
    expect(logs.some((l) => l.includes('bad') && l.includes('NOPE'))).toBe(true); // 错误可见，非静默
  });

  it('单层文件损坏只跳过该层，不连累其余层（per-layer 隔离）', async () => {
    await writeFile(join(project, '.yo-agent', 'mcp.json'), '{ broken json');
    await writeCfg(home, 'mcp.json', { mcpServers: { fs: { command: 'ok' } } });
    const logs: string[] = [];
    const servers = await loadMcpServers({ homeDir: home, projectDir: project, processEnv: {}, log: (m) => logs.push(m) });
    expect(servers.map((s) => s.name)).toEqual(['fs']); // user 层照常
    expect(logs.some((l) => l.includes('project') && l.includes('跳过该层'))).toBe(true);
  });

  it('command 含 ${VAR} → parse 报错（command 不展开，避免静默 spawn 失败）', () => {
    expect(() => parseMcpConfig({ mcpServers: { x: { command: '${HOME}/bin/s' } } }, 'user')).toThrow(/command 不支持/);
  });

  it('信任清单坏 JSON / null 顶层 → fail-closed 不崩（返回空信任集或带 path 报错）', async () => {
    // null 顶层：不抛 TypeError，返回空集
    await writeFile(join(home, '.yo-agent', 'mcp-trust.json'), 'null');
    expect(await loadTrustedProjectServers(home, project)).toEqual(new Set());
    // 坏 JSON：抛带 path 的清晰错误
    await writeFile(join(home, '.yo-agent', 'mcp-trust.json'), '{bad');
    await expect(loadTrustedProjectServers(home, project)).rejects.toThrow(/信任清单解析失败/);
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
