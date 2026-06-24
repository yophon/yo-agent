/**
 * 连接握手（DESIGN §9.3）：在 JSON-RPC 会话之前完成设备鉴权。
 * 流程：client→hello(pubKey) → server→challenge(nonce) → client→auth(签名[+配对证明]) → server→ok/err。
 * 签名证明持有私钥（抗重放）；未受信公钥须带有效配对证明才放行（pairing）。
 */
import { DeviceIdentity, randomNonceHex, utf8, verifySignature } from './identity';
import { PairingGate, pairingProof } from './pairing';

/** 握手只需信道的发/收（surface-rpc 的 MessageChannel 结构兼容）。 */
export interface HandshakeChannel {
  send(msg: unknown): void;
  onMessage(handler: (msg: unknown) => void): void;
}

type HelloMsg = { t: 'hello'; pubKey: string };
type ChallengeMsg = { t: 'challenge'; nonce: string };
type AuthMsg = { t: 'auth'; sig: string; pair?: { code: string; proof: string } };
type OkMsg = { t: 'ok' };
type ErrMsg = { t: 'err'; reason: string };

/** 顺序读取信道消息的小工具（握手期间独占 onMessage；完成后由上层 peer 接管）。 */
class ChannelReader {
  private readonly queue: unknown[] = [];
  private waiter: ((m: unknown) => void) | null = null;
  private detached = false;

  constructor(channel: HandshakeChannel) {
    channel.onMessage((m) => {
      if (this.detached) return;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(m);
      } else {
        this.queue.push(m);
      }
    });
  }

  next(timeoutMs = 10_000): Promise<unknown> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('握手超时'));
      }, timeoutMs);
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
  }

  detach(): void {
    this.detached = true;
  }
}

export interface ServerHandshakeOpts {
  /** 测试可注入确定性 nonce。 */
  nonce?: string;
}

/** 服务端握手：成功返回已鉴权设备公钥；失败抛错（已向对端发 err）。 */
export async function serverHandshake(
  channel: HandshakeChannel,
  gate: PairingGate,
  opts: ServerHandshakeOpts = {},
): Promise<{ pubKey: string }> {
  const reader = new ChannelReader(channel);
  const hello = (await reader.next()) as Partial<HelloMsg>;
  if (hello?.t !== 'hello' || typeof hello.pubKey !== 'string') {
    channel.send({ t: 'err', reason: 'expected hello' } satisfies ErrMsg);
    throw new Error('握手：期望 hello');
  }
  const pubKey = hello.pubKey;
  const nonce = opts.nonce ?? randomNonceHex();
  channel.send({ t: 'challenge', nonce } satisfies ChallengeMsg);

  const auth = (await reader.next()) as Partial<AuthMsg>;
  if (auth?.t !== 'auth' || typeof auth.sig !== 'string') {
    channel.send({ t: 'err', reason: 'expected auth' } satisfies ErrMsg);
    throw new Error('握手：期望 auth');
  }
  if (!verifySignature(auth.sig, utf8(nonce), pubKey)) {
    channel.send({ t: 'err', reason: 'bad signature' } satisfies ErrMsg);
    throw new Error('握手：签名无效');
  }
  if (!gate.isTrusted(pubKey)) {
    const paired = auth.pair && gate.verifyPairing(pubKey, auth.pair.code, auth.pair.proof);
    if (!paired) {
      channel.send({ t: 'err', reason: 'not paired' } satisfies ErrMsg);
      throw new Error('握手：未配对');
    }
  }
  channel.send({ t: 'ok' } satisfies OkMsg);
  reader.detach();
  return { pubKey };
}

export interface ClientHandshakeOpts {
  /** 首次配对时带配对码（生成 HMAC 证明）。 */
  pairingCode?: string;
}

/** 客户端握手：失败抛错（含服务端 err.reason）。 */
export async function clientHandshake(
  channel: HandshakeChannel,
  identity: DeviceIdentity,
  opts: ClientHandshakeOpts = {},
): Promise<void> {
  const reader = new ChannelReader(channel);
  channel.send({ t: 'hello', pubKey: identity.publicKeyHex } satisfies HelloMsg);

  const ch = (await reader.next()) as Partial<ChallengeMsg>;
  if (ch?.t !== 'challenge' || typeof ch.nonce !== 'string') throw new Error('握手：期望 challenge');

  const sig = identity.sign(utf8(ch.nonce));
  const pair = opts.pairingCode
    ? { code: opts.pairingCode, proof: pairingProof(opts.pairingCode, identity.publicKeyHex) }
    : undefined;
  channel.send({ t: 'auth', sig, pair } satisfies AuthMsg);

  const res = (await reader.next()) as { t?: string; reason?: string };
  reader.detach();
  if (res?.t !== 'ok') throw new Error(`鉴权失败：${res?.reason ?? '未知'}`);
}
