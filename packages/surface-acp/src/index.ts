/**
 * @yo-agent/surface-acp —— AcpSurface（DESIGN §6 / Phase 3F）。
 * 被 Zed/JetBrains 经 ACP（agent-client-protocol）接管为编程 agent 后端。复用 surface-rpc transport 思想，
 * 用 ACP 包的 AgentSideConnection 隔离 ACP schema 与阻塞语义。
 */
export * from './acp-surface';
export * from './translate';
export * from './fs-guard';
export * from './stream-pair';
