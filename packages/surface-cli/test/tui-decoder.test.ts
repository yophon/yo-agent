import { describe, it, expect } from 'vitest';
import { InputDecoder, type InputEvent } from '@yo-agent/surface-cli';

const key = (ev: InputEvent): { ch: string } => {
  if (ev.kind !== 'key') throw new Error('not a key event');
  return { ch: ev.ch };
};

describe('InputDecoder:括号粘贴(4.6b 行为等价)', () => {
  it('单 chunk 完整粘贴(ink 剥首 ESC 形态):一次产出全文', () => {
    const d = new InputDecoder();
    expect(d.feed('[200~hello\nworld\x1b[201~')).toEqual([{ kind: 'paste', text: 'hello\nworld' }]);
    expect(d.pasting).toBe(false);
  });

  it('多 chunk:开始 → 累积(回车/Tab 还原字面量)→ 结束', () => {
    const d = new InputDecoder();
    expect(d.feed('[200~line1')).toEqual([]);
    expect(d.pasting).toBe(true);
    expect(d.feed('', { return: true })).toEqual([]); // 粘贴内回车不提交
    expect(d.feed('', { tab: true })).toEqual([]);
    expect(d.feed('line2')).toEqual([]);
    expect(d.feed('[201~')).toEqual([{ kind: 'paste', text: 'line1\r\tline2' }]); // 结束标记单独成 chunk 被剥 ESC
    expect(d.pasting).toBe(false);
  });

  it('含原始 ESC 的开始标记也识别;混在内容里的结束标记保留 ESC 形态', () => {
    const d = new InputDecoder();
    expect(d.feed('\x1b[200~x\x1b[201~')).toEqual([{ kind: 'paste', text: 'x' }]);
  });

  it('普通输入透传 key 事件(不消费)', () => {
    const d = new InputDecoder();
    expect(d.feed('h', {})).toEqual([{ kind: 'key', ch: 'h', key: {} }]);
    expect(d.feed('', { return: true })).toEqual([{ kind: 'key', ch: '', key: { return: true } }]);
  });

  it('4.7b 修正:开始标记前的前缀不丢', () => {
    const d = new InputDecoder();
    const evs = d.feed('ab[200~pasted\x1b[201~');
    expect(evs).toEqual([
      { kind: 'key', ch: 'ab', key: {} },
      { kind: 'paste', text: 'pasted' },
    ]);
  });

  it('4.7b 修正:结束标记后的余量继续解码(可含下一个粘贴)', () => {
    const d = new InputDecoder();
    const evs = d.feed('[200~one\x1b[201~xy[200~two\x1b[201~');
    expect(evs).toEqual([
      { kind: 'paste', text: 'one' },
      { kind: 'key', ch: 'xy', key: {} },
      { kind: 'paste', text: 'two' },
    ]);
  });
});

describe('InputDecoder:pty 合并 chunk 切段', () => {
  it('「文本+回车」单 chunk:切段 + 段间 Enter', () => {
    const d = new InputDecoder();
    expect(d.feed('hi\r')).toEqual([{ kind: 'text', text: 'hi' }, { kind: 'enter' }]);
    expect(d.feed('a\rb\r')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'enter' },
      { kind: 'text', text: 'b' },
      { kind: 'enter' },
    ]);
  });

  it('CRLF/LF 混合归一;末段无回车保留为文本', () => {
    const d = new InputDecoder();
    expect(d.feed('a\r\nb\nc')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'enter' },
      { kind: 'text', text: 'b' },
      { kind: 'enter' },
      { kind: 'text', text: 'c' },
    ]);
  });

  it('单纯回车键(key.return)不切段,透传路由', () => {
    const d = new InputDecoder();
    expect(key(d.feed('\r', { return: true })[0]!).ch).toBe('\r');
  });

  it('多字符无换行 chunk 透传(整段插入交给 keymap)', () => {
    const d = new InputDecoder();
    expect(d.feed('abc')).toEqual([{ kind: 'key', ch: 'abc', key: {} }]);
  });
});
