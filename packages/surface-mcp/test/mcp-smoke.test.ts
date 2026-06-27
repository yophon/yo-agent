import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import type { ApprovalGate } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { McpHostManager, createStdioClientTransport } from '@yo-agent/surface-mcp';
import type { ResolvedMcpServer } from '@yo-agent/surface-mcp';
import type { EventEnvelope } from '@yo-agent/protocol';

/**
 * 退出标准① 真机冒烟（DESIGN §13 / PHASE-3 §3C）—— **唯一一次真实子进程/网络冒烟**。
 * 起真实 npm `@modelcontextprotocol/server-filesystem`（stdio 子进程），host 连它、发现真实工具、
 * kernel 跑一轮 turn 调用其 `read_file` 读回文件内容。默认跳过（离线 CI 不依赖 npx 下载）：
 *   `YO_MCP_SMOKE=1 npx vitest run packages/surface-mcp/test/mcp-smoke.test.ts`
 * （首次需联网拉取 server；本机已缓存于 ~/.npm/_npx 后可离线复跑。）
 */
const RUN = process.env.YO_MCP_SMOKE === '1';

describe.skipIf(!RUN)('退出标准① 真机冒烟：真实 server-filesystem (stdio)', () => {
  it('host 连真实 server → kernel turn 调 read_file 读回文件内容', async () => {
    // realpath 解析 macOS /var → /private/var 符号链接：server 按 realpath 校验 allowed dir，
    // 否则 /var/... 路径会被判「outside allowed directories」（真机踩坑记录）。
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'yo-mcp-smoke-')));
    const file = join(dir, 'hello.txt');
    const content = 'yo-agent 3C 真机冒烟：read_file OK ✅';
    await writeFile(file, content);

    const registry = new InMemoryToolRegistry();
    const host = new McpHostManager({
      registry,
      transportFor: createStdioClientTransport,
      log: (m) => console.error(m),
    });
    const spec: ResolvedMcpServer = {
      name: 'filesystem',
      source: 'user',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', dir],
      env: {},
    };
    try {
      await host.start([spec]); // 真实 spawn + tools/list 发现 + 经 3A 护栏注册
      const names = registry
        .resolveAvailable({ sessionId: 's', cwd: dir, flags: new Set(host.flags()) })
        .map((d) => d.name);
      expect(names).toContain('mcp__filesystem__read_file'); // 真实远端工具经命名隔离注册

      const provider = new FakeProvider();
      const gate: ApprovalGate = { async request() { return { decision: 'allow_once' }; } };
      const kernel = new AgentKernel({
        store: new MemoryEventStore(),
        provider,
        tools: registry,
        loopBreaker: new HistoryLoopBreaker(),
        condenser: new NoopCondenser(),
        approvalGate: gate,
        toolFlags: () => host.flags(),
        mcpStatusSource: () => host.statusSnapshot(),
        model: 'fake-model',
        cwd: dir,
      });
      provider.script(toolCallTurn('mcp__filesystem__read_file', 'c1', { path: file }));
      provider.script(textTurn('done'));

      const out: string[] = [];
      const sid = await kernel.startSession({ model: 'fake-model', cwd: dir });
      kernel.subscribe(sid, null, (env: EventEnvelope) => {
        if (env.event.kind === 'ToolCallOutput') out.push(env.event.chunk);
      });
      await kernel.submitInput(sid, '请读取 hello.txt', 't1');

      expect(out.join('')).toContain(content); // LLM 经真实 callTool 拿到真实文件内容 → 退出标准① 达成
    } finally {
      await host.closeAll(); // 杀子进程
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
