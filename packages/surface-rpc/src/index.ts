/**
 * @yo-agent/surface-rpc —— RpcSurface（DESIGN §6 / §7.2）。
 * JSON-RPC 2.0 通用远端驱动协议（泛化，不绑特定前端）：消费内核事件流 + 回灌输入 / 审批。
 */
export * from './transport';
export * from './jsonrpc';
export * from './rpc-surface';
