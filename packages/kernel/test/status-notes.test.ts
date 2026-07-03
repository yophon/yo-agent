import { describe, expect, it } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import type { McpServerStatusInfo } from '@yo-agent/protocol';
import { FakeProvider, textTurn } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import type { RegisteredTool } from '@yo-agent/tools';

function flaggedTool(name: string, flag: string): RegisteredTool {
  return {
    descriptor: {
      name,
      kind: 'read',
      description: name,
      inputSchema: { type: 'object' },
      owner: 'mcp',
      availability: { configFlag: flag },
      approval: 'never',
    },
    executor: {
      async *execute() {
        yield { kind: 'output', chunk: 'ok' };
      },
    },
  };
}

function harness(opts: { usableContextTokens?: number } = {}) {
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  const flags = new Set<string>(['mcp:fs']);
  const mcpStatus: McpServerStatusInfo[] = [{ server: 'fs', status: 'connected', toolCount: 1, epoch: 1 }];
  tools.register(flaggedTool('mcp__fs__read', 'mcp:fs'));
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    toolFlags: () => flags,
    mcpStatusSource: () => mcpStatus.map((x) => ({ ...x })),
    ...(opts.usableContextTokens ? { usableContextTokens: opts.usableContextTokens } : {}),
  });
  return { kernel, provider, flags, mcpStatus };
}

/** 最后一次送 provider 的消息窗口 JSON（状态提醒断言目标）。 */
function lastWindow(provider: FakeProvider): string {
  return JSON.stringify(provider.seen[provider.seen.length - 1]!.messages);
}

describe('4.9d — 动态状态注入（turn 起点接缝）', () => {
  it('MCP 熔断 → 下一 turn 注入 toolset 消失 + server 状态变化提醒', async () => {
    const { kernel, provider, flags, mcpStatus } = harness();
    provider.script(textTurn('t1'));
    provider.script(textTurn('t2'));
    const sid = await kernel.startSession();
    await kernel.submitInput(sid, 'go1', 'k1');
    expect(lastWindow(provider)).not.toContain('[系统状态]'); // 首 turn 无基准、无变化

    flags.delete('mcp:fs'); // 熔断：健康标志撤下 + 状态转 failed
    mcpStatus[0] = { server: 'fs', status: 'failed', toolCount: 1, epoch: 1 };
    await kernel.submitInput(sid, 'go2', 'k2');
    const w = lastWindow(provider);
    expect(w).toContain('消失：mcp__fs__read');
    expect(w).toContain('MCP server「fs」→ failed');
    expect(w).toContain('熔断冷却中');
  });

  it('注入去重：同状态跨 turn 不重复（diff 基准滚动 + McpStatus 仅变化时）', async () => {
    const { kernel, provider, flags, mcpStatus } = harness();
    for (let i = 0; i < 4; i++) provider.script(textTurn(`t${i}`));
    const sid = await kernel.startSession();
    await kernel.submitInput(sid, 'go1', 'k1');
    flags.delete('mcp:fs');
    mcpStatus[0] = { server: 'fs', status: 'failed', toolCount: 1, epoch: 1 };
    await kernel.submitInput(sid, 'go2', 'k2');
    await kernel.submitInput(sid, 'go3', 'k3'); // 状态未再变化
    const w = lastWindow(provider); // 累积窗口：提醒只出现一次
    expect(w.split('消失：mcp__fs__read').length - 1).toBe(1);
    expect(w.split('MCP server「fs」→ failed').length - 1).toBe(1);
  });

  it('恢复（半开成功）→ 注入新增工具 + connected 变化', async () => {
    const { kernel, provider, flags, mcpStatus } = harness();
    for (let i = 0; i < 3; i++) provider.script(textTurn(`t${i}`));
    const sid = await kernel.startSession();
    await kernel.submitInput(sid, 'go1', 'k1');
    flags.delete('mcp:fs');
    mcpStatus[0] = { server: 'fs', status: 'failed', toolCount: 1, epoch: 1 };
    await kernel.submitInput(sid, 'go2', 'k2');
    flags.add('mcp:fs');
    mcpStatus[0] = { server: 'fs', status: 'connected', toolCount: 1, epoch: 1 };
    await kernel.submitInput(sid, 'go3', 'k3');
    const w = lastWindow(provider);
    expect(w).toContain('新增：mcp__fs__read');
    expect(w).toContain('MCP server「fs」→ connected');
  });

  it('permissionMode 中途切档 → 下一 turn LLM 可见（带过期声明）', async () => {
    const { kernel, provider } = harness();
    provider.script(textTurn('t1'));
    provider.script(textTurn('t2'));
    const sid = await kernel.startSession({ permissionMode: 'supervised' });
    await kernel.submitInput(sid, 'go1', 'k1');
    kernel.setPermissionMode(sid, 'read-only');
    kernel.setPermissionMode(sid, 'read-only'); // 同值重复设置 → 不再排提醒
    await kernel.submitInput(sid, 'go2', 'k2');
    const w = lastWindow(provider);
    expect(w.split('权限模式已切换：supervised → read-only').length - 1).toBe(1);
  });

  it('上下文满度跨 70% → 注入一次「已用 X%」，持续高位不重复', async () => {
    const { kernel, provider } = harness({ usableContextTokens: 60 }); // 极小窗口，首 turn 即跨阈
    provider.script(textTurn('t1'));
    provider.script(textTurn('t2'));
    const sid = await kernel.startSession();
    await kernel.submitInput(sid, 'x'.repeat(200), 'k1'); // ≈50 token > 70%*60
    expect(lastWindow(provider)).toContain('上下文已用');
    await kernel.submitInput(sid, 'y', 'k2'); // 仍高位 → 不重报
    const w = lastWindow(provider);
    expect(w.split('上下文已用').length - 1).toBe(1);
  });
});
