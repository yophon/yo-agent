/**
 * 内存 ACP Stream 对（3F 测试对驱）：用恒等 TransformStream 把 AgentSideConnection ↔ ClientSideConnection
 * 在内存互联（Stream 是对象级 AnyMessage 流，无需字节编码），离线 CI 跑通退出标准②。
 */
import type { AnyMessage, Stream } from '@zed-industries/agent-client-protocol';

export function inMemoryStreamPair(): { agent: Stream; client: Stream } {
  const a2b = new TransformStream<AnyMessage, AnyMessage>();
  const b2a = new TransformStream<AnyMessage, AnyMessage>();
  return {
    agent: { writable: a2b.writable, readable: b2a.readable },
    client: { writable: b2a.writable, readable: a2b.readable },
  };
}
