import { describe, it, expect } from 'vitest';
import { getUpdates, sendTextMessage, getBotQrcode, BOT_AGENT } from '@yo-agent/surface-weixin';
import type { FetchLike } from '@yo-agent/surface-weixin';

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

describe('6a iLink API 客户端', () => {
  it('请求形制：headers（Bearer/AuthorizationType/UIN base64/iLink-App-Id）+ base_info 自报', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { ret: 0, msgs: [], get_updates_buf: 'buf2' } }));
    const resp = await getUpdates({ baseUrl: 'https://gw.example', token: 'tok1', getUpdatesBuf: 'buf1', fetchImpl });
    expect(resp.get_updates_buf).toBe('buf2');

    const { url, init } = calls[0]!;
    expect(url).toBe('https://gw.example/ilink/bot/getupdates');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok1');
    expect(headers.AuthorizationType).toBe('ilink_bot_token');
    expect(headers['iLink-App-Id']).toBe('bot');
    // X-WECHAT-UIN：base64 解开是纯数字（随机 uint32 十进制串）
    const uin = Buffer.from(headers['X-WECHAT-UIN']!, 'base64').toString('utf-8');
    expect(uin).toMatch(/^\d+$/);
    const body = JSON.parse(String(init.body)) as { get_updates_buf: string; base_info: { bot_agent: string } };
    expect(body.get_updates_buf).toBe('buf1');
    expect(body.base_info.bot_agent).toBe(BOT_AGENT);
  });

  it('长轮询客户端超时 → 空响应（游标原样保留），不抛错', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const resp = await getUpdates({ baseUrl: 'https://gw.example', getUpdatesBuf: 'keep', timeoutMs: 20, fetchImpl });
    expect(resp).toEqual({ ret: 0, msgs: [], get_updates_buf: 'keep' });
  });

  it('sendTextMessage：BOT/FINISH/文本 item/context_token 回传', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { ret: 0 } }));
    await sendTextMessage({ baseUrl: 'https://gw.example', token: 't', to: 'user-9', text: '你好', contextToken: 'ctx', clientId: 'c1', fetchImpl });
    const body = JSON.parse(String(calls[0]!.init.body)) as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({
      to_user_id: 'user-9',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx',
      client_id: 'c1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    });
  });

  it('HTTP 非 2xx 抛错（含状态码）；get_bot_qrcode 带 local_token_list', async () => {
    const bad = mockFetch(() => ({ status: 503, body: 'oops' }));
    await expect(sendTextMessage({ baseUrl: 'https://x', to: 'u', text: 't', clientId: 'c', fetchImpl: bad.fetchImpl })).rejects.toThrow('503');

    const qr = mockFetch(() => ({ body: { qrcode: 'q', qrcode_img_content: 'https://qr' } }));
    await getBotQrcode({ baseUrl: 'https://x', localTokenList: ['t1', 't2'], fetchImpl: qr.fetchImpl });
    expect(qr.calls[0]!.url).toContain('get_bot_qrcode?bot_type=3');
    expect(JSON.parse(String(qr.calls[0]!.init.body))).toEqual({ local_token_list: ['t1', 't2'] });
  });
});
