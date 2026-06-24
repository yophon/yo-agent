import { describe, it, expect } from 'vitest';
import {
  DeviceIdentity,
  PairingGate,
  clientHandshake,
  pairingProof,
  serverHandshake,
  utf8,
  verifySignature,
} from '@yo-agent/auth';
import type { HandshakeChannel } from '@yo-agent/auth';

/** 本地内存信道对（auth 不依赖 surface-rpc）：异步投递 + JSON round-trip。 */
function makePair(): { a: HandshakeChannel; b: HandshakeChannel } {
  let aH: ((m: unknown) => void) | null = null;
  let bH: ((m: unknown) => void) | null = null;
  const deliver = (to: () => ((m: unknown) => void) | null, m: unknown) => {
    const s = JSON.stringify(m);
    queueMicrotask(() => to()?.(JSON.parse(s)));
  };
  const a: HandshakeChannel = { send: (m) => deliver(() => bH, m), onMessage: (h) => { aH = h; } };
  const b: HandshakeChannel = { send: (m) => deliver(() => aH, m), onMessage: (h) => { bH = h; } };
  return { a, b };
}

/** 并发跑 server/client 握手，返回 [serverResult, clientResult]（任一抛错则该侧 reject）。 */
async function run(
  gate: PairingGate,
  identity: DeviceIdentity,
  clientOpts: { pairingCode?: string } = {},
  serverOpts: { nonce?: string } = {},
) {
  const pair = makePair();
  return Promise.allSettled([serverHandshake(pair.a, gate, serverOpts), clientHandshake(pair.b, identity, clientOpts)]);
}

describe('DeviceIdentity / 签名', () => {
  it('签名可被对应公钥验证；篡改/换钥即失败', () => {
    const id = DeviceIdentity.generate();
    const sig = id.sign(utf8('nonce-abc'));
    expect(verifySignature(sig, utf8('nonce-abc'), id.publicKeyHex)).toBe(true);
    expect(verifySignature(sig, utf8('nonce-xyz'), id.publicKeyHex)).toBe(false); // 改消息
    expect(verifySignature(sig, utf8('nonce-abc'), DeviceIdentity.generate().publicKeyHex)).toBe(false); // 换钥
  });

  it('fromSeedHex 还原同一身份', () => {
    const id = DeviceIdentity.generate();
    const id2 = DeviceIdentity.fromSeedHex(id.seedHex);
    expect(id2.publicKeyHex).toBe(id.publicKeyHex);
  });
});

describe('握手', () => {
  it('已受信设备：nonce 签名挑战通过 → ok', async () => {
    const id = DeviceIdentity.generate();
    const gate = new PairingGate();
    gate.trust(id.publicKeyHex);
    const [s, c] = await run(gate, id);
    expect(s.status).toBe('fulfilled');
    expect(c.status).toBe('fulfilled');
    expect((s as PromiseFulfilledResult<{ pubKey: string }>).value.pubKey).toBe(id.publicKeyHex);
  });

  it('未受信 + 正确配对码 → 配对成功并注册为受信', async () => {
    const id = DeviceIdentity.generate();
    const gate = new PairingGate();
    const code = gate.issueCode();
    expect(gate.isTrusted(id.publicKeyHex)).toBe(false);
    const [s, c] = await run(gate, id, { pairingCode: code });
    expect(s.status).toBe('fulfilled');
    expect(c.status).toBe('fulfilled');
    expect(gate.isTrusted(id.publicKeyHex)).toBe(true); // 已注册
  });

  it('未受信 + 无配对码 → not paired 拒绝', async () => {
    const id = DeviceIdentity.generate();
    const gate = new PairingGate();
    const [s, c] = await run(gate, id);
    expect(s.status).toBe('rejected');
    expect(c.status).toBe('rejected');
    expect((c as PromiseRejectedResult).reason.message).toContain('not paired');
  });

  it('未受信 + 错误配对码 → 拒绝（不注册）', async () => {
    const id = DeviceIdentity.generate();
    const gate = new PairingGate();
    gate.issueCode(); // 发了码，但客户端用错码
    const [s, c] = await run(gate, id, { pairingCode: '000000' });
    expect(s.status).toBe('rejected');
    expect(c.status).toBe('rejected');
    expect(gate.isTrusted(id.publicKeyHex)).toBe(false);
  });

  it('配对码一次性：用过即失效（第二台设备同码失败）', async () => {
    const id1 = DeviceIdentity.generate();
    const id2 = DeviceIdentity.generate();
    const gate = new PairingGate();
    const code = gate.issueCode();
    await run(gate, id1, { pairingCode: code }); // 消费掉
    const [s2] = await run(gate, id2, { pairingCode: code });
    expect(s2.status).toBe('rejected'); // 码已失效
    expect(gate.isTrusted(id2.publicKeyHex)).toBe(false);
  });

  it('配对码失败锁定：超过最大尝试次数后作废', () => {
    const gate = new PairingGate({ maxAttempts: 3 });
    const id = DeviceIdentity.generate();
    const code = gate.issueCode();
    const wrong = pairingProof('999999', id.publicKeyHex); // 错 proof
    expect(gate.verifyPairing(id.publicKeyHex, code, wrong)).toBe(false);
    expect(gate.verifyPairing(id.publicKeyHex, code, wrong)).toBe(false);
    expect(gate.verifyPairing(id.publicKeyHex, code, wrong)).toBe(false);
    // 第 4 次：即使用正确 proof 也因锁定失败
    expect(gate.verifyPairing(id.publicKeyHex, code, pairingProof(code, id.publicKeyHex))).toBe(false);
  });

  it('坏签名（未持有私钥）→ 拒绝（nonce 挑战防重放/冒充）', async () => {
    const id = DeviceIdentity.generate();
    const gate = new PairingGate();
    gate.trust(id.publicKeyHex);
    // 手动伪造：用别的私钥签 nonce，冒充 id 的公钥
    const pair = makePair();
    const imposter = DeviceIdentity.generate();
    const serverP = serverHandshake(pair.a, gate, { nonce: 'fixed-nonce' });
    // 客户端侧手写消息：hello 用受信公钥，但签名用冒充者私钥
    pair.b.onMessage((m) => {
      const msg = m as { t: string; nonce?: string };
      if (msg.t === 'challenge') {
        pair.b.send({ t: 'auth', sig: imposter.sign(utf8(msg.nonce!)) }); // 错私钥签名
      }
    });
    pair.b.send({ t: 'hello', pubKey: id.publicKeyHex });
    await expect(serverP).rejects.toThrow(/签名无效/);
  });
});
