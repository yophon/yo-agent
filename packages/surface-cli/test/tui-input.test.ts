import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentHistory, expandPastes, foldPaste, newPasteStore } from '@yo-agent/surface-cli';

describe('foldPaste/expandPastes:大段折叠', () => {
  it('>10 行折叠为占位符,提交时展开;短粘贴原样', () => {
    const store = newPasteStore();
    const big = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
    const token = foldPaste(store, big);
    expect(token).toBe('[粘贴 #1 · 12 行]');
    expect(foldPaste(store, 'short')).toBe('short');
    expect(expandPastes(store, `前缀 ${token} 后缀`)).toBe(`前缀 ${big} 后缀`);
  });
});

describe('PersistentHistory:JSONL 持久历史', () => {
  it('push 追加落盘;load 跨实例召回;连续重复跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yo-hist-'));
    const file = join(dir, 'history.jsonl');
    const h1 = PersistentHistory.load(file, '/proj');
    h1.push('第一条');
    h1.push('第一条'); // 连续重复
    h1.push('第二条');
    expect(h1.list()).toEqual(['第一条', '第二条']);
    const h2 = PersistentHistory.load(file, '/proj');
    expect(h2.list()).toEqual(['第一条', '第二条']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('同 cwd 条目排在队尾(↑ 优先召回);脏行跳过;file=null 纯内存', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yo-hist-'));
    const file = join(dir, 'history.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ ts: 1, cwd: '/a', text: 'from-a' }),
        'not-json',
        JSON.stringify({ ts: 2, cwd: '/b', text: 'from-b' }),
        JSON.stringify({ ts: 3, cwd: '/a', text: 'from-a-2' }),
      ].join('\n') + '\n',
    );
    const h = PersistentHistory.load(file, '/a');
    expect(h.list()).toEqual(['from-b', 'from-a', 'from-a-2']);
    const mem = PersistentHistory.load(null, '/a');
    mem.push('仅内存');
    expect(mem.list()).toEqual(['仅内存']);
  });
});
