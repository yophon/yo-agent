# 微信接入使用说明

把 yo-agent 变成你的微信 AI 助手：好友给你的 bot 发消息，agent 回答。走的是微信**官方** iLink Bot 协议（2026 年开放的 ClawBot 形态），合法接口，不是外挂协议，无封号包袱。

> 技术细节与协议研究见 [`research/weixin-ilink.md`](research/weixin-ilink.md)；实现交付报告见 [`PHASE-6.md`](PHASE-6.md)。本文只讲怎么用。

## 它是怎么工作的（30 秒版）

```
微信好友发消息 → 微信官方网关 → yoagent weixin run（跑在你电脑上的常驻进程）
→ agent 内核思考/调工具 → 回复发回微信（期间对方会看到「正在输入…」）
```

你的电脑就是服务器——进程开着才能收发消息，关掉就下线（消息不会丢，重新启动会从断点续收）。

## 准备工作（一次性）

**1. 安装命令**（要求 Node 22.5+、pnpm 10）：

```bash
cd <仓库目录>
pnpm install
pnpm run install:cli     # 之后任何目录都能用 yoagent
```

**2. 配置模型**——写进 `~/.config/yo-agent/config.env`（`yoagent` 启动时自动加载）：

```bash
mkdir -p ~/.config/yo-agent && chmod 700 ~/.config/yo-agent
cat >> ~/.config/yo-agent/config.env <<'EOF'
# 三选一：OpenAI / 中转站
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://你的中转站/v1     # 官方 OpenAI 可不填
YO_MODEL=gpt-5.5
# 或 Anthropic：ANTHROPIC_API_KEY=sk-...
# 或 Gemini：GEMINI_API_KEY=...

# 强烈建议：对话记忆持久化（跨重启不失忆）
YO_DB=~/.local/share/yo-agent/sessions.db

# 可选：bot 人设
YO_WEIXIN_SYSTEM=你是一个友善的微信助手，回复简洁口语化。
EOF
chmod 600 ~/.config/yo-agent/config.env
```

验证模型配置是否通：`yoagent -p "只回复两个字：OK"`。

**3. 扫码登录**：

```bash
yoagent weixin login
```

终端会显示二维码（显示不了会给备用链接），用微信扫码并在手机确认。如果手机端出现配对码，回终端输入即可。凭证保存在 `~/.yo-agent/weixin/`，之后不用重复登录。

## 日常使用

```bash
yoagent weixin run
```

进程常驻，日志打在终端，Ctrl+C 退出。**你本人（扫码者）自动有使用权限**，直接在微信里给 bot 发消息即可。

### 给朋友授权

默认对陌生人关门：名单外的人发消息，会收到一条自动回复，里面带着授权命令，模型不会被调用。授权方式：

```bash
yoagent weixin allow <账号ID> <用户ID>
```

账号 ID 在 `run` 启动日志里；用户 ID 在陌生人来信的日志和自动回复里都有。

更省事的方式是**配对码**：`run` 启动时会打印一个 6 位配对码（设 `YO_WEIXIN_PAIRING_CODE=xxxx` 可固定）。把码告诉朋友，他在微信里给 bot 发「配对 123456」即自动获得授权，不用你碰终端。陌生人收到的自动回复里也会提示这个用法。

想完全开放（**慎用**，谁都能烧你的 token）：

```bash
yoagent weixin run --allow-all
```

### 多个微信号

再跑一次 `yoagent weixin login` 扫另一个号即可，`run` 会同时服务所有已登录账号。

## 行为说明

| 你关心的 | 现状 |
| --- | --- |
| 记忆 | 每个好友一条独立对话线，配了 `YO_DB` 后跨重启保留 |
| 连发多条 | 自动排队逐条回答，不会串台 |
| 语音消息 | 收得了（用微信自带的语音转文字） |
| 图片/文件/视频 | 收得了：自动下载解密，存到 `run` 所在目录的 `.yo-agent/weixin-media/`（只保留最近 200 个，单个 25 MB 上限），并把路径告诉 agent。文本类文件（代码、CSV、日志…）agent 能直接读；**图片目前看不了内容**（模型多模态输入还没接），只知道「收到一张图、存在哪」 |
| 引用回复 | 你在微信里「引用」某条消息再提问，被引用的内容会一并给到 agent；引用关系也记进对话事件流 |
| 工具进度 | agent 调工具时微信端会看到「正在调用 xx 工具 / 已完成」的进度条目（和官方 ClawBot 一样）；不想看设 `YO_WEIXIN_PROGRESS=0` |
| 群聊 | 暂不响应（官方参考实现同样未开放群聊，协议形态未验证） |
| 超长回答 | 自动按 2000 字切成多条发送 |
| 安全 | 权限固定为最严档（ci）：agent 只能对话和用只读类工具，删文件、执行危险命令等待审操作一律自动拒绝 |

## 排障

| 现象 | 处理 |
| --- | --- |
| `command not found: yoagent` | 重跑 `pnpm run install:cli`；仍不行则检查提示的目录是否在 PATH |
| 终端提示「登录凭证已失效」 | 重新 `yoagent weixin login`（token 有寿命，属正常） |
| 收不到回复 | 看 `run` 的终端日志：有「turn 提交失败」多为模型配置问题（用 `yoagent -p "OK"` 单独验证）；完全无入站日志则检查手机端 bot 授权是否还在 |
| 网络抖动 | 自动重试（连续失败会退避 30 秒），无需干预 |
| 二维码过期 | 登录流程会自动刷新，重新扫即可 |
| 想清空某好友的对话记忆 | 目前删 `YO_DB` 数据库文件（会清掉全部会话）；按会话删除是控制台能力，后续打通 |
| 发了图片/文件没反应 | 看终端日志有无「下载失败」：CDN 下载需要本机能直连 `novac2c.cdn.weixin.qq.com`；超过 25 MB 的文件会被拒 |

## 安全须知

- **bot 以你的微信身份说话**。给朋友授权前想清楚：他们的提问会消耗你的模型 token，agent 的回答代表你的号。
- `~/.config/yo-agent/config.env`（模型 key）和 `~/.yo-agent/weixin/`（微信凭证）都是敏感文件，别提交进 git、别截图外发。
- 内容合规责任在运营者（你）。默认的 ci 权限档是底线保护，不建议在微信渠道放宽。
