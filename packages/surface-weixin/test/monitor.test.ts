import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorAccount, loadSyncBuf, saveSyncBuf } from '@yo-agent/surface-weixin';
import type { FetchLike, GetUpdatesResp, WeixinAccount, WeixinMessage } from '@yo-agent/surface-weixin';

const account: WeixinAccount = { accountId: 'bot-m', token: 'tok', baseUrl: 'https://gw.example', createdAt: 1 };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yo-wx-mon-'));
}

function textMsg(id: number, text: string): WeixinMessage {
  return { message_id: id, from_user_id: 'peer', message_type: 1, item_list: [{ type: 1, text_item: { text } }] };
}

/** 脚本化 getupdates：按队列出响应（记录请求 buf），耗尽后挂起直到 abort。 */
function gateway(queue: Array<GetUpdatesResp | Error>): { fetchImpl: FetchLike; bufs: string[] } {
  const bufs: string[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    if (!url.includes('getupdates')) return Promise.resolve(new Response('{}'));
    bufs.push((JSON.parse(String(init.body)) as { get_updates_buf: string }).get_updates_buf);
    const next = queue.shift();
    if (next === undefined) {
      return new Promise((_res, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(new Response(JSON.stringify(next)));
  };
  return { fetchImpl, bufs };
}

describe('6a 长轮询 monitor', () => {
  it('消息顺序回调 + 游标逐轮落盘 + abort 干净退出', async () => {
    const dir = tmpDir();
    const gw = gateway([
      { ret: 0, msgs: [textMsg(1, 'a'), textMsg(2, 'b')], get_updates_buf: 'buf-1' },
      { ret: 0, msgs: [textMsg(3, 'c')], get_updates_buf: 'buf-2' },
    ]);
    const got: string[] = [];
    const abort = new AbortController();
    const done = monitorAccount({
      account,
      stateDir: dir,
      signal: abort.signal,
      fetchImpl: gw.fetchImpl,
      onMessage: (m) => {
        got.push(m.item_list?.[0]?.text_item?.text ?? '');
        if (got.length === 3) abort.abort();
      },
    });
    await done;
    expect(got).toEqual(['a', 'b', 'c']);
    expect(loadSyncBuf(account.accountId, dir)).toBe('buf-2');
    expect(gw.bufs[0]).toBe(''); // 首轮空游标
    expect(gw.bufs[1]).toBe('buf-1'); // 次轮回传上轮游标
  });

  it('重启续接：从落盘游标恢复（首请求即带旧 buf）', async () => {
    const dir = tmpDir();
    saveSyncBuf(account.accountId, 'buf-resume', dir);
    const gw = gateway([{ ret: 0, msgs: [], get_updates_buf: 'buf-next' }]);
    const abort = new AbortController();
    const done = monitorAccount({ account, stateDir: dir, signal: abort.signal, fetchImpl: gw.fetchImpl, onMessage: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await done;
    expect(gw.bufs[0]).toBe('buf-resume');
  });

  it('errcode -14（token 失效）→ onStaleToken 回调且循环退出', async () => {
    const gw = gateway([{ ret: 0, errcode: -14, errmsg: 'session timeout' }]);
    let stale = 0;
    await monitorAccount({
      account,
      stateDir: tmpDir(),
      signal: new AbortController().signal,
      fetchImpl: gw.fetchImpl,
      onMessage: () => {},
      onStaleToken: () => stale++,
    }); // 无需 abort：-14 自行返回
    expect(stale).toBe(1);
  });

  it('网络错误退避（<3 连败 2s，≥3 连败 30s）；单条消息处理抛错不掉循环', async () => {
    const dir = tmpDir();
    const gw = gateway([
      new Error('net down'),
      new Error('net down'),
      new Error('net down'),
      { ret: 0, msgs: [textMsg(1, 'boom'), textMsg(2, 'ok')], get_updates_buf: 'buf-x' },
    ]);
    const delays: number[] = [];
    const got: string[] = [];
    const abort = new AbortController();
    await monitorAccount({
      account,
      stateDir: dir,
      signal: abort.signal,
      fetchImpl: gw.fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
      },
      onMessage: (m) => {
        const t = m.item_list?.[0]?.text_item?.text ?? '';
        got.push(t);
        if (t === 'boom') throw new Error('handler 崩了');
        abort.abort();
      },
    });
    expect(delays).toEqual([2000, 2000, 30_000]); // 第三次连败升 30s
    expect(got).toEqual(['boom', 'ok']); // 首条抛错，次条照常
    expect(loadSyncBuf(account.accountId, dir)).toBe('buf-x');
  });
});
