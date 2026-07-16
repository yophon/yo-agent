# Phase 6 — 聊天平台接入：微信 iLink（6a/6b 已交付；6c 规划）

> **状态：6a + 6b 已交付（2026-07-15）**——`@yo-agent/surface-weixin`（协议客户端 + 登录状态机 + monitor + 内核装配）
> + `yoagent weixin login|run|allow` 三命令；mock 网关 17 测试全绿（退出标准 ①②③⑤ 达成；④ 真机扫码为交付后人工步骤，
> 见文末「真机验收步骤」）。协议研究与方案拍板见 [`research/weixin-ilink.md`](research/weixin-ilink.md)。
> 渠道顺序调整：微信优先（官方 iLink Bot API 已开放、协议文档化），QQ/OneBot、Telegram 顺延。

## 拍板回顾（详见 research 文档）

- **直连 iLink 自建 `@yo-agent/surface-weixin`**，否决挂 OpenClaw / 依赖其插件包两案。
- 依赖极小：fetch（Node 内置）+ qrcode-terminal（登录二维码渲染，本地 `vendor.d.ts` 补类型）。
- 5.3a 内核 turn 队列是本期前置（同一好友连发多条消息天然排队串行）；`ref_msg → parentId` 标注留 6c。

## 6a WeixinTransport 协议客户端（本期实施）

- **`src/types.ts`**：iLink 协议类型（照参考实现 `src/api/types.ts` 裁剪：WeixinMessage/MessageItem/收发五端点 Req/Resp/枚举）。解析宽容：未知字段放行、可选字段全 `?`（协议未冻结，见 research 风险 1）。
- **`src/api.ts`**：HTTP 客户端。请求头 `AuthorizationType: ilink_bot_token` + `Authorization: Bearer` + `X-WECHAT-UIN`（随机 uint32 十进制串 base64）+ `iLink-App-Id: bot` + `iLink-App-ClientVersion`（0x00MMNNPP）。每请求带 `base_info: { channel_version, bot_agent: 'YoAgent/<version>' }`。端点：`ilink/bot/getupdates | sendmessage | getconfig | sendtyping | msg/notifystart | msg/notifystop`。**`fetchImpl` 可注入**（测试 mock 网关不走真网络）。长轮询客户端超时返回空响应（正常控制流），外部 AbortSignal 立即取消在飞请求。
- **`src/login.ts`**：扫码登录——`POST ilink/bot/get_bot_qrcode?bot_type=3`（带 `local_token_list` 复用旧登录）→ qrcode-terminal 渲染 `qrcode_img_content` + 备用链接 → 长轮询 `GET get_qrcode_status`：`confirmed`（拿 bot_token/ilink_bot_id/baseurl/扫码者 ilink_user_id）/ `scaned_but_redirect`（切 redirect_host 续轮询）/ `need_verifycode`（stdin 读配对码回传）/ `expired`（刷新二维码重展示）/ `binded_redirect`（已绑定视为成功）。
- **`src/accounts.ts`**：账号落 `~/.yo-agent/weixin/accounts.json`（token/baseUrl/ilinkUserId/createdAt，多账号数组）；同步游标 `<accountId>.syncbuf` 独立文件（每轮 getupdates 后落盘——进程崩溃重启不丢消息）；授权名单 `<accountId>.allow.json`。
- **`src/monitor.ts`**：长轮询循环——游标恢复 → getupdates（服务端建议超时跟随）→ 消息逐条回调 → 游标落盘。错误退避：连败 <3 次 2s、≥3 次 30s；`errcode -14`（token 失效）停循环并回调 `onStaleToken`（提示重新扫码）。AbortSignal 全链贯通。

## 6b WeixinSurface 接内核（本期实施）

- **会话映射**：每 `(bot 账号, 对端 from_user_id)` 一个内核会话，**确定性 sessionId** `wx-<accountId>-<peerId>`——配 `YO_DB` 时跨进程重启 `resumeSession` 直接续上（内核既有能力，零新机制）。
- **入站**：TEXT item 拼接 → `submitInput`（5.3a 队列天然防并发交错；多好友多会话本就并行）。BOT 自发消息（`message_type=2`）跳过防回环。
- **出站**：`TurnStarted` → `sendtyping(TYPING)`（getconfig 拿 typing_ticket，按会话缓存）；累积该 turn 的 `AssistantText` delta；`TurnCompleted` → 取消 typing + 发 FINISH 文本（超长按 ~2000 字切段）；`TurnFailed` → 发简短错误提示。`context_token` 按对端缓存最近值回传。流式 `GENERATING` 进度与 `TOOL_CALL_START/RESULT` item（协议原生支持）留 6c 真机验证后再接。
- **授权门（DM pairing 简化档）**：`allow.json` 名单——名单外发件人收到一次性提示（含其 ID 与授权命令），不进内核；`yoagent weixin allow <accountId> <userId>` 落名单；扫码者本人（登录时返回的 `ilink_user_id`）自动入名单。每次运行对同一陌生人只提示一次（内存 Set 防刷屏）。
- **权限模式**：会话固定 `permissionMode: 'ci'`（无人值守：默认拒绝待审操作）——聊天渠道无交互审批通道，宽松档后置到有配对身份体系之后（DESIGN Phase 6 原案）。
- **CLI**：`yoagent weixin login`（扫码）/ `yoagent weixin run`（常驻：buildKernel + 全账号 monitor 并行，notifystart/notifystop 生命周期上报）/ `yoagent weixin allow <accountId> <userId>`。`Mode` 增 `'weixin'`；常驻异常兜底与 rpc/acp 同段。

## 6c（下期）：媒体 + 流式 + 群 + parentId

- CDN AES-128-ECB 上传下载（图片先行，语音 SILK 后置）；`GENERATING` 流式进度节流 + tool-call item；群聊（`group_id`）形态实测；`ref_msg` → `EventEnvelope.parentId` 标注（doEmit 签名扩展，5.3 预留接点）；配对码换 allow 命令的自助化。

## 真机验收步骤（需机主手机，交付后人工执行）

```bash
pnpm run install:cli
yoagent weixin login                 # 终端出二维码，微信扫码确认（可能要求配对码）
export ANTHROPIC_API_KEY=...         # 或其他模型
export YO_DB=~/.local/share/yo-agent/sessions.db   # 会话跨重启续接
yoagent weixin run                   # 常驻；机主本人（扫码者）自动授权，直接发消息即可对话
# 别的好友要用：yoagent weixin allow <accountId> <userId>（陌生人首次来信会收到含此命令的提示）
```

验收点：机主发文本收到回复（带「正在输入」指示）；连发两条按序串行回答；重启 `run` 后继续对话上下文仍在（YO_DB）；陌生人收到授权提示且不触发模型调用。

## 退出标准（6a+6b）

① mock 网关下：登录流全分支（confirmed/redirect/verifycode/expired）状态机测试通过；② monitor 游标持久/恢复、退避、-14 停机回调、abort 干净退出；③ surface 端到端（mock 网关 + FakeProvider）：好友文本 → 内核 turn → FINISH 回复带 context_token；同好友连发两条排队串行；名单外拒绝 + 提示一次；typing 起止；④ `yoagent weixin login/run/allow` 三命令接线（真机扫码验收需用户手机，留交付后人工步骤）；⑤ 全量 `pnpm run check` 零回归。
