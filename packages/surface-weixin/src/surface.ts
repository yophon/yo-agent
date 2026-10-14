/**
 * WeixinSurface（Phase 6b/6c）：iLink 消息 ⇆ 内核会话。
 * - 会话映射：每（bot 账号, 对端 from_user_id）一个确定性 sessionId `wx-<accountId>-<peerId>`——
 *   配持久 store 时跨进程重启 resumeSession 直接续上（零新机制）。
 * - 入站：文本/语音转文字拼接 + 媒体（图片/文件/视频）CDN 下载解密落 workspace 媒体目录后以路径告知模型 +
 *   引用消息（ref_msg）摘要进 prompt 并把被引用消息的事件 cursor 作为 UserMessage.parentId（6c）→ submitInput
 *   （不 await：同好友连发靠 5.3a 内核队列串行，跨好友并行）。BOT 自发消息跳过防回环；群消息暂不接入。
 * - 出站：TurnStarted → typing；ToolCallStarted/Completed → TOOL_CALL_START/RESULT 进度 item（同 run_id=turnId，
 *   与官方参考实现同形，可关）；AssistantText 按 turn 累积；TurnCompleted → 取消 typing + FINISH 文本（超长切段）；
 *   TurnFailed → 简短错误提示。同一对端的所有发送串成一条链保证顺序。context_token 按对端缓存最近值回传。
 * - 授权门：allow 名单（机主 ownerUserId 恒过）；名单外发件人一次性提示（内存 Set 防刷屏）不进内核；
 *   配对码自助授权（6c）：陌生人发「配对 <码>」命中本次运行的配对码即落名单。
 */
import path from 'node:path';
import type { Kernel } from '@yo-agent/kernel';
import type { EventEnvelope, Id, PermissionMode } from '@yo-agent/protocol';
import type { FetchLike } from './api';
import { CDN_BASE_URL, DEFAULT_BASE_URL, getConfig, sendMessageItem, sendTyping } from './api';
import type { WeixinAccount } from './accounts';
import { addAllowFrom, defaultStateDir, loadAllowList } from './accounts';
import { isStageableMedia, mediaLabel, stageInboundMedia, type StagedMedia } from './media';
import type { MessageItem, WeixinMessage } from './types';

/** 微信单条文本上限未公开，按 2000 字保守切段。 */
const TEXT_CHUNK_LIMIT = 2000;
/** 消息 id → cursor 映射上限（每 surface；超出淘汰最早插入）。 */
const MSG_CURSOR_CAP = 2000;
/** 配对命令：「配对 <码>」或「/pair <码>」。 */
const PAIR_CMD_RE = /^\s*(?:配对|\/pair)\s+(\S+)\s*$/i;

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
  /** 6c：本次运行的配对码；陌生人发「配对 <码>」自助入名单。缺省不开。 */
  pairingCode?: string;
  /** 6c：入站媒体落地目录（应在内核会话 cwd 内，模型才能用 read 工具读到）；缺省 `<cwd>/.yo-agent/weixin-media`。 */
  mediaDir?: string;
  cdnBaseUrl?: string;
  /** 6c：工具进度 item（TOOL_CALL_START/RESULT）；缺省开。 */
  progressMessages?: boolean;
  fetchImpl?: FetchLike;
  log?: (msg: string) => void;
}

export class WeixinSurface {
  private readonly kernel: Kernel;
  private readonly account: WeixinAccount;
  private readonly stateDir: string;
  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly mediaDir: string;
  private readonly permissionMode: PermissionMode;
  private readonly allowAll: boolean;
  private readonly system?: string;
  private readonly pairingCode?: string;
  private readonly progressMessages: boolean;
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
  /** 本次运行内已记过日志的群（群消息暂不接入，只记一次）。 */
  private readonly groupNoted = new Set<string>();
  /** 对端 → 出站发送链（进度 item / 正文 / 切段严格按序）。 */
  private readonly sendChains = new Map<string, Promise<void>>();
  /** `${peer}:${微信消息id}` → 事件 cursor（入站 UserMessage / 出站回复所属 TurnCompleted），引用回复的 parentId 来源。 */
  private readonly msgCursors = new Map<string, number>();
  /** idemKey → 微信消息 id（TurnStarted.promptIdemKey 对账），再由 UserMessage 信封取 cursor。 */
  private readonly idemToMsg = new Map<string, string>();
  private readonly turnToMsg = new Map<string, string>();
  /** 工具调用 id → 工具名（ToolCallCompleted 不带 name）。 */
  private readonly toolNames = new Map<string, string>();
  private seq = 0;

