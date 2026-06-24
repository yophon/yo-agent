/**
 * 传输抽象（DESIGN §6.1）：MessageChannel 管一条双向 JSON 消息流，不碰 JSON-RPC 语义。
 * - InMemoryChannelPair：测试用，两端互联（JSON round-trip 模拟真实序列化）。
 * - JsonlStreamChannel：stdio / socket 用，LF 分隔 JSONL（对标 codex exec --json / pi --mode rpc）。
 */
import type { Readable, Writable } from 'node:stream';

export interface MessageChannel {
  send(msg: unknown): void;
  onMessage(handler: (msg: unknown) => void): void;
  close(): void;
}

/** 两端互联的内存信道对（a↔b），异步投递 + JSON round-trip。 */
export class InMemoryChannelPair {
  readonly a: MessageChannel;
  readonly b: MessageChannel;

  constructor() {
    let aHandler: ((m: unknown) => void) | null = null;
    let bHandler: ((m: unknown) => void) | null = null;
    let closed = false;
    const deliver = (to: () => ((m: unknown) => void) | null, msg: unknown) => {
      if (closed) return;
      const s = JSON.stringify(msg); // 模拟真实序列化（捕获不可序列化 / 丢 undefined）
      queueMicrotask(() => {
        if (!closed) to()?.(JSON.parse(s));
      });
    };
    this.a = {
      send: (m) => deliver(() => bHandler, m),
      onMessage: (h) => { aHandler = h; },
      close: () => { closed = true; },
    };
    this.b = {
      send: (m) => deliver(() => aHandler, m),
      onMessage: (h) => { bHandler = h; },
      close: () => { closed = true; },
    };
  }
}

/** LF 分隔 JSONL 信道（stdin/stdout 或 socket）。 */
export class JsonlStreamChannel implements MessageChannel {
  private buf = '';
  private handler: ((m: unknown) => void) | null = null;

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
  }

  send(msg: unknown): void {
    this.output.write(JSON.stringify(msg) + '\n');
  }
  onMessage(handler: (msg: unknown) => void): void {
    this.handler = handler;
  }
  close(): void {
    this.handler = null;
  }
}
