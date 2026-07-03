/**
 * 多行输入框(4.7d 自 app.ts 拆出):边框圆角,首行 '› ' 前缀;超高围绕光标滚动;
 * 光标字素反白。布局计算在 input/editor.layout(),本文件只摆元素。
 */
import React from 'react';
import { Box, Text } from 'ink';
import * as ed from '../input/editor';

const h = React.createElement;

/** 输入框最多显示的视觉行数(超出围绕光标滚动)。 */
export const INPUT_MAX_ROWS = 10;

export function renderInputBox(editor: ed.EditorState, columns: number, running: boolean): React.ReactElement {
  // 可用文本宽度 = 终端列 - 边框(2) - 内边距(2) - 前缀(2),下限 10。
  const usable = Math.max(10, columns - 6);
  const all = ed.layout(editor, usable);
  let lines = all;
  let offset = 0;
  if (all.length > INPUT_MAX_ROWS) {
    const cursorAt = Math.max(0, all.findIndex((l) => l.hasCursor));
    offset = Math.min(Math.max(0, cursorAt - INPUT_MAX_ROWS + 1), all.length - INPUT_MAX_ROWS);
    lines = all.slice(offset, offset + INPUT_MAX_ROWS);
  }
  const rows = lines.map((line, i) => {
    const prefix = offset + i === 0 ? h(Text, { key: 'p', color: 'cyan' }, '› ') : h(Text, { key: 'p' }, '  ');
    if (!line.hasCursor) return h(Text, { key: `l${i}` }, prefix, line.text);
    const { before, at, after } = ed.splitAtCursor(line.text, line.cursorUnits);
    return h(Text, { key: `l${i}` }, prefix, before, h(Text, { inverse: true }, at), after);
  });
  return h(
    Box,
    { key: 'input', flexDirection: 'column', borderStyle: 'round', borderColor: running ? 'gray' : 'cyan', paddingX: 1 },
    ...rows,
  );
}
