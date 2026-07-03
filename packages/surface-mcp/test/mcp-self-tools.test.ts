import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool, ToolContext } from '@yo-agent/tools';
import {
  McpHostManager,
  makeMcpListResourcesTool,
  makeMcpListServersTool,
  makeMcpReadResourceTool,
  toolDescriptorFromMcp,
} from '@yo-agent/surface-mcp';
import type { ResolvedMcpServer } from '@yo-agent/surface-mcp';

const ctx: ToolContext = { sessionId: 's1', cwd: '/w' };

async function run(tool: RegisteredTool, input: unknown): Promise<string> {
  let out = '';
  for await (const ev of tool.executor.execute(input, ctx)) {
    if (ev.kind === 'output') out += ev.chunk;
  }
  return out;
}

async function startFakeServer(): Promise<Transport> {
  const server = new McpServer({ name: 'fs', version: '0.0.0' });
  server.registerTool('echo', { description: 'echo back', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  server.registerResource(
    'greeting',
    'mem://greeting.txt',
    { description: 'a greeting', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'HELLO-RESOURCE' }] }),
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  return clientT;
}

const spec = (): ResolvedMcpServer => ({ name: 'fs', source: 'user', command: '', args: [], env: {} });

describe('4.9f — MCP 自述与通道接线（离线 FakeServer）', () => {
  it('mcp_list_servers：server/状态/工具数/信任层 + 信任门跳过名单 + opt-in 指引', async () => {
    const registry = new InMemoryToolRegistry();
    const clientT = await startFakeServer();
    const host = new McpHostManager({ registry, transportFor: () => clientT });
    await host.addServer(spec());
    const tool = makeMcpListServersTool(host, { skippedUntrusted: () => ['github'] });
    const out = await run(tool, {});
    expect(out).toContain('fs：connected（1 个工具');
    expect(out).toContain('信任层 user');
    expect(out).toContain('未信任跳过（工具不可用）：github');
    expect(out).toContain('mcp-trust.json');
  });

  it('mcp_list_servers：空态明说（无 server 无跳过）', async () => {
    const host = new McpHostManager({ registry: new InMemoryToolRegistry(), transportFor: () => ({}) as Transport });
    const out = await run(makeMcpListServersTool(host), {});
    expect(out).toContain('没有已连接的 MCP server');
  });

  it('mcp_list_resources / mcp_read_resource：往返取回资源清单与内容', async () => {
    const registry = new InMemoryToolRegistry();
    const clientT = await startFakeServer();
    const host = new McpHostManager({ registry, transportFor: () => clientT });
    await host.addServer(spec());
    const listOut = await run(makeMcpListResourcesTool(host), { server: 'fs' });
    expect(listOut).toContain('mem://greeting.txt');
    expect(listOut).toContain('[text/plain]');
    const readOut = await run(makeMcpReadResourceTool(host), { server: 'fs', uri: 'mem://greeting.txt' });
    expect(readOut).toBe('HELLO-RESOURCE');
  });

  it('未连接 server → 可行动错误（指向 mcp_list_servers）', async () => {
    const host = new McpHostManager({ registry: new InMemoryToolRegistry(), transportFor: () => ({}) as Transport });
    await expect(run(makeMcpListResourcesTool(host), { server: 'nope' })).rejects.toThrow(/未连接.*mcp_list_servers/s);
  });

  it('审批面：list_servers/list_resources 免审批（只读元数据），read_resource 走 risk-based（外部内容）', () => {
    const host = new McpHostManager({ registry: new InMemoryToolRegistry(), transportFor: () => ({}) as Transport });
    expect(makeMcpListServersTool(host).descriptor.approval).toBe('never');
    expect(makeMcpListResourcesTool(host).descriptor.approval).toBe('never');
    expect(makeMcpReadResourceTool(host).descriptor.approval).toBe('risk-based');
  });
});

describe('4.9f — MCP 工具描述来源前缀（快照）', () => {
  it('toolDescriptorFromMcp 前缀「[外部 MCP server「X」提供]」', () => {
    const d = toolDescriptorFromMcp('github', { name: 'create_issue', description: '创建 issue' });
    expect(d.description).toMatchInlineSnapshot(`"[外部 MCP server「github」提供] 创建 issue"`);
    expect(d.name).toBe('mcp__github__create_issue');
  });

  it('无描述也有来源前缀', () => {
    const d = toolDescriptorFromMcp('fs', { name: 'read' });
    expect(d.description).toBe('[外部 MCP server「fs」提供] ');
  });
});
