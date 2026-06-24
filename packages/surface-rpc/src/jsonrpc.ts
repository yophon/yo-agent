/**
 * 极简 JSON-RPC 2.0 peer（DESIGN §6.1，自研薄层）。
 * 关键：dispatch 对请求**不阻塞读取循环**——每个 request handler 异步跑、完成才回响应，
 * 故 turn/start 挂起等审批时，approval/decide 仍能被并发处理（否则会死锁）。
 */
import type { MessageChannel } from './transport';

export type RpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (params: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<RpcId, Pending>();

  private closed = false;

  constructor(private readonly channel: MessageChannel) {
    channel.onMessage((msg) => this.dispatch(msg));
    channel.onClose(() => this.close());
  }

  /** 信道断开：reject 所有 pending 请求（否则调用方永久挂起 + Map 泄漏）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error('channel closed'));
    this.pending.clear();
  }

  /** 注册请求处理器（返回值作为 result 回送）。 */
  on(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }
  /** 注册 notification 处理器（无响应）。 */
  onNotify(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  notify(method: string, params?: unknown): void {
    this.channel.send({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('channel closed'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (typeof m.method === 'string') {
      if (m.id !== undefined && m.id !== null) {
        void this.handleRequest(m as unknown as JsonRpcRequest); // 不 await：并发处理
      } else {
        const h = this.notificationHandlers.get(m.method);
        if (h) {
          try {
            h(m.params);
          } catch {
            /* notification handler 抛错不影响连接 */
          }
        }
      }
      return;
    }
    // response
    if ('id' in m && (m.id === null || typeof m.id === 'number' || typeof m.id === 'string')) {
      const p = m.id != null ? this.pending.get(m.id as RpcId) : undefined;
      if (!p) return;
      this.pending.delete(m.id as RpcId);
      if ('error' in m && m.error) {
        const err = m.error as { message?: string; code?: number };
        p.reject(new Error(err.message ?? `rpc error ${err.code ?? ''}`));
      } else {
        p.resolve(m.result);
      }
    }
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const h = this.requestHandlers.get(req.method);
    if (!h) {
      this.channel.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
      return;
    }
    try {
      const result = await h(req.params);
      this.channel.send({ jsonrpc: '2.0', id: req.id, result: result ?? null });
    } catch (e) {
      // 参数校验失败（ZodError）→ -32602 Invalid params；其余 → -32000 server error。
      const isValidation = e instanceof Error && e.name === 'ZodError';
      const code = isValidation ? -32602 : -32000;
      const message = isValidation ? 'invalid params' : e instanceof Error ? e.message : String(e);
      this.channel.send({ jsonrpc: '2.0', id: req.id, error: { code, message } });
    }
  }
}
