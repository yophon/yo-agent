/**
 * 账号/游标/授权名单存储（Phase 6a）：`~/.yo-agent/weixin/` 下三类文件——
 * accounts.json（多账号索引）、<accountId>.syncbuf（getupdates 游标，每轮落盘防崩溃丢消息）、
 * <accountId>.allow.json（授权名单，形制对齐参考实现 allowFrom）。
 * 目录可注入（测试用临时目录）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WeixinAccount {
  /** ilink_bot_id（登录确认时返回）。 */
  accountId: string;
  token: string;
  /** 登录后 IDC 分配的 API base；空则用 DEFAULT_BASE_URL。 */
  baseUrl?: string;
  /** 扫码者（机主）的用户 ID：自动授权。 */
  ownerUserId?: string;
  createdAt: number;
}

export function defaultStateDir(): string {
  return path.join(os.homedir(), '.yo-agent', 'weixin');
}

function accountsPath(dir: string): string {
  return path.join(dir, 'accounts.json');
}

/** 文件名安全化（accountId 来自服务端，防路径注入）。 */
function safeName(id: string): string {
  const safe = id.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_');
  if (!safe || safe === '_') throw new Error(`非法账号 ID：${id}`);
  return safe;
}

export function loadAccounts(dir = defaultStateDir()): WeixinAccount[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(accountsPath(dir), 'utf-8')) as { accounts?: WeixinAccount[] };
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

/** upsert（按 accountId）：重复扫码同一账号刷新 token 不重复建条目。 */
export function saveAccount(account: WeixinAccount, dir = defaultStateDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  const list = loadAccounts(dir).filter((a) => a.accountId !== account.accountId);
  list.push(account);
  fs.writeFileSync(accountsPath(dir), `${JSON.stringify({ accounts: list }, null, 2)}\n`, 'utf-8');
}

// ───────────────────────── 同步游标 ─────────────────────────

export function loadSyncBuf(accountId: string, dir = defaultStateDir()): string {
  try {
    return fs.readFileSync(path.join(dir, `${safeName(accountId)}.syncbuf`), 'utf-8');
  } catch {
    return '';
  }
}

export function saveSyncBuf(accountId: string, buf: string, dir = defaultStateDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${safeName(accountId)}.syncbuf`), buf, 'utf-8');
}

// ───────────────────────── 授权名单 ─────────────────────────

function allowPath(accountId: string, dir: string): string {
  return path.join(dir, `${safeName(accountId)}.allow.json`);
}

export function loadAllowList(accountId: string, dir = defaultStateDir()): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(allowPath(accountId, dir), 'utf-8')) as { allowFrom?: string[] };
    return Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [];
  } catch {
    return [];
  }
}

export function addAllowFrom(accountId: string, userId: string, dir = defaultStateDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  const list = loadAllowList(accountId, dir);
  if (!list.includes(userId)) list.push(userId);
  fs.writeFileSync(allowPath(accountId, dir), `${JSON.stringify({ version: 1, allowFrom: list }, null, 2)}\n`, 'utf-8');
}
