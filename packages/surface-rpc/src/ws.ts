/**
 * WebSocket 传输（DESIGN §6.1 / §6.2）：把 RpcSurface 暴露到网络（隧道内/外）。
 * 连接先过设备鉴权握手（ed25519 + 配对码 + nonce 挑战，@yo-agent/auth），再交给 RpcSurface 跑 JSON-RPC。
 * 写错误 / close 触发 onClose 断连清算，不让常驻进程崩。
 */
import { WebSocket, WebSocketServer } from 'ws';
import type { DeviceIdentity, PairingGate } from '@yo-agent/auth';
import { clientHandshake, serverHandshake } from '@yo-agent/auth';
import type { MessageChannel } from './transport';

export class WebSocketChannel implements MessageChannel {
  private msgHandler: ((m: unknown) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // 跳过坏帧
      }
      this.msgHandler?.(parsed);
    });
    ws.on('close', () => this.markClosed());
    ws.on('error', () => this.markClosed());
  }

  send(msg: unknown): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      this.markClosed();
    }
  }
  onMessage(handler: (msg: unknown) => void): void {
    this.msgHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const h = this.closeHandler;
    this.closeHandler = null;
    h?.();
  }
}

export interface ServeWebSocketOpts {
  port: number;
  host?: string;
  gate: PairingGate;
  /** 鉴权通过后回调（调用方据此 `new RpcSurface(channel).start(kernel)`）。 */
  onSession: (channel: MessageChannel, pubKey: string) => void | Promise<void>;
  /** 鉴权失败回调（日志）。 */
  onAuthError?: (err: unknown) => void;
}

export interface WebSocketServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** 起 WS server：每个连接先过 serverHandshake 鉴权，通过才 onSession。 */
export function serveWebSocket(opts: ServeWebSocketOpts): Promise<WebSocketServerHandle> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: opts.port, host: opts.host });
    wss.on('error', reject);
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      });
    });
    wss.on('connection', (ws) => {
      const channel = new WebSocketChannel(ws);
      serverHandshake(channel, opts.gate)
        .then(({ pubKey }) => opts.onSession(channel, pubKey))
        .catch((e) => {
          opts.onAuthError?.(e);
          channel.close();
        });
    });
  });
}

export interface ConnectWebSocketOpts {
  pairingCode?: string;
}

/** 客户端连接 + 鉴权握手，返回已鉴权信道（调用方据此 `new JsonRpcPeer(channel)`）。 */
export function connectWebSocket(
  url: string,
  identity: DeviceIdentity,
  opts: ConnectWebSocketOpts = {},
): Promise<MessageChannel> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('error', reject);
    ws.on('open', () => {
      const channel = new WebSocketChannel(ws);
      clientHandshake(channel, identity, opts).then(() => resolve(channel)).catch(reject);
    });
  });
}
