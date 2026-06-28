import type { Id, PermissionMode, ToolKind } from '@yo-agent/protocol';
import type { HookPoint, PreToolUseDecision } from '@yo-agent/kernel';

/**
 * 插件 IPC 协议（4E / ADR-18）：主进程 ↔ 插件 Worker 的结构化消息契约。
 *
 * 设计要点：
 *   - **崩溃围栏**：Worker 内任何崩溃/越权经 transport 转 onCrash → host 降级该插件工具（退出标准③）。
 *   - **心跳**：Worker 周期发 heartbeat；host 看门狗超时未收 → 判死 → 降级 + 重连。
 *   - **不绕审批**：插件工具的 invoke 消息只在主内核审批流放行**之后**才下发（host 注册的代理工具
 *     descriptor.approval 恒非 'never'，经 kernel PreToolUse→PolicyEngine→approval 把关）。
 *   - **secret 剥离**：Worker env 按白名单透传，插件代码读不到主进程 API key/设备私钥/OAuth token。
 *
 * 消息全部须可结构化克隆（worker_threads postMessage 语义）：纯 JSON 值，无函数/类实例。
 */

export const PLUGIN_PROTOCOL_VERSION = 1;

/** 心跳/超时缺省（毫秒）。host 与 worker-entry.mjs 共用同一组常量（后者经 workerData 收到 interval）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5000;
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 2000;
export const DEFAULT_READY_TIMEOUT_MS = 10_000;

/** 插件工具健康标志（availability configFlag，复用 3C 熔断范式）：插件健在 → flag 在 → 工具可见。 */
export function pluginHealthFlag(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/** 插件对一个工具的声明（ToolDescriptor 的子集；owner/availability 由 host 补、approval 由 host 钳制非 never）。 */
export interface PluginToolDecl {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 插件至多请求 'always' | 'risk-based'；host 恒钳制掉 'never'（插件工具绝不可绕审批）。 */
  approval?: 'always' | 'risk-based';
}

/** 插件清单（Worker 启动握手 'ready' 时回报，声明其提供的工具与订阅的 hook 点）。 */
export interface PluginManifest {
  name: string;
  tools?: PluginToolDecl[];
  hooks?: HookPoint[];
}

/** 下发给插件工具的精简上下文（只传可序列化字段，绝不传主进程对象/secret）。 */
export interface PluginToolCtx {
  sessionId: Id;
  cwd: string;
}

/** 下发给插件 hook 的精简上下文。 */
export interface PluginHookCtx {
  sessionId: Id;
  cwd: string;
  permissionMode: PermissionMode;
}

// ───────────────────────── 主进程 → Worker ─────────────────────────

export type HostToWorker =
  | { type: 'invoke'; id: number; tool: string; input: unknown; ctx: PluginToolCtx }
  | { type: 'hook'; id: number; point: HookPoint; ctx: PluginHookCtx; payload: unknown }
  | { type: 'shutdown' };

// ───────────────────────── Worker → 主进程 ─────────────────────────

export type WorkerToHost =
  | { type: 'ready'; protocol: number; manifest: PluginManifest }
  | { type: 'chunk'; id: number; chunk: string } // 工具流式输出
  | { type: 'done'; id: number; isError?: boolean; error?: string } // 工具 invoke 终结
  | { type: 'hook-result'; id: number; decision?: PreToolUseDecision } // hook 终结（PreToolUse 带裁决）
  | { type: 'heartbeat'; seq: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string };
