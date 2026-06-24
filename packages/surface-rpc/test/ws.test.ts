import { describe, it, expect, afterEach } from 'vitest';
import { DeviceIdentity, PairingGate } from '@yo-agent/auth';
import {
  JsonRpcPeer,
  RpcSurface,
  connectWebSocket,
  serveWebSocket,
  type WebSocketServerHandle,
} from '@yo-agent/surface-rpc';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import { FakeProvider, textTurn } from '@yo-agent/provider';

let server: WebSocketServerHandle | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function makeKernel() {
  const provider = new FakeProvider();
  const kernel = new AgentKernel({
    store: new MemoryEventStore(),
    provider,
    tools: new InMemoryToolRegistry(),
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: 'fake-model',
    cwd: '/tmp',
  });
  return { kernel, provider };
}

describe('WebSocket 传输 + 设备鉴权（真 localhost ws）', () => {
  it('配对 → 受信连接 → JSON-RPC ping/pong + 驱动一轮', async () => {
    const { kernel, provider } = makeKernel();
    provider.script(textTurn('远端驱动'));
    const gate = new PairingGate();
    const code = gate.issueCode();

    server = await serveWebSocket({
      port: 0, // 任意空闲端口
      gate,
      onSession: (channel) => {
        void new RpcSurface(channel).start(kernel);
      },
    });

    // 客户端：首次带配对码连接
    const id = DeviceIdentity.generate();
    const channel = await connectWebSocket(`ws://127.0.0.1:${server.port}`, id, { pairingCode: code });
    expect(gate.isTrusted(id.publicKeyHex)).toBe(true); // 已注册受信

    const client = new JsonRpcPeer(channel);
    expect(await client.request('ping')).toBe('pong');
    const { sessionId } = (await client.request('session/new', { project: '/tmp', permissionMode: 'supervised', surfaceKind: 'rpc' })) as { sessionId: string };
    const events: string[] = [];
    client.onNotify('event', (p) => events.push((p as { event: { kind: string } }).event.kind));
    await client.request('turn/start', { sessionId, prompt: 'hi', idemKey: 'k1' });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain('TurnCompleted');
    channel.close();
  });

  it('未配对设备 → 握手被拒（连接不可用）', async () => {
    const { kernel } = makeKernel();
    const gate = new PairingGate(); // 无受信、无码
    server = await serveWebSocket({ port: 0, gate, onSession: (ch) => { void new RpcSurface(ch).start(kernel); } });
    const id = DeviceIdentity.generate();
    await expect(connectWebSocket(`ws://127.0.0.1:${server.port}`, id)).rejects.toThrow(/not paired|鉴权失败/);
  });

  it('已受信设备（无需配对码）重连直接通过', async () => {
    const { kernel } = makeKernel();
    const id = DeviceIdentity.generate();
    const gate = new PairingGate();
    gate.trust(id.publicKeyHex); // 预置受信（模拟已配对持久化）
    server = await serveWebSocket({ port: 0, gate, onSession: (ch) => { void new RpcSurface(ch).start(kernel); } });
    const channel = await connectWebSocket(`ws://127.0.0.1:${server.port}`, id);
    const client = new JsonRpcPeer(channel);
    expect(await client.request('ping')).toBe('pong');
    channel.close();
  });
});
