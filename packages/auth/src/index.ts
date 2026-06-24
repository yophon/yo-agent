/**
 * @yo-agent/auth —— 设备鉴权（DESIGN §9.3）。
 * ed25519 设备身份 + 配对码（HMAC 证明 + 失败锁定）+ 每连接 nonce 签名挑战（抗捕获重放）。
 * 在 RPC 会话之前完成握手；用于把 RpcSurface 安全暴露到网络（WS/socket）。
 */
export * from './identity';
export * from './pairing';
export * from './handshake';
