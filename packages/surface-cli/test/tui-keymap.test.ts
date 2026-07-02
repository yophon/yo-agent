import { describe, it, expect } from 'vitest';
import { routeKey, type KeyContext } from '@yo-agent/surface-cli';

const idle: KeyContext = { approvalOpen: false, running: false };
const busy: KeyContext = { approvalOpen: false, running: true };
const approving: KeyContext = { approvalOpen: true, running: true };

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
  it('运行中 → interrupt;空闲 Ctrl+C → exit、Esc → clear-input', () => {
    expect(routeKey('c', { ctrl: true }, busy)).toEqual({ type: 'interrupt' });
    expect(routeKey('', { escape: true }, busy)).toEqual({ type: 'interrupt' });
    expect(routeKey('c', { ctrl: true }, idle)).toEqual({ type: 'exit' });
    expect(routeKey('', { escape: true }, idle)).toEqual({ type: 'clear-input' });
  });
});

describe('keymap:编辑/历史/提交', () => {
  it('回车 → submit(空闲与运行中一致,语义由 app 决定)', () => {
    expect(routeKey('', { return: true }, idle)).toEqual({ type: 'submit' });
    expect(routeKey('', { return: true }, busy)).toEqual({ type: 'submit' });
  });
  it('Ctrl+A/E/U、←→、↑↓、退格', () => {
    expect(routeKey('a', { ctrl: true }, idle)).toEqual({ type: 'cursor-home' });
    expect(routeKey('e', { ctrl: true }, idle)).toEqual({ type: 'cursor-end' });
    expect(routeKey('u', { ctrl: true }, idle)).toEqual({ type: 'clear-input' });
    expect(routeKey('', { leftArrow: true }, idle)).toEqual({ type: 'cursor-left' });
    expect(routeKey('', { rightArrow: true }, idle)).toEqual({ type: 'cursor-right' });
    expect(routeKey('', { upArrow: true }, idle)).toEqual({ type: 'history-prev' });
    expect(routeKey('', { downArrow: true }, idle)).toEqual({ type: 'history-next' });
    expect(routeKey('', { backspace: true }, idle)).toEqual({ type: 'backspace' });
    expect(routeKey('', { delete: true }, idle)).toEqual({ type: 'backspace' });
  });
  it('可见字符插入;Ctrl/Meta 组合不插入', () => {
    expect(routeKey('中', {}, idle)).toEqual({ type: 'insert', text: '中' });
    expect(routeKey('x', { ctrl: true }, idle)).toBeNull();
    expect(routeKey('x', { meta: true }, idle)).toBeNull();
    expect(routeKey('', {}, idle)).toBeNull();
  });
});
