# 微信 iLink Bot 协议研究（Tencent/openclaw-weixin）

> 研究日期：2026-07-15。目标：评估 yo-agent 如何接入微信官方聊天，作为 Phase 6 聊天平台接入的首选渠道（替代原规划的 QQ/OneBot 优先）。
> 参考实现已浅克隆核查源码：`github.com/Tencent/openclaw-weixin`（MIT，v2.4.6，5590 行 TS，依赖仅 qrcode-terminal + zod）。

## 一、这是什么

2026 年微信**官方**开放了个人号 Bot API（ClawBot 插件形态），底层协议叫 **iLink**，网关域名 `https://ilinkai.weixin.qq.com`（CDN：`novac2c.cdn.weixin.qq.com/c2c`）。`Tencent/openclaw-weixin` 是腾讯给 OpenClaw 平台写的官方渠道插件——**它同时是 iLink 协议的官方参考实现**，README 把后端 API 协议全文档化了，并明说「二次开发者若需对接自有后端，需实现以下接口」。

关键定性：这是**合法、官方、文档化**的接口，与历史上的 ipad 协议 / hook 类野路子有本质区别，无封号风险包袱。社区已有多个脱离 OpenClaw 直连 iLink 的实现（x1ah/wechat-ilink-demo、SiverKing/weixin-ClawBot-API 等），证明协议可独立消费。

## 二、协议形态（核查自源码 + README）

- **登录**：`GET ilink/bot/get_bot_qrcode?bot_type=3` 拿二维码 → 手机扫码确认 → 长轮询 `get_qrcode_status` 至 `confirmed`，返回 `bot_token` + `ilink_bot_id` +（可能的）`baseurl` IDC 重定向。支持 `need_verifycode` 配对码分支。token 落本地文件，支持多账号（`local_token_list` 复用）。
- **鉴权**：全部 `POST` JSON；`Authorization: Bearer <bot_token>` + `AuthorizationType: ilink_bot_token` + `X-WECHAT-UIN`（随机 uint32 base64）。`bot_agent` 字段自报应用名（纯观测，不参与鉴权/路由）。
- **收消息**：`getupdates` 长轮询，带同步游标 `get_updates_buf`（首次空串，响应回新游标）——**游标续接语义与 yo-agent EventLog cursor 同构**，断线不丢消息。服务端下发建议超时 `longpolling_timeout_ms`（~35s）。
- **发消息**：`sendmessage`，`item_list` 支持 TEXT/IMAGE/VOICE/FILE/VIDEO；**必须回传收到的 `context_token`**（会话上下文令牌）；`client_id` 幂等。
- **流式**：`message_state`（0 NEW / 1 GENERATING / 2 FINISH）+ `run_id`——bot 可以发生成中的进度消息再收尾，参考实现的 `WeixinReplyProgressSender` 用它推工具执行进度。
- **输入指示**：`getconfig` 拿 `typing_ticket` → `sendtyping`（1 正在输入 / 2 取消）。
- **媒体**：CDN 直传，AES-128-ECB 加密，`getuploadurl` 拿预签名参数，图片/视频需缩略图双套参数；语音 SILK 编码（参考实现用 silk-wasm）。
- **消息结构**：`from_user_id/to_user_id/session_id/create_time_ms/seq/message_id`，`ref_msg` 引用消息，`group_id` 字段存在（群场景待实测验证形态）。
- **错误**：`ret/errcode/errmsg`，`errcode -14` = 会话超时（token 失效需重登）。

## 三、接入方案对比（拍板：C 直连）

| 方案 | 做法 | 判定 |
| --- | --- | --- |
| A. 挂 OpenClaw 后面 | 装 OpenClaw + 官方插件，yo-agent 当其后端/工具 | **否决**。OpenClaw 是同类 agent runtime（本仓 research 已研究过其 SQLite-only 存储），yo-agent 会退化成它的附庸，双 runtime 叠床架屋 |
| B. 依赖插件包复用模块 | npm 依赖 `@tencent-weixin/openclaw-weixin`，用其 api/cdn/login 模块 | **否决**。深耦合 `openclaw/plugin-sdk`（peer dep、state dir、file lock 全是 OpenClaw 形制），拆不干净 |
| C. **自建 WeixinTransport 直连 iLink** | 按文档化协议自写客户端（fetch + node:crypto AES + qrcode-terminal），参考实现 MIT 对照抄关键细节 | **采纳**。协议就 5 个 HTTP 端点 + 登录流；正好兑现 DESIGN §7.1 的 Transport + Adapter 二层设计 |

