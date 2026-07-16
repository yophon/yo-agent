/**
 * 微信 iLink Bot 协议类型（Phase 6a）——照官方参考实现 Tencent/openclaw-weixin `src/api/types.ts`
 * 裁剪至本期用面（文本收发 + typing + 生命周期 + 登录），媒体/工具进度 item 类型保留形状供 6c。
 * 解析宽容原则（research/weixin-ilink.md 风险 1：协议未冻结）：全部字段可选、未知字段放行，不做严格 schema 拒绝。
 */

/** 每请求自报元信息（类 HTTP User-Agent，仅观测不参与鉴权/路由）。 */
export interface BaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

/** 消息生成态：流式进度（GENERATING）与收尾（FINISH），6b 只发 FINISH。 */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

/** token 失效（会话超时）错误码：monitor 停循环并要求重新扫码。 */
export const STALE_TOKEN_ERRCODE = -14;

export interface MessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  /** 媒体/引用/工具进度 item：6b 不消费，保留透传形状（6c 接）。 */
  image_item?: Record<string, unknown>;
  voice_item?: { text?: string } & Record<string, unknown>;
  file_item?: Record<string, unknown>;
  video_item?: Record<string, unknown>;
  ref_msg?: Record<string, unknown>;
  tool_call_start_item?: { tool_name?: string; tool_call_id?: string };
  tool_call_result_item?: { tool_name?: string; tool_call_id?: string; status?: string };
}

/** 统一消息（proto: WeixinMessage）。 */
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  /** 会话上下文令牌：入站收到后，出站回复必须回传。 */
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  /** 服务端错误码（-14 = token 失效）。 */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** 同步游标：本地持久化，下次请求回传（断线续接）。 */
  get_updates_buf?: string;
  /** 服务端建议的下次长轮询超时（ms）。 */
  longpolling_timeout_ms?: number;
}

export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  /** base64 typing ticket（sendtyping 用）。 */
  typing_ticket?: string;
}

// ───────────────────────── 登录流 ─────────────────────────

export interface QrCodeResp {
  /** 二维码标识（轮询 get_qrcode_status 用）。 */
  qrcode?: string;
  /** 二维码内容 URL（终端渲染 + 备用链接）。 */
  qrcode_img_content?: string;
}

export type QrLoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface QrStatusResp {
  status?: QrLoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  /** 登录后的 API base（IDC 分配），落账号文件。 */
  baseurl?: string;
  /** 扫码者的用户 ID：自动进 allow 名单。 */
  ilink_user_id?: string;
  /** scaned_but_redirect 时切换轮询的新 host。 */
  redirect_host?: string;
}
