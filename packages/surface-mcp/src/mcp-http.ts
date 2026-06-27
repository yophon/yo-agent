/**
 * MCP Streamable HTTP 传输（3G / DESIGN §15.3 / §15.10 C4）。
 * 抬高并锁 SDK 至 1.29.x（authProvider/reconnectionOptions/StreamableHTTP 在低版本不存在）。
 *
 * 安全约束：**WS 传输不支持 OAuth**（OAuth 必走 Streamable HTTP）。配 WS+OAuth → fail-fast，
 * 避免「以为受 OAuth 保护实则裸连」的误判。
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { StreamableHTTPReconnectionOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** 默认重连退避（§15.3）：1s 起、×1.5、上限 30s、最多 5 次。 */
export const DEFAULT_HTTP_RECONNECTION: StreamableHTTPReconnectionOptions = {
  initialReconnectionDelay: 1_000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 1.5,
  maxRetries: 5,
};

export interface HttpTransportOptions {
  /** OAuth provider（不传 = 无鉴权 HTTP）。 */
  authProvider?: OAuthClientProvider;
  /** 关闭自动重连（默认开）。 */
  reconnect?: boolean;
}

/** 构造 Streamable HTTP client transport（含重连退避 + 可选 OAuth）。 */
export function createHttpClientTransport(url: string, opts: HttpTransportOptions = {}): Transport {
  return new StreamableHTTPClientTransport(new URL(url), {
    authProvider: opts.authProvider,
    reconnectionOptions: opts.reconnect === false ? undefined : DEFAULT_HTTP_RECONNECTION,
  });
}

/**
 * WS+OAuth fail-fast 守卫（§15.3）：WS 传输不支持 OAuth，配二者并存即配置错误。
 * transportKind 为传输类型；hasOAuth 表示是否提供了 OAuth provider。
 */
export function assertOAuthTransportCompatible(transportKind: 'stdio' | 'http' | 'ws', hasOAuth: boolean): void {
  if (hasOAuth && transportKind === 'ws') {
    throw new Error('WS 传输不支持 OAuth：OAuth 必须走 Streamable HTTP（fail-fast，§15.3）');
  }
  if (hasOAuth && transportKind === 'stdio') {
    throw new Error('stdio 传输为本地子进程、无 OAuth 语义：OAuth 仅用于 Streamable HTTP（fail-fast）');
  }
}
