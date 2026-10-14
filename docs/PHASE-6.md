# Phase 6 — 聊天平台接入：微信 iLink（6a/6b/6c 已交付）

> **状态：6a + 6b 已交付（2026-07-15）**——`@yo-agent/surface-weixin`（协议客户端 + 登录状态机 + monitor + 内核装配）
> + `yoagent weixin login|run|allow` 三命令；mock 网关 17 测试全绿。**真机验收已通过（2026-10-14，机主本人账号）。**
> **6c 已交付（2026-10-14）**：媒体入站 + 引用回复 parentId + 工具进度 item + 配对码自助授权，mock 网关 +11 测试（见下）；**真机验收同日通过**。协议研究与方案拍板见 [`research/weixin-ilink.md`](research/weixin-ilink.md)。
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

## 6c 媒体 + 引用 + 进度 + 配对（✅ 2026-10-14）

对照官方参考实现 Tencent/openclaw-weixin **v2.4.10**（2026-10-10）逐项核实后实施，两处与原规划不同，均按参考实现的真实形态收敛：

- **不用 GENERATING 流式**：参考实现全部出站消息均为 `FINISH`，工具进度以独立消息 + 同 `run_id` 关联，`GENERATING`/`NEW` 态在其代码里无任何写入点。客户端对 GENERATING 的渲染语义无从验证，照抄参考实现的形态最稳。
- **群聊继续不接**：参考实现 `groupPolicy: "disabled"`、入站 `ChatType` 恒 `"direct"`，协议仅有 `group_id` 字段无任何群语义文档。本实现对群消息每群记一次日志后跳过，形态待官方开放后再实测。

交付内容：

- **`src/cdn.ts`**：AES-128-ECB 加解密 + `parseAesKey`（线上两种形态：图片 base64(raw 16B)；文件/视频 base64(hex 串)）+ 下载（`full_url` 优先，否则 `<cdn>/download?encrypted_query_param=`；密文粗判 + 明文精判双重上限）。
- **`src/media.ts`**：入站图片/文件/视频落 workspace 媒体目录（缺省 `<cwd>/.yo-agent/weixin-media`，单文件 25 MiB、目录保留 200 个按 mtime 淘汰）；图片按魔数定扩展名；文件名安全化防 `../` 逃逸。语音不下载（服务端已转文字）。
- **types.ts / api.ts**：类型对齐参考实现 v2.4.10（ImageItem/CdnMedia/RefMessage/工具进度 item、`SendMessageResp.message_id`）；**uint64 消息 id 无损解析** `parseWeixinJson`（`message_id/msg_id/svr_id` 裸数字先引成字符串，字符串值内同名键不动）；`sendMessageItem` 通用单 item 发送 + `run_id`，非零 ret 抛错。
- **surface.ts**：
  - 入站 prompt = 引用块（`> 用户引用了这条消息：<title | 正文/媒体标签>`）+ 正文 + 媒体落地提示（图片明示「当前模型不能直接看图」；文件提示可用 read 读）。
  - **`ref_msg → parentId`**：surface 维护 `<peer>:<微信消息id> → cursor`（入站经 `TurnStarted.promptIdemKey → UserMessage` 信封记 cursor；出站用网关回的 `message_id` 记到该轮 `TurnCompleted` cursor），引用命中则 `submitInput(…, { parentId })`。内核 `submitInput/beginTurn` 增 `SubmitInputOpts.parentId`，只挂 UserMessage 信封、须指向本会话既有 cursor（越界降 null），排队 turn 随队列项带到起跑。
  - **工具进度**：`ToolCallStarted/Completed` → `TOOL_CALL_START/RESULT` item（`tool_name/tool_call_id/status completed|failed`），`run_id = turnId`；每对端一条发送链保证进度 → 正文 → 切段严格按序；`progressMessages:false`（CLI `YO_WEIXIN_PROGRESS=0`）可关。
  - **配对码**：`run` 每次生成 6 位码（`YO_WEIXIN_PAIRING_CODE` 固定）并打印；名单外发件人发「配对 <码>」/「/pair <码>」命中即 `addAllowFrom` + 回执，码错提示，命令本身不进内核；拒绝提示附配对引导。媒体只在授权之后才下载（陌生人的文件不落盘）。
- **测试 +11**（surface 5 / cdn 4 / api 2）+ kernel 1：图片解密落盘逐字节比对 + prompt 文案；文件 hex-key 形态 + 原名安全化 + 下载失败降级；引用用户消息/引用 bot 回复/对不上的引用三态 parentId；工具进度顺序与 run_id 一致 + 可关；配对码三态；uint64 无损；内核 parentId 越界/排队。

**未做、留 Phase 7**：多模态看图（provider 层图片输入）；出站媒体（`getuploadurl` + 缩略图双套参数 + 上传加密，内核暂无「发文件给用户」语义）；语音 SILK 转码（服务端转文字已够用）。

## 真机验收步骤（需机主手机，交付后人工执行）

```bash
pnpm run install:cli
yoagent weixin login                 # 终端出二维码，微信扫码确认（可能要求配对码）
export ANTHROPIC_API_KEY=...         # 或其他模型
export YO_DB=~/.local/share/yo-agent/sessions.db   # 会话跨重启续接
yoagent weixin run                   # 常驻；机主本人（扫码者）自动授权，直接发消息即可对话
# 别的好友要用：yoagent weixin allow <accountId> <userId>（陌生人首次来信会收到含此命令的提示）
```

验收点：机主发文本收到回复（带「正在输入」指示）；连发两条按序串行回答；重启 `run` 后继续对话上下文仍在（YO_DB）；陌生人收到授权提示且不触发模型调用。**（6a/6b 以上四项 2026-10-14 真机已通过。）**

6c 真机验收（**2026-10-14 机主真机已通过**）：发一张图片 → 终端日志无「下载失败」、`.yo-agent/weixin-media/` 出现 `.jpg/.png`、bot 回复提到已收到图；发一个 `.txt/.csv` 并让 bot 读内容 → 能复述；在微信里引用 bot 的某条回复提问 → bot 回答针对被引用内容；bot 调工具时微信端出现工具进度条目；用另一个号发「配对 <码>」→ 收到「配对成功」后可对话。

## 退出标准（6a+6b）

① mock 网关下：登录流全分支（confirmed/redirect/verifycode/expired）状态机测试通过；② monitor 游标持久/恢复、退避、-14 停机回调、abort 干净退出；③ surface 端到端（mock 网关 + FakeProvider）：好友文本 → 内核 turn → FINISH 回复带 context_token；同好友连发两条排队串行；名单外拒绝 + 提示一次；typing 起止；④ `yoagent weixin login/run/allow` 三命令接线（真机扫码验收需用户手机，留交付后人工步骤）；⑤ 全量 `pnpm run check` 零回归。
