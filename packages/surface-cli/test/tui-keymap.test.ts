import { describe, it, expect } from 'vitest';
import { routeKey, type KeyContext } from '@yo-agent/surface-cli';

const base = { bufferEmpty: true, cursorAtFirstRow: true, cursorAtLastRow: true };
const idle: KeyContext = { approvalOpen: false, running: false, ...base };
const busy: KeyContext = { approvalOpen: false, running: true, ...base };
const approving: KeyContext = { approvalOpen: true, running: true, ...base };
const editing: KeyContext = { ...idle, bufferEmpty: false, cursorAtFirstRow: false, cursorAtLastRow: false };

describe('keymap:审批层最高优先且吞键', () => {
  it('方向/回车/Esc → 审批命令', () => {
    expect(routeKey('', { upArrow: true }, approving)).toEqual({ type: 'approval-up' });
    expect(routeKey('', { downArrow: true }, approving)).toEqual({ type: 'approval-down' });
    expect(routeKey('', { return: true }, approving)).toEqual({ type: 'approval-confirm' });
    expect(routeKey('', { escape: true }, approving)).toEqual({ type: 'approval-reject' });
  });
  it('其余输入被吞(可见字符 / Ctrl+C 都不外泄)', () => {
    expect(routeKey('a', {}, approving)).toBeNull();
    expect(routeKey('c', { ctrl: true }, approving)).toBeNull();
  });
});

describe('keymap:Ctrl+C / Esc 随运行态变义', () => {
  it('运行中 → interrupt;空闲 Ctrl+C → exit-request、Esc → clear-input', () => {
    expect(routeKey('c', { ctrl: true }, busy)).toEqual({ type: 'interrupt' });
    expect(routeKey('', { escape: true }, busy)).toEqual({ type: 'interrupt' });
    expect(routeKey('c', { ctrl: true }, idle)).toEqual({ type: 'exit-request' });
    expect(routeKey('', { escape: true }, idle)).toEqual({ type: 'clear-input' });
  });
  it('Ctrl+D:空 buffer 退出请求,非空前向删除', () => {
    expect(routeKey('d', { ctrl: true }, idle)).toEqual({ type: 'exit-request' });
    expect(routeKey('d', { ctrl: true }, editing)).toEqual({ type: 'delete-forward' });
  });
});

describe('keymap:提交与换行(ink 5 派发形态)', () => {
  it('回车(key.return) → submit;Alt+Enter(ch=\\r 无标志)/ Ctrl+J(ch=\\n) → newline', () => {
    expect(routeKey('\r', { return: true }, idle)).toEqual({ type: 'submit' });
    expect(routeKey('\r', {}, idle)).toEqual({ type: 'newline' }); // Alt+Enter 被 ink 剥 ESC
    expect(routeKey('\n', {}, idle)).toEqual({ type: 'newline' }); // Ctrl+J
  });
});

describe('keymap:编辑/词操作/行移/历史', () => {
  it('Ctrl+A/E/U/W/K/B/F', () => {
    expect(routeKey('a', { ctrl: true }, idle)).toEqual({ type: 'cursor-home' });
    expect(routeKey('e', { ctrl: true }, idle)).toEqual({ type: 'cursor-end' });
    expect(routeKey('u', { ctrl: true }, idle)).toEqual({ type: 'clear-input' });
    expect(routeKey('w', { ctrl: true }, idle)).toEqual({ type: 'delete-word-back' });
    expect(routeKey('k', { ctrl: true }, idle)).toEqual({ type: 'kill-line-end' });
    expect(routeKey('b', { ctrl: true }, idle)).toEqual({ type: 'cursor-left' });
    expect(routeKey('f', { ctrl: true }, idle)).toEqual({ type: 'cursor-right' });
  });
  it('Alt+B/F 与 Alt+←→ → 词移动', () => {
    expect(routeKey('b', { meta: true }, idle)).toEqual({ type: 'word-left' });
    expect(routeKey('f', { meta: true }, idle)).toEqual({ type: 'word-right' });
    expect(routeKey('', { meta: true, leftArrow: true }, idle)).toEqual({ type: 'word-left' });
    expect(routeKey('', { meta: true, rightArrow: true }, idle)).toEqual({ type: 'word-right' });
  });
  it('↑↓:首/末行 → 历史,行中 → 光标行移', () => {
    expect(routeKey('', { upArrow: true }, idle)).toEqual({ type: 'history-prev' });
    expect(routeKey('', { downArrow: true }, idle)).toEqual({ type: 'history-next' });
    expect(routeKey('', { upArrow: true }, editing)).toEqual({ type: 'cursor-up' });
    expect(routeKey('', { downArrow: true }, editing)).toEqual({ type: 'cursor-down' });
  });
  it('←→、退格、可见字符;Ctrl/Meta/Tab 组合不插入', () => {
    expect(routeKey('', { leftArrow: true }, idle)).toEqual({ type: 'cursor-left' });
    expect(routeKey('', { rightArrow: true }, idle)).toEqual({ type: 'cursor-right' });
    expect(routeKey('', { backspace: true }, idle)).toEqual({ type: 'backspace' });
    expect(routeKey('', { delete: true }, idle)).toEqual({ type: 'backspace' });
    expect(routeKey('中', {}, idle)).toEqual({ type: 'insert', text: '中' });
    expect(routeKey('hello world', {}, idle)).toEqual({ type: 'insert', text: 'hello world' }); // 整段粘贴 fallback
    expect(routeKey('x', { ctrl: true }, idle)).toBeNull();
    expect(routeKey('x', { meta: true }, idle)).toBeNull();
    expect(routeKey('', {}, idle)).toBeNull();
  });
});
