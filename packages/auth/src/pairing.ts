/**
 * 配对门（DESIGN §9.3 / §9.2）：受信设备公钥集 + 一次性配对码（HMAC 证明绑公钥 + 失败锁定）。
 * 未知发送者默认 pairing 模式，需配对码审批才能注册为受信——开放渠道防注入的最低门槛。
 */
import { randomInt } from 'node:crypto';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { fromHex, toHex, utf8 } from './identity';

/** 配对证明：HMAC-SHA256(key=配对码, msg=设备公钥)，把一次性码绑定到该公钥。 */
export function pairingProof(code: string, pubKeyHex: string): string {
  return toHex(hmac(sha256, utf8(code), fromHex(pubKeyHex)));
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface PairingGateOpts {
  /** 单个配对码最大尝试次数，超过即锁定作废（防暴力）。默认 5。 */
  maxAttempts?: number;
}

export class PairingGate {
  private readonly trusted = new Set<string>();
  private readonly codes = new Map<string, { attempts: number }>();
  private readonly maxAttempts: number;

  constructor(opts: PairingGateOpts = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  isTrusted(pubKeyHex: string): boolean {
    return this.trusted.has(pubKeyHex);
  }

  /** 直接信任一个公钥（如从持久配置载入已配对设备）。 */
  trust(pubKeyHex: string): void {
    this.trusted.add(pubKeyHex);
  }

  trustedKeys(): string[] {
    return [...this.trusted];
  }

  /** 发一次性 6 位配对码（服务端显示，带外告知用户）。 */
  issueCode(): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(code, { attempts: 0 });
    return code;
  }

  /**
   * 验证配对：码存在且未锁定 + proof == HMAC(code, pubKey) → 注册公钥为受信、消费该码（一次性）。
   * 失败累计尝试，超 maxAttempts 锁定作废。
   */
  verifyPairing(pubKeyHex: string, code: string, proofHex: string): boolean {
    const rec = this.codes.get(code);
    if (!rec) return false;
    if (rec.attempts >= this.maxAttempts) {
      this.codes.delete(code);
      return false;
    }
    rec.attempts++;
    if (!constantTimeEqualHex(pairingProof(code, pubKeyHex), proofHex)) return false;
    this.trusted.add(pubKeyHex);
    this.codes.delete(code); // 一次性
    return true;
  }
}
