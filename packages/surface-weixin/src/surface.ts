/**
 * WeixinSurface（Phase 6b）：iLink 消息 ⇆ 内核会话。
 * - 会话映射：每（bot 账号, 对端 from_user_id）一个确定性 sessionId `wx-<accountId>-<peerId>`——
 *   配持久 store 时跨进程重启 resumeSession 直接续上（零新机制）。
 * - 入站：文本 item 拼接 → submitInput（不 await：同好友连发靠 5.3a 内核队列串行，跨好友并行；
 *   submitInput 的同步前缀已置 turnActive，调用序即入队序）。BOT 自发消息跳过防回环。
 * - 出站：TurnStarted → typing；AssistantText 按 turn 累积；TurnCompleted → 取消 typing + FINISH
 *   文本（超长切段）；TurnFailed → 简短错误提示。context_token 按对端缓存最近值回传。
 * - 授权门：allow 名单（机主 ownerUserId 恒过）；名单外发件人一次性提示（内存 Set 防刷屏）不进内核。
 */
import type { Kernel } from '@yo-agent/kernel';
import type { EventEnvelope, Id, PermissionMode } from '@yo-agent/protocol';
import type { FetchLike } from './api';
import { DEFAULT_BASE_URL, getConfig, sendTextMessage, sendTyping } from './api';
import type { WeixinAccount } from './accounts';
import { defaultStateDir, loadAllowList } from './accounts';
import type { WeixinMessage } from './types';

/** 微信单条文本上限未公开，按 2000 字保守切段。 */
const TEXT_CHUNK_LIMIT = 2000;

export interface WeixinSurfaceOpts {
  kernel: Kernel;
  account: WeixinAccount;
  stateDir?: string;
  /** 聊天渠道无交互审批通道：缺省 ci（无人值守，待审操作默认拒绝）。 */
  permissionMode?: PermissionMode;
  /** 放行全部发件人（跳过 allow 名单）——仅显式要求时开。 */
  allowAll?: boolean;
  /** 会话 system prompt（bot 人设）；缺省不注入。 */
  system?: string;
  fetchImpl?: FetchLike;
  log?: (msg: string) => void;
}

export class WeixinSurface {
  private readonly kernel: Kernel;
  private readonly account: WeixinAccount;
  private readonly stateDir: string;
  private readonly baseUrl: string;
  private readonly permissionMode: PermissionMode;
  private readonly allowAll: boolean;
  private readonly system?: string;
  private readonly fetchImpl?: FetchLike;
  private readonly log: (msg: string) => void;

  /** 已就绪会话（resume/start 完成 + 订阅挂上）。 */
  private readonly sessions = new Map<Id, { peer: string; unsub: () => void }>();
  /** 各会话进行中 turn 的文本累积（turnId → 已收 delta 拼接）。 */
  private readonly turnText = new Map<string, string>();
  /** 对端 → 最近一次入站 context_token（出站回传）。 */
  private readonly contextTokens = new Map<string, string>();
  /** 对端 → typing ticket 缓存。 */
  private readonly typingTickets = new Map<string, string>();
  /** 本次运行内已提示过的未授权发件人（防刷屏）。 */
  private readonly deniedNotified = new Set<string>();
  private seq = 0;

  constructor(opts: WeixinSurfaceOpts) {
    this.kernel = opts.kernel;
    this.account = opts.account;
    this.stateDir = opts.stateDir ?? defaultStateDir();
    this.baseUrl = opts.account.baseUrl || DEFAULT_BASE_URL;
    this.permissionMode = opts.permissionMode ?? 'ci';
    this.allowAll = opts.allowAll ?? false;
    this.system = opts.system;
    this.fetchImpl = opts.fetchImpl;
    this.log = opts.log ?? (() => {});
  }

