/**
 * @yo-agent/surface-cli —— CliSurface（DESIGN §7.2）。
 * headless（formatHeadless / JSONL）+ Ink 差量渲染 TUI + 交互审批 UX；组合根辅助见 compose。
 */
export * from './jsonl';
export * from './headless';
export * from './compose';
export * from './tui-format';
export * from './tui/app';
export * from './tui/model';
export * from './tui/keymap';
// 输入层(4.6b):editor 命名过于通用(insert/left/up…),整体命名空间导出。
export * as editor from './tui/input/editor';
export { PersistentHistory, HISTORY_LIMIT } from './tui/input/history';
export { PasteTracker, newPasteStore, foldPaste, expandPastes, FOLD_LINES } from './tui/input/paste';
export { cellWidth, graphemes, strWidth } from './tui/input/width';
