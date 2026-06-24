/**
 * @yo-agent/protocol —— 协议单一事实源（DESIGN §6 / Phase 0）。
 *
 * 这里冻结的 sealed AgentEvent、JSON-RPC 方法表、cursor/resume 语义，是 yo-agent
 * 内核、各 surface、以及 yo-aichat Go bridge 共同遵守的契约。zod schema 同时提供
 * 运行时校验与 JSON Schema 导出（见 scripts/gen-schema.ts）。
 */
export * from './version';
export * from './ids';
export * from './enums';
export * from './events';
export * from './rpc';
