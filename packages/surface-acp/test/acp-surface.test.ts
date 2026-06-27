import { describe, it, expect } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool, ToolApproval } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { ClientSideConnection } from '@zed-industries/agent-client-protocol';
import type { Client, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@zed-industries/agent-client-protocol';
import { AcpSurface, inMemoryStreamPair } from '@yo-agent/surface-acp';

function echoTool(approval: ToolApproval, calls: unknown[]): RegisteredTool {
  return {
    descriptor: { name: 'echo', kind: 'execute', description: 'echo', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval },
    executor: { async *execute(input) { calls.push(input); yield { kind: 'output', chunk: `echoed:${JSON.stringify(input)}` }; } },
  };
}

type PermResponder = (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

async function harness(opts: { tool?: RegisteredTool; perm?: PermResponder } = {}) {
  const calls: unknown[] = [];
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  if (opts.tool) tools.register(opts.tool);
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: 'fake-model',
    cwd: '/work',
    interactiveApproval: true,
  });
  const pair = inMemoryStreamPair();
  const surface = new AcpSurface(pair.agent);
  await surface.start(kernel);

  const updates: SessionNotification['update'][] = [];
  const writes: Array<{ path: string; content: string }> = [];
  let permReceived: (() => void) | null = null;
  const permReceivedP = new Promise<void>((r) => (permReceived = r));

  const clientImpl: Client = {
    async sessionUpdate(n) {
      updates.push(n.update);
    },
    async requestPermission(req) {
      permReceived?.();
      if (opts.perm) return opts.perm(req);
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    },
    async writeTextFile(req) {
      writes.push({ path: req.path, content: req.content });
      return {};
    },
    async readTextFile() {
      return { content: 'FILE-CONTENT' };
    },
  };
  const conn = new ClientSideConnection(() => clientImpl, pair.client);

  return { kernel, provider, calls, conn, surface, updates, writes, permReceivedP };
}

const userText = (text: string) => ({ sessionId: '', prompt: [{ type: 'text' as const, text }] });

