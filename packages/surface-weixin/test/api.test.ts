import { describe, it, expect } from 'vitest';
import { getUpdates, sendTextMessage, sendMessageItem, getBotQrcode, parseWeixinJson, BOT_AGENT } from '@yo-agent/surface-weixin';
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

describe('6c API 增量', () => {
  it('uint64 消息 id 无损：message_id/msg_id/svr_id 的裸数字先引成字符串；字符串值内的同名键不动', () => {
    const raw = '{"ret":0,"msgs":[{"message_id":9007199254740993,"seq":7,"item_list":[{"msg_id": 18446744073709551615,"ref_msg":{"svr_id":123},"text_item":{"text":"看 \\"message_id\\": 5 这段"}}]}]}';
    const parsed = parseWeixinJson<{ msgs: Array<{ message_id: unknown; seq: unknown; item_list: Array<{ msg_id: unknown; ref_msg: { svr_id: unknown }; text_item: { text: string } }> }> }>(raw);
    const m = parsed.msgs[0]!;
    expect(m.message_id).toBe('9007199254740993');
    expect(m.seq).toBe(7); // 非 id 字段仍是数字
    expect(m.item_list[0]!.msg_id).toBe('18446744073709551615');
    expect(m.item_list[0]!.ref_msg.svr_id).toBe('123');
    expect(m.item_list[0]!.text_item.text).toBe('看 "message_id": 5 这段');
    // 已是字符串的 id 原样
    expect(parseWeixinJson<{ message_id: string }>('{"message_id":"42"}').message_id).toBe('42');
  });

  it('sendMessageItem：单 item + run_id + context_token；响应 message_id 无损；非零 ret 抛错', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: '{"ret":0,"message_id":9007199254740993}' }));
    const resp = await sendMessageItem({
      baseUrl: 'https://gw.example',
      token: 't',
      fetchImpl,
      to: 'u1',
      item: { type: 11, tool_call_start_item: { tool_name: 'grep', tool_call_id: 'c1' } },
      contextToken: 'ctx',
      clientId: 'cid',
      runId: 'run-1',
    });
    expect(resp.message_id).toBe('9007199254740993');
    const body = JSON.parse(String(calls[0]!.init.body)) as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({ to_user_id: 'u1', message_type: 2, message_state: 2, run_id: 'run-1', context_token: 'ctx', client_id: 'cid' });
    expect((body.msg.item_list as unknown[]).length).toBe(1);

    const bad = mockFetch(() => ({ body: { ret: -1, errmsg: 'boom' } }));
    await expect(sendTextMessage({ baseUrl: 'https://gw.example', token: 't', fetchImpl: bad.fetchImpl, to: 'u1', text: 'x', clientId: 'c' })).rejects.toThrow(/boom/);
  });
});
