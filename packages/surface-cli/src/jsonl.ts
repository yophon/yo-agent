/**
 * headless JSONL 渲染（DESIGN §6.1 / §7.2）：stdout 每行一个 EventEnvelope（LF 分隔），
 * 对标 pi `--mode rpc` / `codex exec --json`。给脚本 / bridge 消费结构化事件流。
 */
import type { EventEnvelope } from '@yo-agent/protocol';

export function jsonlLine(env: EventEnvelope): string {
  return JSON.stringify(env);
}

export class JsonlRenderer {
  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}
  render(env: EventEnvelope): void {
    this.out.write(jsonlLine(env) + '\n');
  }
}
