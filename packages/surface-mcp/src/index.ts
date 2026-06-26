/**
 * @yo-agent/surface-mcp —— MCP 双向接入（DESIGN §3.3 / §7.2 / §15.3）。
 *  - server 侧（`mcp-surface`）：把 yo-agent 暴露为 MCP server，被 Claude Code/Cursor 当可编排执行节点。
 *  - host 侧（`mcp-host` + `mcp-config`）：把外部 MCP server 的工具拉进内核（三层信任配置 + 3A 护栏）。
 */
export * from './mcp-surface';
export * from './mcp-host';
export * from './mcp-config';
