import { describe, it, expect } from 'vitest';
import { editor as ed, cellWidth, strWidth } from '@yo-agent/surface-cli';

const st = (text: string, cursor?: number) => ed.fromText(text, cursor);

describe('editor:字素簇编辑(CJK/emoji 不劈开)', () => {
  it('backspace 删整个字素:CJK / 代理对 emoji / ZWJ 家族', () => {
    expect(ed.backspace(st('中文'))).toEqual({ text: '中', cursor: 1 });
    expect(ed.backspace(st('a😀'))).toEqual({ text: 'a', cursor: 1 }); // 😀 = 2 code units
    const family = '👨‍👩‍👧'; // ZWJ 序列 8 units
    expect(ed.backspace(st('x' + family))).toEqual({ text: 'x', cursor: 1 });
  });

  it('left/right 按字素移动;不越界', () => {
    const s = st('a😀b', 4); // 末尾
    const l1 = ed.left(s);
    expect(l1.cursor).toBe(3); // 越过 b
    const l2 = ed.left(l1);
    expect(l2.cursor).toBe(1); // 整个 😀
    expect(ed.left(ed.left(l2)).cursor).toBe(0); // 到头不越界
    expect(ed.right(st('a😀b', 1)).cursor).toBe(3);
    expect(ed.right(st('ab', 2)).cursor).toBe(2);
  });

  it('insert 归一换行 + 剥控制符;光标处插入', () => {
    expect(ed.insert(st('ab', 1), 'X\r\nY').text).toBe('aX\nYb');
    expect(ed.insert(st('', 0), 'a\x1b[31mb').text).toBe('a[31mb'); // ESC 剥掉、可见部分保留
    expect(ed.insert(st('', 0), '保\tt留\n').text).toBe('保\tt留\n');
  });

  it('deleteForward / deleteWordBack / killToLineEnd', () => {
    expect(ed.deleteForward(st('a😀b', 1))).toEqual({ text: 'ab', cursor: 1 });
    expect(ed.deleteWordBack(st('hello world', 11))).toEqual({ text: 'hello ', cursor: 6 });
    expect(ed.deleteWordBack(st('hello world ', 12))).toEqual({ text: 'hello ', cursor: 6 }); // 含尾空白
    expect(ed.killToLineEnd(st('ab\ncd', 1))).toEqual({ text: 'a\ncd', cursor: 1 });
    expect(ed.killToLineEnd(st('ab\ncd', 2))).toEqual({ text: 'abcd', cursor: 2 }); // 行尾 → 合并下行
  });
});

describe('editor:多行与行操作', () => {
  it('lineHome/lineEnd 行级(非全 buffer)', () => {
    const s = st('first\nsecond', 8); // second 内
    expect(ed.lineHome(s).cursor).toBe(6);
    expect(ed.lineEnd(s).cursor).toBe(12);
  });

  it('up/down 保持字素列;首/末行返回 null(转历史)', () => {
    const s = st('中文行\nabc', 8); // abc 行尾 col=2? -> abc 全长 col 3
    const u = ed.up(s)!;
    expect(u.cursor).toBe(3); // 中文行 第 3 个字素后 = 3 个中文字符 → unit 3
    expect(ed.up(st('abc', 1))).toBeNull();
    expect(ed.down(st('a\nb', 3))).toBeNull();
    const d = ed.down(st('abcd\nx', 2))!;
    expect(d.cursor).toBe(6); // 短行钳到行尾
  });

  it('cursorRow/rowCount', () => {
    expect(ed.cursorRow(st('a\nb\nc', 4))).toBe(2);
    expect(ed.rowCount(st('a\nb\nc'))).toBe(3);
    expect(ed.rowCount(st(''))).toBe(1);
  });
});

describe('editor:layout 软换行 + 光标定位', () => {
  it('CJK 宽度换行:width=4 时 3 个中文字折为 2+1', () => {
    const lines = ed.layout(st('中文字'), 4);
    expect(lines.map((l) => l.text)).toEqual(['中文', '字']);
    // 光标在末尾 → 落最后一片
    expect(lines[1]).toMatchObject({ hasCursor: true, cursorUnits: 1 });
  });

  it('光标恰在折行边界 → 归续行列 0', () => {
    const lines = ed.layout(st('abcdef', 3), 3);
    expect(lines.map((l) => l.text)).toEqual(['abc', 'def']);
    expect(lines[0]!.hasCursor).toBe(false);
    expect(lines[1]).toMatchObject({ hasCursor: true, cursorUnits: 0 });
  });

  it('空行/空 buffer 也有一行且光标可落', () => {
    const lines = ed.layout(st(''), 10);
    expect(lines).toEqual([{ text: '', hasCursor: true, cursorUnits: 0 }]);
    const multi = ed.layout(st('a\n\nb', 2), 10); // 光标在空行
    expect(multi[1]).toMatchObject({ text: '', hasCursor: true });
  });

  it('splitAtCursor:行尾补空格;光标下取整字素', () => {
    expect(ed.splitAtCursor('ab', 2)).toEqual({ before: 'ab', at: ' ', after: '' });
    expect(ed.splitAtCursor('a😀b', 1)).toEqual({ before: 'a', at: '😀', after: 'b' });
  });
});

describe('width:显示宽度', () => {
  it('CJK/emoji 2 格,ASCII 1 格,组合符 0 格', () => {
    expect(cellWidth('中')).toBe(2);
    expect(cellWidth('😀')).toBe(2);
    expect(cellWidth('a')).toBe(1);
    expect(strWidth('中a文')).toBe(5);
    expect(strWidth('é')).toBe(1); // e + 组合重音
  });
});