  constructor(opts: WeixinSurfaceOpts) {
    this.kernel = opts.kernel;
    this.account = opts.account;
    this.stateDir = opts.stateDir ?? defaultStateDir();
    this.baseUrl = opts.account.baseUrl || DEFAULT_BASE_URL;
    this.cdnBaseUrl = opts.cdnBaseUrl ?? CDN_BASE_URL;
    this.mediaDir = opts.mediaDir ?? path.join(process.cwd(), '.yo-agent', 'weixin-media');
    this.permissionMode = opts.permissionMode ?? 'ci';
    this.allowAll = opts.allowAll ?? false;
    this.system = opts.system;
    this.pairingCode = opts.pairingCode?.trim() || undefined;
    this.progressMessages = opts.progressMessages ?? true;
    this.fetchImpl = opts.fetchImpl;
    this.log = opts.log ?? (() => {});
  }

  /** monitor 回调入口。 */
  async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type === 2) return; // BOT 侧消息（含本 bot 自发回显）防回环
    const peer = msg.from_user_id?.trim();
    if (!peer) return;
    if (msg.group_id) {
      // 群聊形态未实测（官方参考实现 groupPolicy=disabled，协议只有 group_id 字段）：不进内核，每群记一次日志。
      if (!this.groupNoted.has(msg.group_id)) {
        this.groupNoted.add(msg.group_id);
        this.log(`群消息暂不接入（group=${msg.group_id}，形态待实测），已跳过`);
      }
      return;
    }
    const items = msg.item_list ?? [];
    // 文本拼接：TEXT item + 语音转文字（服务端已转好直接可用）。
    const text = items
      .map((it) => (it.type === 1 ? (it.text_item?.text ?? '') : it.type === 3 ? (it.voice_item?.text ?? '') : ''))
      .filter((t) => t.trim())
      .join('\n');
    const mediaItems = items.filter(isStageableMedia);
    const refItem = items.find((it) => it.ref_msg);
    if (!text.trim() && mediaItems.length === 0) return; // 无可消费内容（仅引用/未知 item）

    if (msg.context_token) this.contextTokens.set(peer, msg.context_token);

    if (!this.isAllowed(peer)) {
      if (await this.tryPairing(peer, text)) return;
      await this.notifyDeniedOnce(peer);
      return;
    }

    // 媒体落地（授权之后才下载：陌生人的文件不落盘）。单个失败降级为提示，不拖累整条消息。
    const staged: Array<StagedMedia | { kind: 'failed'; label: string }> = [];
    for (const it of mediaItems) {
      try {
        const s = await stageInboundMedia(it, { dir: this.mediaDir, cdnBaseUrl: this.cdnBaseUrl, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
        if (s) staged.push(s);
      } catch (e) {
        const label = it.type === 2 ? '图片' : it.type === 5 ? '视频' : '文件';
        this.log(`${label}下载失败（peer=${peer}）：${e instanceof Error ? e.message : String(e)}`);
        staged.push({ kind: 'failed', label });
      }
    }

    if (!text.trim() && staged.length === 0) return; // 媒体 item 无可用引用（空壳）且无文本：不起 turn

    const sid = this.sessionIdFor(peer);
    await this.ensureSession(sid, peer);
    const wxId = messageIdOf(msg) ?? `${Date.now()}-${++this.seq}`;
    const idemKey = `wx-${wxId}`;
    const prompt = this.composePrompt(text, staged, refItem);
    const parentId = refItem ? this.refCursor(peer, refItem) : undefined;
    this.idemToMsg.set(idemKey, wxId);
    // 不 await turn 完成：收信循环不被单个 turn 阻塞；同会话排队由内核并发闸保证。
    void this.kernel
      .submitInput(sid, prompt, idemKey, parentId !== undefined ? { parentId } : undefined)
      .catch((e) => {
        this.log(`turn 提交失败（peer=${peer}）：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => this.idemToMsg.delete(idemKey));
  }

  /** 结束：摘全部订阅（会话本身留内核/store，可续）。 */
  dispose(): void {
    for (const { unsub } of this.sessions.values()) unsub();
    this.sessions.clear();
  }

  sessionIdFor(peer: string): Id {
    return `wx-${this.account.accountId}-${peer}`;
  }

  // ───────────────────────── 入站拼装 ─────────────────────────

  /** prompt = 引用块 + 正文 + 媒体落地提示（模型凭路径用工具读文件；图片本期无多模态，只告知收到与位置）。 */
  private composePrompt(text: string, staged: Array<StagedMedia | { kind: 'failed'; label: string }>, refItem?: MessageItem): string {
    const parts: string[] = [];
    const quote = refItem ? quoteSummary(refItem) : '';
    if (quote) parts.push(`> 用户引用了这条消息：${quote}`);
    if (text.trim()) parts.push(text);
    for (const s of staged) {
      if (s.kind === 'failed') {
        parts.push(`[用户发来一个${s.label}，但下载失败，无法查看——如需处理请让用户重发]`);
        continue;
      }
      const rel = displayPath(s.path);
      parts.push(
        s.kind === 'image'
          ? `[用户发来图片，已保存到 ${rel}（${fmtBytes(s.bytes)}）。当前模型不能直接看图；如需内容请让用户描述或改发文字/文件]`
          : `[用户发来${mediaLabel(s.kind)}「${s.name}」，已保存到 ${rel}（${fmtBytes(s.bytes)}）。文本类文件可用 read 工具读取]`,
      );
    }
    return parts.join('\n');
  }

  /** 引用消息 → 被引用消息（入站或本 bot 出站）在本会话的事件 cursor；对不上（重启前的历史/未缓存）→ undefined。 */
  private refCursor(peer: string, refItem: MessageItem): number | undefined {
    const ref = refItem.ref_msg;
    const id = ref?.svr_id?.trim() || ref?.message_item?.msg_id?.trim();
    return id ? this.msgCursors.get(`${peer}:${id}`) : undefined;
  }

  private rememberCursor(peer: string, wxId: string, cursor: number): void {
    const key = `${peer}:${wxId}`;
    this.msgCursors.delete(key);
    this.msgCursors.set(key, cursor);
    if (this.msgCursors.size > MSG_CURSOR_CAP) {
      const oldest = this.msgCursors.keys().next().value;
      if (oldest !== undefined) this.msgCursors.delete(oldest);
    }
  }

  // ───────────────────────── 授权门 ─────────────────────────

  private isAllowed(peer: string): boolean {
    if (this.allowAll) return true;
    if (peer === this.account.ownerUserId) return true;
    return loadAllowList(this.account.accountId, this.stateDir).includes(peer);
  }

  /** 配对命令：命中本次配对码 → 落名单并回执；码错 → 提示；非配对命令 → false 走常规拒绝提示。 */
  private async tryPairing(peer: string, text: string): Promise<boolean> {
    const m = PAIR_CMD_RE.exec(text);
    if (!m) return false;
    if (!this.pairingCode) {
      await this.sendText(peer, '本 bot 未开启配对码授权，请联系机主运行 allow 命令。').catch(() => {});
      return true;
    }
    if (m[1] !== this.pairingCode) {
      this.log(`配对码错误（peer=${peer}）`);
      await this.sendText(peer, '配对码不正确，请向机主确认后重发：配对 <码>').catch(() => {});
      return true;
    }
    addAllowFrom(this.account.accountId, peer, this.stateDir);
    this.deniedNotified.delete(peer);
    this.log(`配对成功：${peer} 已入授权名单`);
    await this.sendText(peer, '配对成功，已获得使用授权。直接发消息即可对话。').catch(() => {});
    return true;
  }

  private async notifyDeniedOnce(peer: string): Promise<void> {
    if (this.deniedNotified.has(peer)) return;
    this.deniedNotified.add(peer);
    this.log(`未授权发件人 ${peer}，已提示（授权：yoagent weixin allow ${this.account.accountId} ${peer}）`);
    const pairHint = this.pairingCode ? '\n或把机主告知的配对码发给我：配对 <码>' : '';
    await this.sendText(peer, `你还未获得使用授权。请机主运行以下命令后重试：\nyoagent weixin allow ${this.account.accountId} ${peer}${pairHint}`).catch(() => {});
  }

  // ───────────────────────── 会话与出站 ─────────────────────────

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
      const wxId = this.idemToMsg.get(e.promptIdemKey);
      if (wxId) this.turnToMsg.set(e.turnId, wxId);
      void this.setTyping(peer, 1);
      return;
    }
    if (e.kind === 'UserMessage' && env.turnId) {
      const wxId = this.turnToMsg.get(env.turnId);
      if (wxId) {
        this.rememberCursor(peer, wxId, env.cursor);
        this.turnToMsg.delete(env.turnId);
      }
      return;
    }
    if (e.kind === 'AssistantText' && env.turnId) {
      this.turnText.set(env.turnId, (this.turnText.get(env.turnId) ?? '') + e.delta);
      return;
    }
    if (e.kind === 'ToolCallStarted' && env.turnId && this.progressMessages) {
      this.toolNames.set(e.id, e.name);
      this.enqueueSend(peer, {
        item: { type: 11, create_time_ms: env.ts, is_completed: false, tool_call_start_item: { tool_name: e.name, tool_call_id: e.id } },
        runId: env.turnId,
        label: '工具进度',
      });
      return;
    }
    if (e.kind === 'ToolCallCompleted' && env.turnId && this.progressMessages) {
      const toolName = this.toolNames.get(e.id) ?? 'tool';
      this.toolNames.delete(e.id);
      this.enqueueSend(peer, {
        item: {
          type: 12,
          create_time_ms: env.ts,
          is_completed: true,
          tool_call_result_item: { tool_name: toolName, tool_call_id: e.id, status: e.status === 'ok' ? 'completed' : 'failed' },
        },
        runId: env.turnId,
        label: '工具进度',
      });
      return;
    }
    if (e.kind === 'TurnCompleted' && env.turnId) {
      const text = (this.turnText.get(env.turnId) ?? '').trim();
      this.turnText.delete(env.turnId);
      void this.setTyping(peer, 2);
      if (text) this.enqueueChunked(peer, text, env.turnId, env.cursor);
      return;
    }
    if (e.kind === 'TurnFailed' && env.turnId) {
      this.turnText.delete(env.turnId);
      this.turnToMsg.delete(env.turnId);
      void this.setTyping(peer, 2);
      this.enqueueSend(peer, { item: { type: 1, text_item: { text: '（本轮处理失败，请稍后重试）' } }, runId: env.turnId, label: '失败提示' });
    }
  }

  /** 正文按 2000 字切段，依次入链；服务端回的 message_id 记到该 turn 的 TurnCompleted cursor（对端引用 bot 回复时对账）。 */
  private enqueueChunked(peer: string, text: string, runId: string, cursor: number): void {
    for (let i = 0; i < text.length; i += TEXT_CHUNK_LIMIT) {
      this.enqueueSend(peer, { item: { type: 1, text_item: { text: text.slice(i, i + TEXT_CHUNK_LIMIT) } }, runId, label: '回复', cursor });
    }
  }

  /** 同一对端的发送串成一条链：进度 item、正文切段、失败提示严格按产生顺序出站；单次失败只记日志不断链。 */
  private enqueueSend(peer: string, req: { item: MessageItem; runId?: string; label: string; cursor?: number }): void {
    const prev = this.sendChains.get(peer) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const resp = await sendMessageItem({
          baseUrl: this.baseUrl,
          token: this.account.token,
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          to: peer,
          item: req.item,
          contextToken: this.contextTokens.get(peer),
          clientId: `yo-agent-${Date.now()}-${++this.seq}`,
          ...(req.runId ? { runId: req.runId } : {}),
        });
        if (req.cursor !== undefined && resp.message_id) this.rememberCursor(peer, String(resp.message_id), req.cursor);
      })
      .catch((e) => {
        this.log(`${req.label}发送失败（peer=${peer}）：${e instanceof Error ? e.message : String(e)}`);
      });
    this.sendChains.set(peer, next);
  }

  /** 直发文本（授权提示/配对回执等不属于某个 turn 的消息），同样走对端发送链。 */
  private sendText(peer: string, text: string): Promise<void> {
    this.enqueueSend(peer, { item: { type: 1, text_item: { text } }, label: '提示' });
    return this.sendChains.get(peer) ?? Promise.resolve();
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

// ───────────────────────── 纯函数 ─────────────────────────

/** 消息 id：顶层 message_id 优先，其次首个 item 的 msg_id（参考实现 getWeixinMessageId）。 */
export function messageIdOf(msg: WeixinMessage): string | undefined {
  const top = msg.message_id !== undefined ? String(msg.message_id).trim() : '';
  if (top) return top;
  for (const it of msg.item_list ?? []) {
    const id = it.msg_id?.trim();
    if (id) return id;
  }
  return undefined;
}

/** 引用摘要：title | 被引用 item 的文本/媒体标签；新客户端只给 svr_id 不带正文 → 「（内容未附带）」。 */
export function quoteSummary(item: MessageItem): string {
  const ref = item.ref_msg;
  if (!ref) return '';
  const parts: string[] = [];
  if (ref.title?.trim()) parts.push(ref.title.trim());
  const inner = ref.message_item;
  if (inner) {
    const body =
      inner.type === 1
        ? (inner.text_item?.text ?? '')
        : inner.type === 3
          ? (inner.voice_item?.text ?? '[语音]')
          : inner.type === 2
            ? '[图片]'
            : inner.type === 4
              ? `[文件${inner.file_item?.file_name ? `：${inner.file_item.file_name}` : ''}]`
              : inner.type === 5
                ? '[视频]'
                : '';
    if (body.trim() && body.trim() !== parts[0]) parts.push(body.trim());
  }
  if (parts.length === 0) return ref.svr_id ? '（内容未附带，仅有消息 id）' : '';
  return parts.join(' | ').slice(0, 500);
}

function displayPath(abs: string): string {
  const rel = path.relative(process.cwd(), abs);
  const chosen = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  return chosen.replace(/\\/g, '/');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
