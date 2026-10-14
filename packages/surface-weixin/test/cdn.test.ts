import { describe, it, expect } from 'vitest';
import { buildCdnDownloadUrl, decryptAesEcb, downloadCdnMedia, encryptAesEcb, parseAesKey } from '@yo-agent/surface-weixin';
import type { FetchLike } from '@yo-agent/surface-weixin';

const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

describe('6c CDN 媒体解密', () => {
  it('AES-128-ECB 往返（PKCS7）；密文按 16 字节对齐', () => {
    const plain = Buffer.from(`hello weixin cdn ${'x'.repeat(100)}`);
    const enc = encryptAesEcb(plain, key);
    expect(enc.length % 16).toBe(0);
    expect(enc.length).toBe(Math.ceil((plain.length + 1) / 16) * 16);
    expect(decryptAesEcb(enc, key)).toEqual(plain);
  });

  it('aes_key 两种线上形态：base64(raw 16 字节) / base64(32 位 hex 串)；其它长度报错', () => {
    expect(parseAesKey(key.toString('base64'))).toEqual(key);
    expect(parseAesKey(Buffer.from(key.toString('hex'), 'ascii').toString('base64'))).toEqual(key);
    expect(() => parseAesKey(Buffer.from('short').toString('base64'))).toThrow(/16 字节/);
  });

  it('下载 URL：full_url 优先，否则按 encrypt_query_param 拼；解密后超限报错，密文粗判先拦', async () => {
    expect(buildCdnDownloadUrl('a b&c', 'https://cdn.example/c2c')).toBe('https://cdn.example/c2c/download?encrypted_query_param=a%20b%26c');
    const plain = Buffer.alloc(64, 7);
    const enc = encryptAesEcb(plain, key);
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return new Response(new Uint8Array(enc));
    };
    const got = await downloadCdnMedia({ media: { full_url: 'https://cdn.example/full', encrypt_query_param: 'q', aes_key: key.toString('base64') }, cdnBaseUrl: 'https://cdn.example/c2c', fetchImpl });
    expect(got).toEqual(plain);
    expect(urls[0]).toBe('https://cdn.example/full');

    await downloadCdnMedia({ media: { encrypt_query_param: 'q', aes_key: key.toString('base64') }, cdnBaseUrl: 'https://cdn.example/c2c', fetchImpl });
    expect(urls[1]).toBe('https://cdn.example/c2c/download?encrypted_query_param=q');

    await expect(
      downloadCdnMedia({ media: { encrypt_query_param: 'q', aes_key: key.toString('base64') }, cdnBaseUrl: 'https://cdn.example/c2c', fetchImpl, maxBytes: 63 }),
    ).rejects.toThrow(/超过上限/);
    await expect(
      downloadCdnMedia({ media: { encrypt_query_param: 'q', aes_key: key.toString('base64') }, cdnBaseUrl: 'https://cdn.example/c2c', fetchImpl, maxBytes: 10 }),
    ).rejects.toThrow(/超过上限/);
    await expect(downloadCdnMedia({ media: {}, cdnBaseUrl: 'https://cdn.example/c2c', fetchImpl })).rejects.toThrow(/缺 full_url/);
  });

  it('无 key 的明文媒体原样返回；HTTP 非 2xx 报错', async () => {
    const raw = Buffer.from('plain');
    const ok: FetchLike = async () => new Response(new Uint8Array(raw));
    expect(await downloadCdnMedia({ media: { encrypt_query_param: 'q' }, cdnBaseUrl: 'https://cdn.example/c2c', fetchImpl: ok })).toEqual(raw);
    const bad: FetchLike = async () => new Response('x', { status: 403 });
    await expect(downloadCdnMedia({ media: { encrypt_query_param: 'q' }, cdnBaseUrl: 'https://cdn.example/c2c', fetchImpl: bad })).rejects.toThrow(/HTTP 403/);
  });
});
