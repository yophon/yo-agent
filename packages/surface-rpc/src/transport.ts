/**
 * 传输抽象（DESIGN §6.1）：MessageChannel 管一条双向 JSON 消息流，不碰 JSON-RPC 语义。
 * - InMemoryChannelPair：测试用，两端互联（JSON round-trip 模拟真实序列化）。
 * - JsonlStreamChannel：stdio / socket 用，LF 分隔 JSONL（对标 codex exec --json / pi --mode rpc）。
 *
 * 断连语义：onClose 通知上层（JsonRpcPeer）以清算 pending；写错误（EPIPE）吞掉并触发 onClose，
 * 不让常驻进程因管道断开崩溃。
 */
import type { Readable, Writable } from 'node:stream';

export interface MessageChannel {
  send(msg: unknown): void;
  onMessage(handler: (msg: unknown) => void): void;
  /** 信道断开时回调（一次性）；上层据此 reject 所有 pending 请求。 */
  onClose(handler: () => void): void;
  close(): void;
}

/** 两端互联的内存信道对（a↔b），异步投递 + JSON round-trip。任一端 close → 两端 onClose。 */
export class InMemoryChannelPair {
  readonly a: MessageChannel;
  readonly b: MessageChannel;

  constructor() {
    let aMsg: ((m: unknown) => void) | null = null;
    let bMsg: ((m: unknown) => void) | null = null;
    let aClose: (() => void) | null = null;
    let bClose: (() => void) | null = null;
    let closed = false;
    const deliver = (to: () => ((m: unknown) => void) | null, msg: unknown) => {
      if (closed) return;
      const s = JSON.stringify(msg); // 模拟真实序列化（捕获不可序列化 / 丢 undefined）
      queueMicrotask(() => {
        if (!closed) to()?.(JSON.parse(s));
      });
    };
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        aClose?.();
        bClose?.();
      });
    };
    this.a = {
      send: (m) => deliver(() => bMsg, m),
      onMessage: (h) => { aMsg = h; },
      onClose: (h) => { aClose = h; },
      close: closeBoth,
    };
    this.b = {
      send: (m) => deliver(() => aMsg, m),
      onMessage: (h) => { bMsg = h; },
      onClose: (h) => { bClose = h; },
      close: closeBoth,
    };
  }
}

/** LF 分隔 JSONL 信道（stdin/stdout 或 socket）。 */
export class JsonlStreamChannel implements MessageChannel {
  private buf = '';
  private handler: ((m: unknown) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;

  constructor(private readonly input: Readable, private readonly output: Writable) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // 跳过坏行
        }
        this.handler?.(parsed);
      }
    });
    // 对端退出 / socket 断开 → 触发断连清算，不让 pending 永久挂起。
    input.on('end', () => this.markClosed());
    input.on('error', () => this.markClosed());
    input.on('close', () => this.markClosed());
    // 写端错误（EPIPE 等）：吞掉并标记断开，避免未捕获 'error' 崩溃常驻进程。
    output.on('error', () => this.markClosed());
  }

  send(msg: unknown): void {
    if (this.closed) return; // 断开后写入 no-op（避免 EPIPE）
    try {
      this.output.write(JSON.stringify(msg) + '\n'); // 返回 false（背压）暂不阻塞：弱模型/慢消费端非热点路径
    } catch {
      this.markClosed();
    }
  }
  onMessage(handler: (msg: unknown) => void): void {
    this.handler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  close(): void {
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
