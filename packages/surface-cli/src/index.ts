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
export { useSyncedRef, type SyncedRef } from './tui/hooks';
// 输入层(4.6b):editor 命名过于通用(insert/left/up…),整体命名空间导出。
export * as editor from './tui/input/editor';
export { PersistentHistory, HISTORY_LIMIT } from './tui/input/history';
export { PasteTracker, newPasteStore, foldPaste, expandPastes, FOLD_LINES } from './tui/input/paste';
export { cellWidth, graphemes, strWidth } from './tui/input/width';
// 渲染层(4.6c):markdown/diff 内有 inline/toStyled 等通用名,命名空间导出。
export * as md from './tui/render/markdown';
export * as diffRender from './tui/render/diff';
export { toolView, type ToolView, type ToolBlock } from './tui/render/tool-views';
export { lineText, type Span, type StyledLine } from './tui/render/spans';
export { renderBlock, type RenderOpts } from './tui/render/blocks';
// 命令与补全(4.6d;4.7a 起 tui-format 旧 SlashCommand 已删,注册表版直接导出)。
export {
  buildCommands,
  findCommand,
  helpText,
  parseCommandLine,
  type CommandDeps,
  type SlashCommand,
} from './tui/commands';
export * from './tui/input/completion';
export { renderPicker, renderCompletionMenu, type PickerItem, type PickerState } from './tui/render/picker';