describe('AcpSurface（ACP client 离线对驱，退出标准②）', () => {
  it('initialize：协商协议版本 + 声明 loadSession 能力', async () => {
    const h = await harness();
    const res = await h.conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities?.loadSession).toBe(true);
  });

  it('newSession → 文本 prompt：agent_message_chunk 流回 + stopReason end_turn', async () => {
    const h = await harness();
    h.provider.script(textTurn('你好世界'));
    await h.conn.initialize({ protocolVersion: 1 });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    const res = await h.conn.prompt({ ...userText('hi'), sessionId });
    expect(res.stopReason).toBe('end_turn');
    const chunks = h.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk');
    const text = chunks.map((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? u.content.text : '')).join('');
    expect(text).toBe('你好世界');
  });

  it('工具 turn + 反向 requestPermission(allow)：阻塞请求 → 工具执行 → tool_call/_update', async () => {
    const calls: unknown[] = [];
    const h = await harness({ tool: echoTool('always', calls) });
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 1 }));
    h.provider.script(textTurn('done'));
    await h.conn.initialize({ protocolVersion: 1 });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    const res = await h.conn.prompt({ ...userText('go'), sessionId });
    expect(res.stopReason).toBe('end_turn');
    expect(calls).toEqual([{ m: 1 }]); // 审批通过 → 工具执行
    expect(h.updates.some((u) => u.sessionUpdate === 'tool_call')).toBe(true);
    expect(h.updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed')).toBe(true);
  });

  it('反向 requestPermission(reject)：工具不执行', async () => {
    const calls: unknown[] = [];
    const h = await harness({
      tool: echoTool('always', calls),
      perm: async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }),
    });
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 2 }));
    h.provider.script(textTurn('done'));
    await h.conn.initialize({ protocolVersion: 1 });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    await h.conn.prompt({ ...userText('go'), sessionId });
    expect(calls).toEqual([]);
  });

  it('session/cancel → interrupt → stopReason cancelled（挂起等审批时取消不死锁）', async () => {
    const calls: unknown[] = [];
    const h = await harness({
      tool: echoTool('always', calls),
      perm: () => new Promise<RequestPermissionResponse>(() => {}), // 永不应答 → 由 cancel 经 interrupt 解除
    });
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 3 }));
    await h.conn.initialize({ protocolVersion: 1 });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    const promptP = h.conn.prompt({ ...userText('go'), sessionId });
    await h.permReceivedP; // 等审批反向请求已发出
    await h.conn.cancel({ sessionId });
    const res = await promptP;
    expect(res.stopReason).toBe('cancelled');
    expect(calls).toEqual([]);
  });

  it('同 session 重叠 prompt → 第二个被拒，不覆盖第一个（审查 H2）', async () => {
    const calls: unknown[] = [];
    const h = await harness({ tool: echoTool('always', calls), perm: () => new Promise<RequestPermissionResponse>(() => {}) });
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 1 }));
    await h.conn.initialize({ protocolVersion: 1 });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    const p1 = h.conn.prompt({ ...userText('go'), sessionId }); // 挂起等审批
    await h.permReceivedP;
    await expect(h.conn.prompt({ ...userText('go2'), sessionId })).rejects.toThrow(); // 第二个被拒
    await h.conn.cancel({ sessionId });
    const r1 = await p1;
    expect(r1.stopReason).toBe('cancelled'); // 第一个仍正常以 cancelled 收口（未被覆盖丢失）
  });

  it('requestPermission.toolCall.toolCallId = 工具调用 id（审查 M4 关联）', async () => {
    const calls: unknown[] = [];
    let capturedId: string | null = null;
    const h = await harness({
      tool: echoTool('always', calls),
      perm: async (req) => {
        capturedId = req.toolCall.toolCallId;
        return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
      },
    });
    h.provider.script(toolCallTurn('echo', 'tu1', { m: 1 }));
    h.provider.script(textTurn('done'));
    await h.conn.initialize({ protocolVersion: 1 });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    await h.conn.prompt({ ...userText('go'), sessionId });
    expect(capturedId).toBe('tu1'); // = ToolCallStarted.id，非随机 requestId
  });

  it('fs/write_text_file 反向能力：正常路径写入；越界/保护路径被拦', async () => {
    const h = await harness();
    await h.conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { writeTextFile: true } } });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    // 正常路径：经 client 写入。
    await h.surface.writeTextFile(sessionId, '/work/src/a.ts', 'hello');
    expect(h.writes).toEqual([{ path: '/work/src/a.ts', content: 'hello' }]);
    // 越界路径：拒（不下发 client）。
    await expect(h.surface.writeTextFile(sessionId, '/etc/passwd', 'x')).rejects.toThrow();
    // 保护路径：拒。
    await expect(h.surface.writeTextFile(sessionId, '/work/.env', 'x')).rejects.toThrow();
    expect(h.writes).toHaveLength(1); // 仅正常路径那一次
  });

  it('fs/read_text_file 反向能力：正常路径读回；越界被拦', async () => {
    const h = await harness();
    await h.conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    expect(await h.surface.readTextFile(sessionId, '/work/a.ts')).toBe('FILE-CONTENT');
    await expect(h.surface.readTextFile(sessionId, '/work/../secret')).rejects.toThrow();
  });

  it('session/load：重放历史为 session/update', async () => {
    const h = await harness();
    h.provider.script(textTurn('历史回复'));
    await h.conn.initialize({ protocolVersion: 1 });
    const { sessionId } = await h.conn.newSession({ cwd: '/work', mcpServers: [] });
    await h.conn.prompt({ ...userText('hi'), sessionId });
    const before = h.updates.length;
    await h.conn.loadSession({ sessionId, cwd: '/work', mcpServers: [] });
    expect(h.updates.length).toBeGreaterThan(before); // 历史被重放为 update
  });
});
