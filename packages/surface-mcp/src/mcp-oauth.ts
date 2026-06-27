/**
 * MCP OAuth client provider（3G / DESIGN §15.3 / §15.10 C4）。
 *
 * 文件后端持久化 token / code_verifier / 动态注册信息到独立目录（默认 ~/.yo-agent/mcp-oauth/<server>），
 * **与 ed25519 设备鉴权（Phase 2D）分离的存储后端**。secret 文件 0600 权限、绝不入日志（§15.3）。
 *
 * headless 常驻进程无浏览器 → `redirectToAuthorization` **带外授权**：写授权 URL 到文件 + stderr 提示，
 * 不开浏览器、不阻塞首连（操作者带外完成后用 finishAuth 回灌 code）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface FileOAuthOptions {
  /** 持久化目录（如 ~/.yo-agent/mcp-oauth/<server>）。 */
  dir: string;
  /** OAuth redirect URI（带外流程也需登记一个）。 */
  redirectUrl: string;
  clientName?: string;
  scope?: string;
  /** 带外授权回调（默认写文件 + stderr，不开浏览器）。 */
  onAuthorize?: (url: URL) => void;
}

export class FileOAuthClientProvider implements OAuthClientProvider {
  constructor(private readonly opts: FileOAuthOptions) {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 }); // 私有目录（审查 M6）
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? 'yo-agent',
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.opts.scope,
    };
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.readJson<OAuthClientInformationFull>('client.json');
  }
  saveClientInformation(info: OAuthClientInformationFull): void {
    // client.json 可能含 client_secret/registration_access_token（AS 下发）→ 同 token 一律 0600（审查 M6）。
    this.writeSecret('client.json', JSON.stringify(info, null, 2));
  }

  tokens(): OAuthTokens | undefined {
    return this.readJson<OAuthTokens>('tokens.json');
  }
  saveTokens(tokens: OAuthTokens): void {
    this.writeSecret('tokens.json', JSON.stringify(tokens, null, 2)); // 含 access/refresh token
  }

  saveCodeVerifier(verifier: string): void {
    this.writeSecret('verifier.txt', verifier);
  }
  codeVerifier(): string {
    const v = this.tryRead('verifier.txt');
    if (!v) throw new Error('无 code_verifier（尚未发起授权流程）');
    return v;
  }

  /** 带外授权：写授权 URL + stderr 提示，不开浏览器、不阻塞（headless）。 */
  redirectToAuthorization(authorizationUrl: URL): void {
    writeFileSync(this.path('authorize-url.txt'), authorizationUrl.toString(), 'utf8');
    const notify = this.opts.onAuthorize ?? ((u: URL) => console.error(`[mcp-oauth] 请带外完成授权：${u.toString()}`));
    notify(authorizationUrl);
  }

  // ───────── 文件 helpers ─────────
  private path(name: string): string {
    return join(this.opts.dir, name);
  }
  private readJson<T>(name: string): T | undefined {
    const raw = this.tryRead(name);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined; // 损坏文件 fail-closed（视为未注册/未登录）
    }
  }
  /**
   * 写敏感文件：先删旧文件再以 O_EXCL（flag:'wx'）+ 0600 原子创建（审查 M6）——
   * mode 仅在创建时生效，直接 writeFileSync 覆盖既有宽权限文件不会收紧权限；攻击者预置 0666 文件即可窃取。
   */
  private writeSecret(name: string, data: string): void {
    const p = this.path(name);
    try {
      rmSync(p, { force: true });
    } catch {
      /* 不存在即可 */
    }
    writeFileSync(p, data, { mode: 0o600, flag: 'wx' });
  }
  private tryRead(name: string): string | null {
    try {
      return readFileSync(this.path(name), 'utf8');
    } catch {
      return null;
    }
  }
}
