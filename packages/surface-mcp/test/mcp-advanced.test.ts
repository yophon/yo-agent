import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { FakeProvider, textTurn } from '@yo-agent/provider';
import type { ToolContext } from '@yo-agent/tools';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import {
  McpHostManager,
  RateLimiter,
  assertOAuthTransportCompatible,
  createHttpClientTransport,
  createSamplingHandler,
  FileOAuthClientProvider,
  mcpExecutor,
} from '@yo-agent/surface-mcp';
import type { ResolvedMcpServer, SamplingHandler } from '@yo-agent/surface-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// ───────────────────────── HTTP 传输 + OAuth fail-fast ─────────────────────────

describe('3G — Streamable HTTP 传输 + OAuth 兼容守卫', () => {
  it('createHttpClientTransport 构造可用 transport（不连接）', () => {
    const t = createHttpClientTransport('http://localhost:9999/mcp');
    expect(typeof t.start).toBe('function');
    expect(typeof t.send).toBe('function');
  });

  it('WS + OAuth → fail-fast；HTTP + OAuth 放行；WS 无 OAuth 放行', () => {
    expect(() => assertOAuthTransportCompatible('ws', true)).toThrow(/WS/);
    expect(() => assertOAuthTransportCompatible('stdio', true)).toThrow();
    expect(() => assertOAuthTransportCompatible('http', true)).not.toThrow();
    expect(() => assertOAuthTransportCompatible('ws', false)).not.toThrow();
  });
});

// ───────────────────────── OAuth provider 持久化 ─────────────────────────

describe('3G — FileOAuthClientProvider 持久化（PKCE/token/注册信息）', () => {
  it('token / codeVerifier / clientInformation 落盘后可读回；redirectToAuthorization 带外不开浏览器', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yo-oauth-'));
    try {
      let redirected: URL | null = null;
      const p = new FileOAuthClientProvider({ dir, redirectUrl: 'http://localhost/cb', onAuthorize: (u) => (redirected = u) });
      expect(p.clientMetadata.redirect_uris).toEqual(['http://localhost/cb']);
      // 未登录 → undefined。
      expect(p.tokens()).toBeUndefined();
      p.saveTokens({ access_token: 'AT', token_type: 'Bearer', refresh_token: 'RT' });
      expect(p.tokens()?.access_token).toBe('AT');
      p.saveCodeVerifier('verifier-123');
      expect(p.codeVerifier()).toBe('verifier-123');
      p.saveClientInformation({ client_id: 'cid', redirect_uris: ['http://localhost/cb'] });
      expect(p.clientInformation()?.client_id).toBe('cid');
      // 带外授权：调 onAuthorize、不抛错（不开浏览器、不阻塞）。
      p.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));
      expect(redirected).not.toBeNull();
      // 跨"进程"：新实例读回同目录持久态。
      const p2 = new FileOAuthClientProvider({ dir, redirectUrl: 'http://localhost/cb' });
      expect(p2.tokens()?.refresh_token).toBe('RT');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── RateLimiter + sampling handler ─────────────────────────

describe('3G — RateLimiter', () => {
  it('窗口内放行至上限、超出拒、窗口滑动后恢复', () => {
    const rl = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
    expect(rl.tryAcquire(1000)).toBe(true);
    expect(rl.tryAcquire(1100)).toBe(true);
    expect(rl.tryAcquire(1200)).toBe(false); // 超 2 次/窗口
    expect(rl.tryAcquire(2300)).toBe(true); // 1000/1100 已滑出窗口
  });
});

describe('3G — sampling handler（路由 Provider + 限流 + 计费）', () => {
  it('createMessage → 路由 FakeProvider 返回文本 + 计费回调', async () => {
    const provider = new FakeProvider();
    provider.script(textTurn('SAMPLED-REPLY'));
    let usage = 0;
    const handler: SamplingHandler = createSamplingHandler({
      provider,
      model: 'fake',
      rateLimiter: new RateLimiter({ maxPerWindow: 10, windowMs: 60_000 }),
      onUsage: (i) => (usage = i.outputChars),
    });
    const res = await handler({
      method: 'sampling/createMessage',
      params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 100 },
    });
    expect(res.content.type === 'text' && res.content.text).toBe('SAMPLED-REPLY');
    expect(usage).toBe('SAMPLED-REPLY'.length);
  });

  it('maxTokens 必经硬上限钳制 + 计输入/输出（审查 H4）', async () => {
    const provider = new FakeProvider();
    provider.script(textTurn('out'));
    let info: { inputChars: number; outputChars: number } | null = null;
    const handler = createSamplingHandler({
      provider,
      model: 'fake',
      rateLimiter: new RateLimiter({ maxPerWindow: 10, windowMs: 60_000 }),
      maxOutputTokens: 50,
      onUsage: (i) => (info = i),
    });
    await handler({
      method: 'sampling/createMessage',
      params: { messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }], maxTokens: 999999 },
    });
    expect(provider.seen[0]!.maxTokens).toBe(50); // 对端超大 maxTokens 被钳到 cap
    expect(info!.inputChars).toBeGreaterThan(0); // 输入也计费
    expect(info!.outputChars).toBe('out'.length);
  });

  it('限流触发 → 抛错', async () => {
    const provider = new FakeProvider();
    provider.script(textTurn('x'));
    const rl = new RateLimiter({ maxPerWindow: 0, windowMs: 1000 });
    const handler = createSamplingHandler({ provider, model: 'fake', rateLimiter: rl });
    await expect(
      handler({ method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } }),
    ).rejects.toThrow(/限流/);
  });
});

