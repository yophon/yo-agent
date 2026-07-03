import { describe, it, expect } from 'vitest';
import { jsonlLine, JsonlRenderer } from '@yo-agent/surface-cli';
import type { EventEnvelope } from '@yo-agent/protocol';

const env: EventEnvelope = {
  sessionId: 's1',
  cursor: 3,
  parentId: null,
  turnId: 't1',
  ts: 123,
  event: { kind: 'AssistantText', delta: '你好' },
};

describe('jsonlLine / JsonlRenderer', () => {
  it('每行一个完整 EventEnvelope JSON，可被 JSON.parse 还原', () => {
    const line = jsonlLine(env);
    expect(JSON.parse(line)).toEqual(env);
    expect(line).not.toContain('\n');
  });

  it('JsonlRenderer 写出 LF 分隔行', () => {
    const lines: string[] = [];
    const out = { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WritableStream;
    const r = new JsonlRenderer(out);
    r.render(env);
    expect(lines).toEqual([`${jsonlLine(env)}\n`]);
  });
});