## 四、与 yo-agent 既有架构的对位（惊人地齐整）

| iLink 侧 | yo-agent 侧 | 备注 |
| --- | --- | --- |
| `get_updates_buf` 游标续接 | EventLog cursor / resume 语义 | 同构，transport 崩溃重启不丢消息 |
| 消息涌入（同一用户连发多条） | **5.3a 内核 turn 队列** | 天然排队串行，Phase 6 的前置正是它 |
| `message_state GENERATING` + `run_id` | kernel AssistantText delta 流 | 节流聚合后推进度，TurnCompleted → FINISH |
| `sendtyping` | TurnStarted/TurnCompleted | turn 进行中挂输入指示 |
| `ref_msg` 引用消息 | `EventEnvelope.parentId`（5.3 预留） | Phase 6 reply 线程标注接点，正好兑现 |
| 配对码 / `allowFrom` 名单 | DESIGN Phase 6 「DM pairing + 配对码门禁」 | 参考实现的 pairing.ts 形制可直接对照 |
| 多账号 + per-account-channel-peer 会话隔离 | 每 (bot 账号, 对端) 映射一个 kernel 会话 | `agentProfile` 挂渠道标识，SQLite 持久 |
| `context_token` 回传 | ChatContext.target | Adapter 层透传 |

## 五、Phase 6 切片建议（微信优先，QQ/OneBot 顺延）

- **6a WeixinTransport 协议客户端**：login-qr（含配对码分支）+ token/账号存储（`~/.yo-agent/weixin/`）+ getupdates 长轮询循环（游标持久化）+ sendmessage 文本 + sendtyping + 错误重登（-14）。zod 校验，纯文本先行。可独立测试（mock 网关）。
- **6b ChatSurface 装配**：`yoagent weixin` 常驻子命令；UnifiedMessage 归一 → 会话映射 per (account, peer) → kernel（权限模式切 chat 态：ci/AlwaysConfirm + 配对码门禁）；流式 GENERATING 节流推送；turn 完成 FINISH；steer 语义（turn 进行中来消息 → 插话或排队，复用 5.3a 队列）。
- **6c 媒体与收口**：CDN AES-128-ECB 上传下载（图片先行，语音 SILK 后置）+ `ref_msg` → parentId 标注 + 群聊形态实测 + 真机端到端验收。

## 六、风险与注意

1. **协议未冻结**：官方插件对宿主版本卡得很严（2.0.x 要求 OpenClaw >=2026.3.22，启动检查拒载），说明协议仍在演进。自研客户端要盯上游 CHANGELOG；zod 校验宽容解析（未知字段放行）。
2. **常驻进程**：长轮询要求 transport 常驻，掉线重连 + 游标恢复必须做扎实（游标随账号文件持久）。
3. **`bot_agent` 自报**：按 README 规范报 `YoAgent/<version>`，便于官方后台归因（观测用，不影响功能）。
4. **登录态寿命未知**：token 失效（errcode -14）触发重新扫码的通知路径要设计（TUI 提示 / 日志醒目）。
5. **群聊形态未证实**：`group_id` 字段在协议里，但参考实现的主路径是私聊 + allowFrom；群语义（@ 触发、群级 persona）留 6c 实测再定。
6. **合规边界**：个人号 bot 官方开放，但内容责任在运营者；yo-agent 侧默认 chat 态收紧权限（AlwaysConfirm/ci）是底线。

## 附：参考实现关键文件索引（浅克隆核查过）

- 协议类型全集：`src/api/types.ts`；API 调用：`src/api/api.ts`（含 notifyStart/notifyStop、session-guard）
- 登录：`src/auth/login-qr.ts`（bot_type=3、IDC 重定向、verify_code）；账号存储：`src/auth/accounts.ts`；配对：`src/auth/pairing.ts`
- 长轮询：`src/monitor/monitor.ts`；入站归一：`src/messaging/inbound.ts`（context_token 存取）
- 流式进度：`src/messaging/reply-progress-sender.ts`（sendChain 串行 + 工具事件→进度消息）
- CDN：`src/cdn/upload.ts`（AES-128-ECB + 缩略图双套）
- 社区独立实现（佐证直连可行）：x1ah/wechat-ilink-demo、SiverKing/weixin-ClawBot-API、openilink.com