// ───────────────────────── progress → ToolCallOutput ─────────────────────────

describe('3G — progress notifications → ToolCallOutput delta', () => {
  it('mcpExecutor 实时抽干 progress 后回最终输出', async () => {
    // 伪 client：callTool 期间多次触发 onprogress，再 resolve。
    const fakeClient = {
      callTool: async (_params: unknown, _schema: unknown, opts: { onprogress?: (p: { progress: number; total?: number; message?: string }) => void }) => {
        opts.onprogress?.({ progress: 1, total: 3 });
        opts.onprogress?.({ progress: 2, total: 3, message: '半程' });
        return { content: [{ type: 'text', text: 'final' }] };
      },
    } as unknown as Client;
    const exec = mcpExecutor(fakeClient, 'slow', undefined, undefined);
    const ctx: ToolContext = { sessionId: 's', cwd: '/tmp', flags: new Set() };
    const chunks: string[] = [];
    for await (const ev of exec.execute({}, ctx)) if (ev.kind === 'output') chunks.push(ev.chunk);
    expect(chunks).toContain('进度 1/3');
    expect(chunks).toContain('半程');
    expect(chunks[chunks.length - 1]).toBe('final'); // 进度在最终输出之前
  });
});

// ───────────────────────── resources / prompts ─────────────────────────

async function startAdvancedServer(opts: { sampling?: boolean } = {}): Promise<Transport> {
  const server = new McpServer({ name: 'adv', version: '0.0.0' });
  server.registerTool('echo', { description: 'echo', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  server.registerResource(
    'greeting',
    'mem://greeting.txt',
    { description: 'a greeting', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'HELLO-RESOURCE' }] }),
  );
  server.registerPrompt('greet', { description: 'greet someone', argsSchema: { name: z.string() } }, ({ name }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Hi ${name}` } }],
  }));
  if (opts.sampling) {
    server.registerTool('ask', { description: 'ask model via sampling', inputSchema: {} }, async () => {
      const r = await server.server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'q' } }], maxTokens: 50 });
      return { content: [{ type: 'text', text: `sampled:${r.content.type === 'text' ? r.content.text : ''}` }] };
    });
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  return clientT;
}

const advSpec = (): ResolvedMcpServer => ({ name: 'adv', source: 'user', command: '', args: [], env: {} });

describe('3G — MCP resources / prompts', () => {
  it('listResources/readResource + listPrompts/getPrompt + slash 命名', async () => {
    const registry = new InMemoryToolRegistry();
    const clientT = await startAdvancedServer();
    const host = new McpHostManager({ registry, transportFor: () => clientT });
    await host.addServer(advSpec());

    const resources = await host.listResources('adv');
    expect(resources.resources.some((r) => r.uri === 'mem://greeting.txt')).toBe(true);
    const read = await host.readResource('adv', 'mem://greeting.txt');
    expect(read.contents[0] && 'text' in read.contents[0] && read.contents[0].text).toBe('HELLO-RESOURCE');

    const prompts = await host.listPrompts('adv');
    expect(prompts.prompts.some((p) => p.name === 'greet')).toBe(true);
    const got = await host.getPrompt('adv', 'greet', { name: 'Yo' });
    const msg = got.messages[0];
    expect(msg && msg.content.type === 'text' && msg.content.text).toBe('Hi Yo');

    expect(host.promptSlashName('adv', 'greet')).toBe('/mcp__adv__greet');
    await host.closeAll();
  });
});

describe('3G — sampling 端到端（server 反向 createMessage → host Provider）', () => {
  it('工具内 createMessage 经 host samplingHandler 路由到 Provider', async () => {
    const registry = new InMemoryToolRegistry();
    const clientT = await startAdvancedServer({ sampling: true });
    const provider = new FakeProvider();
    provider.script(textTurn('FROM-PROVIDER'));
    const host = new McpHostManager({
      registry,
      transportFor: () => clientT,
      samplingHandler: createSamplingHandler({ provider, model: 'fake', rateLimiter: new RateLimiter({ maxPerWindow: 10, windowMs: 60_000 }) }),
    });
    await host.addServer(advSpec());
    const ctx: ToolContext = { sessionId: 's', cwd: '/tmp', flags: new Set(host.flags()) };
    const ask = registry.resolveAvailable(ctx).find((d) => d.name === 'mcp__adv__ask');
    expect(ask).toBeDefined();
    const exec = registry.executor('mcp__adv__ask');
    const chunks: string[] = [];
    for await (const ev of exec!.execute({}, ctx)) if (ev.kind === 'output') chunks.push(ev.chunk);
    expect(chunks.join('')).toContain('sampled:FROM-PROVIDER');
    await host.closeAll();
  });
});
