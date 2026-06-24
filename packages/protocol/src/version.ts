/**
 * 协议与存储版本号（DESIGN §6 / §10.1 / §13 Phase 0 退出标准）。
 *
 * - PROTOCOL_VERSION：JSON-RPC/JSONL 线协议版本，握手时交换；不兼容变更才升 major。
 * - EVENTLOG_SCHEMA_VERSION：SQLite EventLog 事件 schema 版本，每条事件入库时带上，
 *   旧事件始终可加载（OpenHands 教训：从第一天就建迁移机制）。
 */
export const PROTOCOL_VERSION = '0.1.0' as const;
export const EVENTLOG_SCHEMA_VERSION = 1 as const;
