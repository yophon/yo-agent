/**
 * @yo-agent/store/core —— 浏览器安全核心入口（Phase 5A）。
 * 只含 MemoryEventStore + IndexedDBEventStore（5.1a）+ ResumeBuffer；
 * 排除 sqlite / automemory / checkpoint（node:sqlite / node:fs）。
 * 类型经 type-only 转发（打包期整体擦除）。IndexedDB 实现只进 core 不进 barrel
 * ——Node 侧无 indexedDB 全局，barrel 导出徒增误用面。
 */
export { EVENTLOG_SCHEMA_VERSION } from '@yo-agent/protocol';
export type { Checkpoint, SessionRow, EventStore } from './index';
export * from './memory';
export * from './indexeddb';
export * from './resume';