  /** monitor 回调入口。 */
  async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type === 2) return; // BOT 侧消息（含本 bot 自发回显）防回环
    const peer = msg.from_user_id?.trim();
    if (!peer) return;
    if (msg.group_id) return; // 群消息 6c 再接（形态待实测）
    // 文本拼接：TEXT item + 语音转文字（服务端已转好直接可用）。
    const text = (msg.item_list ?? [])
      .map((it) => (it.type === 1 ? (it.text_item?.text ?? '') : it.type === 3 ? (it.voice_item?.text ?? '') : ''))
      .filter((t) => t.trim())
      .join('\n');
    if (!text.trim()) return; // 非文本消息（图片/文件等）：6b 不消费

    if (msg.context_token) this.contextTokens.set(peer, msg.context_token);

    if (!this.isAllowed(peer)) {
      await this.notifyDeniedOnce(peer);
      return;
    }

    const sid = this.sessionIdFor(peer);
    await this.ensureSession(sid, peer);
    // 不 await turn 完成：收信循环不被单个 turn 阻塞；同会话排队由内核并发闸保证。
    const idemKey = `wx-${msg.message_id ?? msg.seq ?? `${Date.now()}-${++this.seq}`}`;
    void this.kernel.submitInput(sid, text, idemKey).catch((e) => {
      this.log(`turn 提交失败（peer=${peer}）：${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /** 结束：摘全部订阅（会话本身留内核/store，可续）。 */
  dispose(): void {
    for (const { unsub } of this.sessions.values()) unsub();
    this.sessions.clear();
  }

  sessionIdFor(peer: string): Id {
    return `wx-${this.account.accountId}-${peer}`;
  }

  private isAllowed(peer: string): boolean {
    if (this.allowAll) return true;
    if (peer === this.account.ownerUserId) return true;
    return loadAllowList(this.account.accountId, this.stateDir).includes(peer);
  }

  private async notifyDeniedOnce(peer: string): Promise<void> {
    if (this.deniedNotified.has(peer)) return;
    this.deniedNotified.add(peer);
    this.log(`未授权发件人 ${peer}，已提示（授权：yoagent weixin allow ${this.account.accountId} ${peer}）`);
    await this.sendText(peer, `你还未获得使用授权。请机主运行以下命令后重试：\nyoagent weixin allow ${this.account.accountId} ${peer}`).catch(() => {});
  }

  private async ensureSession(sid: Id, peer: string): Promise<void> {
    if (this.sessions.has(sid)) return;
    const resumed = await this.kernel.resumeSession(sid);
    if (!resumed) {
      await this.kernel.startSession({ sessionId: sid, permissionMode: this.permissionMode, ...(this.system ? { system: this.system } : {}) });
    }
    const unsub = this.kernel.subscribe(sid, null, (env) => this.onEnvelope(peer, env));
    this.sessions.set(sid, { peer, unsub });
    this.log(`会话${resumed ? '续接' : '新建'}：${sid}`);
  }

  private onEnvelope(peer: string, env: EventEnvelope): void {
    const e = env.event;
    if (e.kind === 'TurnStarted') {
      this.turnText.set(e.turnId, '');
      void this.setTyping(peer, 1);
      return;
    }
    if (e.kind === 'AssistantText' && env.turnId) {
      this.turnText.set(env.turnId, (this.turnText.get(env.turnId) ?? '') + e.delta);
      return;
    }
    if (e.kind === 'TurnCompleted' && env.turnId) {
      const text = (this.turnText.get(env.turnId) ?? '').trim();
      this.turnText.delete(env.turnId);
      void this.setTyping(peer, 2);
      if (text) void this.sendChunked(peer, text);
      return;
    }
    if (e.kind === 'TurnFailed' && env.turnId) {
      this.turnText.delete(env.turnId);
      void this.setTyping(peer, 2);
      void this.sendText(peer, '（本轮处理失败，请稍后重试）').catch(() => {});
    }
  }

  private async sendChunked(peer: string, text: string): Promise<void> {
    for (let i = 0; i < text.length; i += TEXT_CHUNK_LIMIT) {
      // 分段顺序发送（await 串行，避免乱序）
      await this.sendText(peer, text.slice(i, i + TEXT_CHUNK_LIMIT)).catch((e) => {
        this.log(`回复发送失败（peer=${peer}）：${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  private async sendText(peer: string, text: string): Promise<void> {
    await sendTextMessage({
      baseUrl: this.baseUrl,
      token: this.account.token,
      fetchImpl: this.fetchImpl,
      to: peer,
      text,
      contextToken: this.contextTokens.get(peer),
      clientId: `yo-agent-${Date.now()}-${++this.seq}`,
    });
  }

  /** typing 指示：全程 best-effort（ticket 拿不到/发失败都不影响回复主链路）。 */
  private async setTyping(peer: string, status: 1 | 2): Promise<void> {
    try {
      let ticket = this.typingTickets.get(peer);
      if (!ticket) {
        const cfg = await getConfig({
          baseUrl: this.baseUrl,
          token: this.account.token,
          fetchImpl: this.fetchImpl,
          ilinkUserId: peer,
          contextToken: this.contextTokens.get(peer),
        });
        ticket = cfg.typing_ticket;
        if (ticket) this.typingTickets.set(peer, ticket);
      }
      if (!ticket) return;
      await sendTyping({ baseUrl: this.baseUrl, token: this.account.token, fetchImpl: this.fetchImpl, ilinkUserId: peer, typingTicket: ticket, status });
    } catch {
      /* 观测性能力，静默降级 */
    }
  }
}
