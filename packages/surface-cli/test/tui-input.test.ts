import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PasteTracker,
  PersistentHistory,
  expandPastes,
  foldPaste,
  newPasteStore,
} from '@yo-agent/surface-cli';

describe('PasteTracker:括号粘贴状态机', () => {
  it('单 chunk 完整粘贴(ink 剥首 ESC 形态):一次产出全文', () => {
    const t = new PasteTracker();
    const r = t.feed('[200~hello\nworld\x1b[201~');
    expect(r).toEqual({ done: 'hello\nworld', consumed: true });
    expect(t.active).toBe(false);
  });

  it('多 chunk:开始 → 累积(回车/Tab 当字面量)→ 结束', () => {
    const t = new PasteTracker();
    expect(t.feed('[200~line1')).toEqual({ done: null, consumed: true });
    expect(t.active).toBe(true);
    expect(t.feed('', { keyReturn: true })).toEqual({ done: null, consumed: true }); // 粘贴内回车不提交
    expect(t.feed('line2')).toEqual({ done: null, consumed: true });
    const r = t.feed('[201~'); // 结束标记单独成 chunk 被剥 ESC
    expect(r.done).toBe('line1\rline2');
    expect(t.active).toBe(false);
  });

  it('非粘贴输入不消费;含原始 ESC 的开始标记也识别', () => {
    const t = new PasteTracker();
    expect(t.feed('hello')).toEqual({ done: null, consumed: false });
    expect(t.feed('\x1b[200~x\x1b[201~').done).toBe('x');
  });
});

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
