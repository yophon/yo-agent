import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginWithQr, loadAccounts, saveAccount } from '@yo-agent/surface-weixin';
import type { FetchLike, QrStatusResp } from '@yo-agent/surface-weixin';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yo-wx-login-'));
}

/** 脚本化网关：get_bot_qrcode 固定返回，get_qrcode_status 按队列出（记录 url）。 */
function gateway(statusQueue: QrStatusResp[]): { fetchImpl: FetchLike; urls: string[]; qrFetches: () => number } {
  const urls: string[] = [];
  let qrCount = 0;
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    if (url.includes('get_bot_qrcode')) {
      qrCount++;
      return new Response(JSON.stringify({ qrcode: `qr-${qrCount}`, qrcode_img_content: `https://qr.example/${qrCount}` }));
    }
    if (url.includes('get_qrcode_status')) {
      return new Response(JSON.stringify(statusQueue.shift() ?? { status: 'wait' }));
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, urls, qrFetches: () => qrCount };
}

const silent = { showQr: () => {}, log: () => {} };

describe('6a 扫码登录状态机', () => {
  it('wait → confirmed：账号落盘（token/baseUrl/机主 ID）', async () => {
    const dir = tmpDir();
    const gw = gateway([
      { status: 'wait' },
      { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot-1', baseurl: 'https://idc7.example', ilink_user_id: 'owner-1' },
    ]);
    const { account, alreadyBound } = await loginWithQr({ stateDir: dir, fetchImpl: gw.fetchImpl, ...silent });
    expect(alreadyBound).toBe(false);
    expect(account).toMatchObject({ accountId: 'bot-1', token: 'tok', baseUrl: 'https://idc7.example', ownerUserId: 'owner-1' });
    expect(loadAccounts(dir)).toHaveLength(1);
  });

  it('expired → 刷新二维码重轮询；scaned_but_redirect → 轮询切 host', async () => {
    const dir = tmpDir();
    const gw = gateway([
      { status: 'expired' },
      { status: 'scaned_but_redirect', redirect_host: 'idc9.example' },
      { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
    ]);
    await loginWithQr({ stateDir: dir, fetchImpl: gw.fetchImpl, ...silent });
    expect(gw.qrFetches()).toBe(2); // expired 触发第二次取码
    const statusUrls = gw.urls.filter((u) => u.includes('get_qrcode_status'));
    expect(statusUrls[statusUrls.length - 1]).toContain('https://idc9.example/'); // redirect 后轮询走新 host
  });

  it('need_verifycode → 配对码回传 query；verify_code_blocked → 可行动错误', async () => {
    const dir = tmpDir();
    const gw = gateway([
      { status: 'need_verifycode' },
      { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
    ]);
    let prompted = 0;
    await loginWithQr({
      stateDir: dir,
      fetchImpl: gw.fetchImpl,
      promptVerifyCode: async () => {
        prompted++;
        return '246810';
      },
      ...silent,
    });
    expect(prompted).toBe(1);
    expect(gw.urls.some((u) => u.includes('verify_code=246810'))).toBe(true);

    const blocked = gateway([{ status: 'verify_code_blocked' }]);
    await expect(loginWithQr({ stateDir: tmpDir(), fetchImpl: blocked.fetchImpl, ...silent })).rejects.toThrow('锁定');
  });

  it('binded_redirect：沿用本机既有凭证视为成功；无既有凭证则报可行动错误', async () => {
    const dir = tmpDir();
    saveAccount({ accountId: 'bot-old', token: 'tok-old', createdAt: 1 }, dir);
    const gw = gateway([{ status: 'binded_redirect', ilink_bot_id: 'bot-old' }]);
    const { account, alreadyBound } = await loginWithQr({ stateDir: dir, fetchImpl: gw.fetchImpl, ...silent });
    expect(alreadyBound).toBe(true);
    expect(account.accountId).toBe('bot-old');

    const bare = gateway([{ status: 'binded_redirect' }]);
    await expect(loginWithQr({ stateDir: tmpDir(), fetchImpl: bare.fetchImpl, ...silent })).rejects.toThrow('既有凭证');
  });
});
