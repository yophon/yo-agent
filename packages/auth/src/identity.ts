/**
 * 设备身份（DESIGN §9.3）：ed25519 密钥对。私钥（seed）存设备安全存储，公钥作设备标识。
 * 每连接 nonce 签名挑战证明持有私钥（抗捕获重放，非静态 bearer）。
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

// @noble/ed25519 v2 sync 方法需先设 sha512Sync（模块加载一次，幂等）。
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}
export function fromHex(h: string): Uint8Array {
  return new Uint8Array(Buffer.from(h, 'hex'));
}
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export class DeviceIdentity {
  private constructor(
    private readonly priv: Uint8Array,
    readonly publicKeyHex: string,
  ) {}

  static generate(): DeviceIdentity {
    const priv = ed.utils.randomPrivateKey();
    return new DeviceIdentity(priv, toHex(ed.getPublicKey(priv)));
  }

  /** 从持久化 seed 还原（存设备安全存储，绝不入日志）。 */
  static fromSeedHex(seedHex: string): DeviceIdentity {
    const priv = fromHex(seedHex);
    return new DeviceIdentity(priv, toHex(ed.getPublicKey(priv)));
  }

  get seedHex(): string {
    return toHex(this.priv);
  }

  sign(message: Uint8Array): string {
    return toHex(ed.sign(message, this.priv));
  }
}

export function verifySignature(sigHex: string, message: Uint8Array, pubKeyHex: string): boolean {
  try {
    return ed.verify(fromHex(sigHex), message, fromHex(pubKeyHex));
  } catch {
    return false;
  }
}

/** 32 字节随机 nonce 的 hex。 */
export function randomNonceHex(): string {
  return toHex(ed.etc.randomBytes(32));
}
