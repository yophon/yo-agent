/**
 * @yo-agent/store/core —— 浏览器安全核心入口（Phase 5A）。
 * 只含 MemoryEventStore + ResumeBuffer；排除 sqlite / automemory / checkpoint
 * （node:sqlite / node:fs）。类型经 type-only 转发（打包期整体擦除）。
 */
export { EVENTLOG_SCHEMA_VERSION } from '@yo-agent/protocol';
export type { Checkpoint, SessionRow, EventStore } from './index';
export * from './memory';
export * from './resume';
