import { describe, it, expect } from 'vitest';
import type { Kernel } from '@yo-agent/kernel';
import type { AgentEvent, EventEnvelope, Id } from '@yo-agent/protocol';
import { InMemoryChannelPair, JsonRpcPeer, RpcSurface } from '@yo-agent/surface-rpc';

function env(cursor: number, event: AgentEvent): EventEnvelope {
  return { sessionId: 's', cursor, parentId: null, turnId: null, ts: cursor, event };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * 回归（审查 critical）：session/reconnect 溢出分支——异步读 EventLog 的 await 间隙里并发 turn 推来实时事件，
 * 不得让低 cursor 的 gap 摘要被去重静默吞掉。
 */
describe('RpcSurface reconnect 排序', () => {
  it('gap 溢出读期间并发实时事件 → 缺口摘要不被丢弃', async () => {
    const gate = deferred();
    let handler: ((e: EventEnvelope) => void) | null = null;
    const fake = {
      events: {
        async *read() {
          yield env(1, { kind: 'TurnStarted', turnId: 't', promptIdemKey: 'k' });
          await gate.promise; // 模拟读的 await 间隙；测试在此注入并发实时事件
          yield env(2, { kind: 'ApprovalRequested', requestId: 'r', tool: 'x', input: {}, risk: 'unknown', suggestions: [] });
        },
      },
      resumeSession: async () => true,
      bufferedSince: () => null, // 强制走 gap 溢出分支
      isApprovalPending: () => false,
      subscribe(_s: Id, _c: number | null, h: (e: EventEnvelope) => void) {
        handler = h;
        return () => { handler = null; };
      },
    } as unknown as Kernel;

    const pair = new InMemoryChannelPair();
    const surface = new RpcSurface(pair.a);
    await surface.start(fake);
    const client = new JsonRpcPeer(pair.b);
    const got: number[] = [];
    client.onNotify('event', (p) => got.push((p as EventEnvelope).cursor));

    const rec = client.request('session/reconnect', { sessionId: 's', fromCursor: 0 });
    await new Promise((r) => setTimeout(r, 20)); // 让 read 启动并停在 gate
    if (handler) (handler as (e: EventEnvelope) => void)(env(5, { kind: 'AssistantText', delta: 'live' })); // 并发实时事件
    gate.resolve();
    await rec;
    await new Promise((r) => setTimeout(r, 20));

    expect(got).toEqual([1, 2, 5]); // 缺口摘要 1、2 未被实时事件 5 的去重遮蔽
  });

  it('信道关闭 → pending 请求被 reject（不永久挂起 + 不泄漏）', async () => {
    const pair = new InMemoryChannelPair();
    // 服务端 peer 无对应 handler，请求永不应答
    new JsonRpcPeer(pair.a);
    const client = new JsonRpcPeer(pair.b);
    const p = client.request('never/answered');
    pair.a.close(); // 任一端 close → 两端 onClose → client.close() reject pending
    await expect(p).rejects.toThrow(/channel closed/);
    // 关闭后再发请求立即 reject
    await expect(client.request('x')).rejects.toThrow(/channel closed/);
  });
});
