# AI Agent 领域四个月变化速览（2026-06 → 2026-10）

> 调研日期：2026-10-14。目的：对照 2026-06 的竞品研究（`_LANDSCAPE.md`），找出 yo-agent 设计需要重新审视的点。
> 标注约定：**[官方]** = 厂商/项目一手来源；**[二手]** = 博客/聚合站，日期与版本号可能有偏差；**[存疑]** = 多来源冲突或仅单一来源。

## 1. "个人 agent" 为什么突然热

- **OpenClaw 是引爆点**。Peter Steinberger 的项目从 Warelay（2025-11-24）→ Clawdbot → Moltbot → OpenClaw（2026-01-30），2026-03 GitHub 已 247k stars；作者 2026-02-14 加入 OpenAI，项目交 OpenClaw Foundation 托管。**2.0（v2026.8.1，2026-08-30）** 带来一键安装、新 UI、浏览器应用、共享云会话。[官方/维基] https://en.wikipedia.org/wiki/OpenClaw
- **形态已定型**：常驻 Node 服务（gateway）+ 多消息渠道（WhatsApp/Telegram/Discord/Signal/微信/QQ）+ 本地纯文件记忆 + `SKILL.md` 技能目录 + cron/提醒/后台任务；用户买 Mac mini 专门跑它。[二手] https://abvcreative.medium.com/openclaw-the-moment-personal-agents-stopped-being-a-hobby-2dceb7a4fbcc
- **大厂跟进**：NVIDIA NemoClaw（GTC 2026，OpenShell 运行时）、微软内部 "ClawPilot"、Google "Remy"（[存疑]，仅维基转述）、腾讯与智谱推出 OpenClaw 衍生服务；中国 2026-03 限制国企/政府机关办公机运行 OpenClaw。
- **DeepSeek Harness（dsh）**：deepseek-ai 开源的 MIT 协议 agent runtime，"everything is a plugin"（基于 Cordis），developer preview、约 249k stars、无正式 release，插件生态覆盖渠道（微信/QQ/钉钉/飞书/Telegram）、记忆（OpenViking）、子 agent 侧栏等。[官方] https://github.com/deepseek-ai/deepseek-harness
- **Anthropic/OpenAI 的"个人 agent"答案**：Claude Cowork（2026-01-12 预览）、Claude Code Channels（2026-03-20，Telegram/Discord/iMessage，每个渠道是一个 MCP server 插件 + 发送者白名单）、Remote Control 正式版、Routines（cron/webhook/API 触发）、后台会话 `claude attach/logs`；OpenAI 则把 Codex harness 做成云端 **Agents API**（2026-09-10 公测，durable sessions）。[二手] https://claudefa.st/blog/guide/development/claude-code-channels ；[官方] https://developers.openai.com/api/docs/guides/agents-api/overview
- 原因归纳：模型能跑长程任务了（§6）、消息平台主动开放 bot 能力（§7）、"自己的机器 + 自己的文件 + 24h 在线"这一形态被 OpenClaw 验证，随即被安全事故（§9）倒逼成熟。

## 2. pi（pi-mono / pi coding agent）

- **归属变化**：2026-04 被 Earendil（Armin Ronacher、Colin Hanna 创立）收购；npm 包 2026-05 迁至 `@earendil-works/pi-coding-agent`，旧包弃用。[二手] https://www.npmjs.com/package/@mariozechner/pi-coding-agent
- **0.99.0（2026-09-29）：接入 MCP**（stdio + Streamable HTTP + OAuth），并引入 **codemode**（模型写 JS 在 QuickJS 沙箱里调用工具）和 tool search；0.99.2 MCP 工具名 `-`→`_`（破坏性）。[官方 CHANGELOG] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md
- **1.0.0（2026-10-01）**：全屏 TUI 默认、codemode 提示词瘦身 40%、per-server OAuth 凭据、延迟工具加载、Anthropic cache warming、虚拟模型 extension、对话中途 system message。1.0.1 支持 Client ID Metadata Document（对齐 MCP 新 auth）。1.1.0（10-07）、1.2.0（10-12，主题 schema 与 `before_agent_start` 事件破坏性变更）。Unreleased：删除实验性 server/client/plugin 包。[官方 CHANGELOG 同上]；[二手] https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678
- **Extensions 演进**：0.86 `pi.on()` 可退订、`ctx.modelRegistry.stream()`；0.87 `finishTurn` 取代 `shouldStopAfterTurn`、`context_with_system`、`SessionManager` 成为 provider 上下文唯一来源；0.99 `ctx.executeTool()`、工具暴露控制。
- **子 agent 仍不进核心**（靠 tmux/extension/第三方 `pi-subagents`）；Earendil 另发 **Pi Durable**（长时运行 agent 框架，刻意与 pi 分离）。

## 3. Claude Code / Agent SDK / Managed Agents

- **节奏**：6 月 v2.1.170 → 10-14 v2.1.299，约 130 个版本。[官方] https://code.claude.com/docs/en/changelog
- **权限**：Auto mode（分类器判定每个动作）2026-08-14 对新会话默认，2.1.284（09-28）起所有交互会话默认；hooks 增至 33 个事件（6 月 27 个），2.1.295 `onFailure: "block"` 使 hook 崩溃/超时即拦截（fail-closed）。
- **子 agent**：7 月起默认后台运行、嵌套 3 层、并发 20；fork 默认开启并继承父权限模式；Agent 工具得到 `effort` 参数（2.1.292）、`autoCompactWindow`（2.1.296）；每个子 agent 最多预载 32 个 skills；恢复的子 agent 不再改工具列表/系统提示（保 prompt cache）。**Dynamic workflows**（05-28 研究预览）：模型写 JS 脚本编排数百个 agent，存 `.claude/workflows/`。8 月跨会话 `SendMessage`。[二手] https://angelo-lima.fr/en/claude-code-cheatsheet-october-2026-state-of-play-en/
- **Mods（2.1.287，10-01）**：插件可用 JS/TS 在进程内改行为——加面板、拦截工具调用、`$.tool.register({isDeferred})`、`agent.spawn`、`$.model.complete` 带 prompt cache。Skills：`/skill-doctor` 统计未用 skill 的上下文开销、claude.ai skills/plugins 同步（2.1.275）、`/import` 导入 Codex/Gemini/Cursor 配置。
- **MCP**：2026-07-28 协议成为默认（本地 stdio 2.1.292、connector 2.1.295、云会话 2.1.299）；`alwaysLoad:false` 把整个 server 推到 tool search 之后。
- **上下文/记忆**：Auto memory（2.1.59，2 月，`MEMORY.md` 索引 + 主题文件）；2.1.299 **idle compaction**（200K+ 对话闲置 54 分钟自动压缩，赶在 1 小时 cache 过期前）；Opus 4.7+ 在 Bedrock/Vertex/Foundry 默认 1M 上下文。TodoWrite/Task* 工具对新模型默认移除。
- **远程/云**：Remote Control 正式版、Desktop Linux beta、自托管 cloud environment（Team/Enterprise beta）、Routines（cron/GitHub webhook/API endpoint，Code with Claude 2026-05-06 发布）、Projects beta（09-17，协调者分发并行云线程）。[二手] https://www.infoq.com/news/2026/05/code-with-claude/
- **Agent SDK**：仍 0.3.x（0.3.289 约 10-03）；权限模式改为跟随 Claude Code settings；子 agent 嵌套默认 1 层、并发上限 20；10-07 新增 browser use / computer use 工具集（beta）。6 月传"SDK/headless 用量改走独立额度"，多来源冲突 [存疑]。[官方] https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- **Managed Agents**：04-08 公测（REST：agent loop + 工具执行 + 沙箱 + 状态持久化，$0.08/活跃小时）；5 月自托管沙箱、Vault 环境变量凭据、cron 调度；**10-09 dynamic workflows beta**（`multiagent_20261001`，第三方称 64 并发线程/1000 agent 上限 [存疑]）；10-07 `web_fetch/web_search` 遵守 `allowed_hosts`，`web_fetch` 只允许会话中出现过的 URL。"Dreaming"记忆巩固研究预览（5 月）仅维基转述 [存疑]。[二手] https://releasebot.io/updates/anthropic

## 4. 其他 coding agent 的大事

- **Codex CLI**：0.159.0（09-29）大改版——全屏 UI、`/agents` 看并行任务、`/fork` 开独立 worktree、`/app` 把线程交给桌面端、`instant_interrupt` 中途插话；0.162.0（10-08）托管 worktree、压缩/tool search 选项。**Agents API（09-10 公测）**：云端 Codex harness，durable session、环境模式 none/openai_hosted/self-hosted（`codex exec-server` over WebSocket，合作方 Cloudflare/Daytona/E2B/Modal/Vercel）、子 agent（`multi_agent` 并发上限）、压缩、中途 steering；09-29 加 computer use。[官方] https://developers.openai.com/api/docs/changelog
- **OpenHands**：1.0（2025-12-16）已重建在 Software Agent SDK 上，2026 主推 **Agent Canvas**（自托管多 agent 工作台），SDK v1.54.0（10-09）；旧 GUI/CLI 标 legacy。[官方] https://github.com/OpenHands/software-agent-sdk/releases
- **OpenCode**：仓库迁 `anomalyco/opencode`，1.18.x（09-21）与 2.0.x 并行，209k stars；1 月起不能再用 Claude Pro/Max 登录。[二手] https://www.morphllm.com/comparisons/opencode-vs-goose
- **Gemini CLI**：I/O（05-19）宣布，**06-18 对个人用户停服**，由闭源 Go 实现的 **Antigravity CLI** 接替（保留 skills/hooks/subagents/extensions，功能不完全对等）；企业用户保留。[官方] https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- **Goose**：4 月移交 Linux Foundation AAIF（`aaif-goose/goose`），v1.51.0（09-17）。**Cline**：活跃，VS Code/JetBrains/CLI/macOS 应用/SDK 全家桶 + ClinePass 订阅。**Roo Code**：2026-05-15 最后发布后归档。**Aider**：05-22 后无提交，PyPI 停在 0.86.2（02-12），事实停滞。[二手] https://baeseokjae.github.io/posts/open-source-ai-coding-agents-2026/

## 5. 协议层

- **MCP 2026-07-28（重大改版）** [官方] https://modelcontextprotocol.io/specification/2026-07-28/changelog
  - 去状态化：删除 `initialize` 握手与 `Mcp-Session-Id`，每个请求在 `_meta` 携带协议版本/能力/clientInfo；新增必须实现的 `server/discover`。
  - **MRTR**（Multi Round-Trip Requests）取代 server 发起的 `elicitation/create`、`sampling/createMessage`、`roots/list`：server 返回 `resultType:"input_required"`，client 带 `inputResponses` 重试；所有结果必须有 `resultType`。
  - Streamable HTTP：去掉 GET 端点与 SSE 断线续传；`subscriptions/listen` 单长流承载 listChanged 通知；POST 必须带 `Mcp-Method`/`Mcp-Name` 头（便于网关路由）；list 结果要带 `ttlMs`/`cacheScope`；工具列表应稳定排序（提升 prompt cache 命中）。
  - **Tasks 移出核心成为扩展** `io.modelcontextprotocol/tasks`（`tasks/get` 轮询 + `tasks/update`，删 `tasks/list`）；`extensions` 能力字段；OpenTelemetry trace 透传。
  - 弃用：Roots、Sampling、Logging、HTTP+SSE、DCR（改用 **Client ID Metadata Documents**）；12 个月弃用窗口与弃用注册表。
- **ACP（Agent Client Protocol）**：01-28 Zed+JetBrains 注册表；v1 稳定、Rust/TS SDK 1.0（TS 1.4.0）；**v2 Draft（2026-07-20）**：prompt 响应只返回 `messageId`、turn 与响应解耦，消息/工具调用/终端输出按稳定 ID 增量 patch，结构化文件变更替代 oldText/newText，权限请求带 `title/description/subject`，idle 信号、流式工具内容、`git_patch`、未知枚举 `_` 前缀前向兼容；要求 v1/v2 并行。[官方] https://agentclientprotocol.com/announcements/acp-v2-draft
- **A2A**：1.0（LF 2026-04-09 通稿，150+ 组织，签名 Agent Card、多租户、`A2A-Version` 头）、1.0.1（5 月，扩展机制）；9–10 月无新版本。[官方] https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- **新冒出的"agent 间/agent 与宿主"接口**：Telegram bot-to-bot（§7）、Claude Code 跨会话 `SendMessage`、OpenAI Agents API 的 session/steer 模型、Pi Durable；"Agent Control Protocol"（github agent-control-protocol/acp）[存疑，未核实活跃度]。真正收敛的是 **code mode / programmatic tool calling**：Cloudflare（2 月）、Anthropic PTC + Tool Search、OpenAI `programmatic_tool_calling`（GPT-5.6，07-09）、pi codemode。[官方] https://blog.cloudflare.com/code-mode-mcp/

## 6. 模型层对 runtime 的影响

- **Claude**：Sonnet 5（06-30，$2/$10，effort 到 xhigh，手动 `budget_tokens` 报错）[官方] https://www.anthropic.com/news/claude-sonnet-5 ；Opus 5（07-24，$5/$25）[二手]；Opus 5.5（09-22，$4/$20）[二手]；**Sonnet 5.5（09-28）**：effort 五档 Low→Max（Claude Code 默认 Medium，平台默认 High），更多批量工具调用，OSWorld 2.1 80.1%，Terminal-Bench 4.0 70.6%，"preserved thinking" 绑定账号，高危网安请求回落到 Sonnet 5 [官方] https://www.anthropic.com/claude-sonnet-5-5 ；**Haiku 5.5（10-07）**：1M 上下文/128K 输出，`budget_tokens`/`temperature`/`top_p`/prefill 全部 400。平台侧：server 端 compaction（`compact_20260112`）、context editing、memory tool GA、tool search。[官方] https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
- **OpenAI**：GPT-5.5（04-24，1M、tool search、hosted shell、apply_patch、skills、MCP）；GPT-5.6 Sol/Terra/Luna（07-09：programmatic tool calling、显式 prompt cache 控制、persisted reasoning、`max` effort、多 agent 编排 beta）；**GPT-6 Astra（09-03）**：工具调用只走 Responses API，不支持 `none` effort/temperature/logprobs，新增异步工具调用、WebSocket 中途 steering、对话中途改 effort；GPT-6 Sol/Luna（09-22）、GPT-6.1 Sol（09-29，多 agent）；Assistants API 08-26 关停。[官方] https://developers.openai.com/api/docs/changelog
- **Gemini**：3.6 Flash（7–8 月，3.5-flash 自动路由过去）、**3.8 Flash GA（09-02，定位长程编码/自治 agent）**、3.8 Live；Thought Signatures 做有状态工具调用；3.5 Pro 截至 7 月仍未发 [存疑]。[官方] https://ai.google.dev/gemini-api/docs/changelog
- **DeepSeek V4 Preview（04-24）**：V4-Pro 1.6T/49B 激活、V4-Flash，1M 上下文，**有工具调用时跨轮保留推理内容**，XML 风格 tool-call 格式减少转义失败。[官方] https://api-docs.deepseek.com/news/news260424/
- 共同趋势：effort 取代 thinking budget；temperature 等采样参数被禁；推理内容跨轮持久化；server 端状态/压缩；1M 上下文成标配；computer use 进入 SDK。

## 7. 聊天平台接入

- **微信 iLink/ClawBot**：2026-03-22/23 腾讯官方发布 `@tencent-weixin/openclaw-weixin` v1.0.2，域名 `ilinkai.weixin.qq.com`，HTTP/JSON（`get_bot_qrcode`/`getupdates` 长轮询/`sendmessage`），不能主动推送、腾讯保留限速/终止权。生态：`ilink-hub`（一号多 agent 复用）、`wechat-clawbot` Python SDK（跟进上游 v2.1.1）、`cc-weixin`、dsh 插件。**9–10 月未找到官方更新**。[二手] https://www.bytenote.net/article/wechat-ilink-bot-api ；https://github.com/jeffkit/ilink-hub
- **QQ/钉钉/飞书**：QQ 开放平台提供 OpenClaw 专属登录页与官方插件 `@tencent-connect/openclaw-qqbot`；钉钉开放平台"一键创建 OpenClaw 机器人"（`@dingtalk-real-ai/dingtalk-connector`）；飞书是 OpenClaw 内置插件（需开放平台事件订阅）；社区 `openclaw-china`、Satori 通道插件。[二手] https://developer.aliyun.com/article/1712479 ；https://github.com/BytePioneer-AI/openclaw-china
- **Telegram**：Bot API 9.5（3 月）全场景流式输出；**05-07**：Guest AI Bots（任意群内 @ 召唤，仅见被 @ 消息）、**bot-to-bot 通信**（双方 opt-in）、用户把 bot 绑到个人资料代答（"秘书 bot"）。[官方] https://telegram.org/blog/ai-bot-revolution-11-new-features

## 8. 记忆与上下文

- 主流做法从"向量 RAG"转向 **模型自管的文件记忆 + server 端压缩**：Claude memory tool（文件 CRUD，GA）、Claude Code auto memory（`MEMORY.md` 索引前 200 行/25KB 常驻，主题文件按需读）、OpenClaw 纯文本记忆；Letta 3 月起退役 server 端记忆工具，改 git 托管记忆文件 [二手] https://www.braintrust.dev/articles/best-ai-agent-memory-tools-2026
- 压缩层：Anthropic compaction/context editing、OpenAI Responses server 端状态与 remote compaction、Claude Code idle compaction 与子 agent `autoCompactWindow`。
- 记忆巩固（"Dreaming"/autoDream）出现在 Managed Agents 预览 [存疑]。MCP 记忆服务（Mem0 OpenMemory、Supermemory、Cognee、Zep/Graphiti）仍是可插拔补充。[官方] https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool

## 9. 安全与沙箱

- **事故推动**：OpenClaw CVE-2026-25253 容器逃逸、Docker socket 被挂进容器、ClawHub 1,184 个恶意 skill（安天）、135k 公网裸露实例（SecurityScorecard）[二手，数字未独立核实]；2.0 仍无网络/文件系统边界、Secret Store 未加密（The Register）。[二手] https://arxiv.org/pdf/2603.27517 ；https://blog.cyberdesserts.com/ai-agent-security-risks/
- **主流方案收敛为 microVM**：NanoClaw + Docker Sandboxes、微软 AKS Kata、NVIDIA OpenShell（K3s，内核级网络白名单，3 月起 alpha）、Vercel 沙箱逃逸赏金（08-18→09-01）；原则：不可信代码跑 microVM，**agent loop 与密钥留在沙箱外**，出口流量白名单。[二手] https://thenewstack.io/nanoclaw-docker-sandboxes-ai-agents/ ；https://techcommunity.microsoft.com/blog/coreinfrastructureandsecurityblog/hardening-openclaw-on-aks-mitigating-container-escapes-with-kata-microvm-isolati/4516030
- **权限模型**：Claude Code 分类器驱动的 auto mode 成默认、hooks fail-closed、`--bare` 最小化连接、管理员强制沙箱设置不可被项目覆盖；Managed Agents 网络 `allowed_hosts` 作用到 web 工具；Gemini/Antigravity CLI 强化 prompt-injection 防御；学界提出确定性 pre-action 授权（arXiv 2603.20953）。

## 对 yo-agent 的启示（按重要性）

1. **MCP 2026-07-28 双栈**：yo-agent 的 MCP server 与 client 都要支持无握手、`server/discover`、`resultType`、MRTR（elicitation 不再是 server 主动请求）、`Mcp-Method/Mcp-Name` 头、`ttlMs`；Roots/Sampling 应停止依赖；Tasks 按扩展实现。这是 10 月各主流客户端已默认的协议，不做就会被新 server 拒绝。
2. **延迟工具加载 + code mode**：tool search / `isDeferred` 和"模型写代码调工具"已成 pi、Claude、OpenAI 三家共识；yo-agent 工具注册表需要 deferred 标记与一个 codemode 执行工具，否则 MCP 工具数量一上来上下文就爆。
3. **provider 抽象要显式建模 effort 与 steering**：5.x/GPT-6 禁用 `budget_tokens`/temperature、要求 Responses API、支持中途改 effort 与插话；yo-agent 的 provider 接口与 Agent 工具应把 effort 作为一等参数，并有 Responses API 路径。
4. **压缩下沉到 provider 与事件流**：server 端 compaction/context editing、idle compaction、子 agent 独立压缩窗口；append-only 事件流需定义 compaction 事件并允许由 provider 产生摘要，而不是只在内核做。
5. **权限闸门 fail-closed + 沙箱边界**：hook 失败即拦截、分类器式自动审批、agent loop 与密钥在沙箱外、出口白名单——yo-agent 的 hook 矩阵与权限闸门应默认 fail-closed，并为执行工具预留 microVM/容器后端。
6. **常驻个人 agent 形态**：cron/routine、后台会话 attach/logs、多渠道（Telegram guest/bot-to-bot、QQ/钉钉官方插件）已是基础配置；yo-agent 只有 iLink 一个渠道、无调度器与守护进程，需要通用 channel 抽象 + scheduler。
7. **子 agent 运行约束**：默认后台、嵌套深度与并发上限、fork 继承权限、恢复时不改工具列表以保 cache、模型生成的编排脚本（dynamic workflows）；yo-agent 的子 agent 应补这些约束与可观测的 agents 视图。
8. **记忆采用文件式自管模式**：`MEMORY.md` 索引 + 主题文件 + 按需读取，配合 memory tool 风格的 CRUD；向量 RAG 降为可选插件。
9. **ACP 规划 v1/v2 并行**：v2 解耦 turn 与响应、按 ID 增量 patch、结构化 diff、权限请求 subject——yo-agent 的 ACP 表面层若基于 v1 语义硬编码，需提前抽象。
10. **插件 host 对标"mods"**：进程内插件能注册 deferred 工具、挂 UI 面板、spawn agent、复用模型调用；skill 名称/内容要做注入与隐藏字符清洗，并统计 skill 的上下文成本。
11. **生态风险**：Gemini CLI 闭源化、OAuth 订阅登录被封、Assistants API 关停、参数逐版禁用——provider 适配器要带版本感知与能力探测（如 `capabilities.server_tools`）。

## 10. 消费级 / 平台级个人 agent（2026-09～10）

> §1 讲的是开发者侧 runtime；本节补的是同期面向普通用户/企业员工的"常驻个人 agent"产品。共同形态：云端常驻 VM + 自带浏览器、目标驱动的后台任务、proactive 模式、连接器优先 + 浏览器兜底、写动作前审批。

### 10.1 Meta Muse
- **形态**：09-08 发布，美国 iOS/Android/Web + WhatsApp，每个用户一台 "Muse Secure VM"（自带浏览器，可旁观），关掉 app 继续跑，会主动给建议。**模型** Muse Spark（家族 04-08 发布，1.3 版 09-02）。**定价**：免费（按用量）/ Power $20 / Maximum $100 每月，注册需绑卡，无广告，靠交易抽成。
- **接入**：逐个 opt-in 的内置连接器（邮件/日历/支付/健康/智能家居/购物等）；有公开 API 的服务填凭据，没有的走浏览器；Stripe Link 结账；同 VM 上独立的 **Sentinel** agent 做读/写分级权限。09-23 Connect 加 Realtime Avatar、控制 macOS 应用、agent 专属邮箱、眼镜唤醒词、Muse Charm 掌上设备，合作方 Stripe/Shopify/Walmart/GitHub/Notion。**09-29 Muse for Small Business**：不是新 app，是 QuickBooks/Stripe/Shopify/Slack/Canva + IG 专业号/FB 主页/广告账户的连接器包，无单独定价。
- **争议**：09-21 Amazon 封禁 Muse（未自报身份、疑似存储凭据）；09-22 404 Media 披露 beta 中"自动打电话"实为呼叫中心人工完成（内部称 human agent layer，成功率 95–98%），Meta 称属内测已回滚 [存疑：回滚细节仅社媒单一来源]；对话默认用于训练（可关）。
- [财经] https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/ ；https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/ ；https://www.cnbc.com/2026/09/29/meta-launches-muse-for-small-business-zuckerberg-pushes-enterprise-ai.html ；https://www.geekwire.com/2026/amazon-blocks-metas-muse-ai-assistant-in-new-standoff-over-agentic-shopping/ ；https://www.404media.co/meta-tests-muse-ai-agent-calls-that-are-actually-made-by-humans-in-a-call-center/

### 10.2 OpenAI dots
- **形态**：DevDay 09-29 发布的 "always-on agents"，**模型 GPT-6 Astra**（GPT-6.1 Astra 会前撤回 [存疑]）。每个 dot 自带云电脑 + 浏览器，本机默认不可达（需经 ChatGPT 桌面端显式连接）；入口 ChatGPT 各端 + Slack/Teams，短信仅美国 Pro 有限 beta，不能打电话、无独立邮箱。
- **接入**：4000+ 应用经 ChatGPT 插件/connector 生态；dot 可被赋予独立身份、凭据与工具，并与微软 Agent 365 集成。**Proactive research**：用户不在时用**只读**工具找可做的事，不能发消息/改内容/操控浏览器。**Auto-review** 对影响账户或外发信息的动作按用户指令、Custom Rules 和 OpenAI 安全要求复核，监控可暂停 dot。
- **套餐/区域**：Pro（EEA/瑞士/英国除外）与 Business Premium 首个 dot 免费，对话不计 ChatGPT 额度，首月后台用量不计（之后未公布）；Enterprise/Edu/Healthcare 管理员开启 beta；specialist dots 仅企业试点；Plus 不含。官方页与安全 FAQ 本次抓取 403，细节经二手转述 [存疑]。
- [官方] https://openai.com/index/introducing-dots/ ；https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/ ；[财经] https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/ ；https://www.cnbc.com/2026/09/29/openai-devday-2026-live-updates.html ；[二手] https://www.datacamp.com/blog/openai-dots

### 10.3 SpaceX(AI) / Cursor / Grok Bot
- **收购**：04-21 期权（$60B 收购或付 $10B 合作费）→ 06-16 行权，全股票 $60B → **08-14 完成**（SEC 8-K），Cursor 为 SpaceX 全资子公司；xAI 2 月并入 SpaceX，7 月更名 SpaceXAI/SpaceXSI；08-28 OpenAI 停止向 Cursor 供模型。
- **Grok Bot**：08-11 beta，"always-on agents 团队"，与 Cursor 共建；Bots 共用一台云电脑、登录现有工具（含无 API/MCP 的网站，走浏览器），需审批时回来找人；用量额度独立于 Grok/Cursor 套餐，超出按 token 经 Cursor 计费。09-28 Team Bots、10-02 proactive 主 Bot [二手]。**模型**：官方未写；SpaceXSI 称 Grok 4.7 针对 Bot harness 训练；Grok Build 为终端编码 agent，称用 Grok 4.6 [存疑，二手]。10-06 Musk 称 Bot 按任务路由"最佳后端模型"含 Claude Opus 5.5，10-11 仍无 changelog；**Claude 额外收费未找到一手证据 [存疑]**。
- **订阅**：10-13 "The X Subscription" 合并 X Premium + Grok + Cursor：Free / Plus $8 / Premium $30 / Super $100 / Ultra $200，Grok Bot 包含；Cursor 附加条款 10-07。
- [官方] https://x.ai/news/introducing-grok-bot ；https://x.ai/legal/x-subscription-cursor-addendum ；[财经] https://www.cnbc.com/2026/04/21/spacex-says-it-can-buy-cursor-later-this-year-for-60-billion-or-pay-10-billion-for-our-work-together.html ；https://www.reuters.com/legal/transactional/spacex-buy-anysphere-60-billion-2026-06-16/ ；https://news.bloomberglaw.com/mergers-and-acquisitions/spacex-completes-its-60-billion-cursor-acquisition ；https://techcrunch.com/2026/10/13/spacexsi-bundles-x-premium-grok-and-cursor-into-one-subscription/ ；[二手] https://www.lindy.ai/blog/grok-bot

### 10.4 Google
- **Gemini Spark**（消费）：I/O 05-19 发布，24/7 云端个人 agent，Gemini 3.5 + **Antigravity harness**；Gmail/Docs/Slides 深度集成，MCP 接 Canva/OpenTable/Instacart；花钱/发邮件前必须确认。5 月 Ultra beta → 07-23 美国 AI Pro → 7 月底近乎全球 Pro/Ultra（EEA/英国/瑞士/尼日利亚除外 [二手]）。9–10 月无新一手公告，搜索里的"Gemini Spark 10 月"均为二手回顾。
- **"Gemini agent"（10-08，Gemini at Work）**：Google Cloud 的 "universal agent for work"，企业向：单一提示框、目标/定时/事件触发、云端持久、可拥有自己的 Workspace 账号与邮箱、临时子 agent、Agent Sandbox/Agent Gateway、按项目花费上限、自动选模型（"含 Claude"来自评论区 [存疑]）。与 Spark 的关系官方未说明。Antigravity 同时是 Gemini CLI 的接替者（§4）与 Spark 的 harness。
- [官方] https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/ ；https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/gemini-at-work/ ；[财经] https://techcrunch.com/2026/10/08/google-brings-agentic-ai-to-gemini-starting-with-businesses/ ；https://9to5google.com/2026/07/23/gemini-spark-google-ai-pro-us/

### 10.5 Microsoft
- **03-17 重组**：消费与商业 Copilot 合并归 Jacob Andreou（升 EVP），Suleyman 转去做 MAI 自研模型；07-29 财报会 Nadella 确认合并成单一 app。
- **09-25 新 Copilot** = Home（Chat + Cowork，将自动路由）/ Code（沙箱、租户内 Copilot Managed Runtime）/ **Autopilot**（原 Scout）：持久、proactive、云端常驻，"在你的租户里有自己的身份、记忆、电脑和工作区"，用户设目标与边界，权限/审计/治理归 IT。**计费**：USL 固定费 + Cowork/Code/Autopilot/前沿模型按用量（credits），管理员控花费与模型族（提及 Astra、Fable）；插件注册表含伙伴插件。Autopilot 月底私有预览，走 Frontier 计划；页面几乎只谈企业，消费端仅 M365 Premium 年内预览 Code。"消费版 Copilot 并入企业产品"为二手说法 [存疑]。
- [官方] https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/ ；[财经] https://fortune.com/2026/09/25/microsoft-unveils-copilot-super-app-targeting-business-users-with-ai-agents/ ；[二手] https://samexpert.com/microsoft-copilot-reorganisation-march-2026/

### 10.6 Apple / Amazon
- **Siri AI**：WWDC 06-08 发布，**09-14 随 iOS/iPadOS/macOS/watchOS/visionOS 27 英文 beta 上线**，10 月加 5 种语言；模型为与 Google Gemini 合作定制的 Apple Foundation Models，云端走 PCC；能力是个人上下文检索、屏幕感知、跨应用动作（WhatsApp/Audible，Outlook/Notability 待接）；EU 与中国不可用；服务端功能有每日用量上限，"将来可付费扩容"。设备内 agent，不是 Muse/dots 的云常驻形态；"第三方 agent 可设为默认"仅二手 [存疑]。
- **Alexa+**：02-04 美国全量，Prime 免费/独立 $19.99；9 月末 **Alexa+ Agentic Ads**（对话内下单，Papa Johns 等）；更强 agent 化项目 "Moonraker" 仅 BI 7 月报道 [存疑]。9–10 月无一手架构公告。
- [官方] https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/ ；https://advertising.amazon.com/library/news/alexa-agentic-ads ；[财经] https://www.cnbc.com/2026/02/04/amazon-alexa-plus-us-releas.html

### 10.7 Anthropic
- Cowork 04-09 GA（macOS/Windows）→ 07-07 上 Web/移动端（Max）→ 春季起云端化（定时任务无需设备在线，动作前仍审批）。**09-16 起 Cowork 并入 Claude 主对话**（不再选模式），同时 Claude Docs/Slides beta、Design 进每个对话；Pro/Max 先行，Team/Free 跟进；默认动作前询问，可改为"持续工作、仅需复核时打断"。未公布新定价；Fortune 指出 agentic 默认路径会抬高简单问题的 token 成本。9–10 月没有"自带云电脑的 dot 式"消费产品——Anthropic 的常驻形态仍在 Claude Code Channels/Routines/Managed Agents（§3）。
- [财经] https://fortune.com/2026/09/16/anthropic-merges-its-claude-chat-and-agentic-cowork-products-into-a-single-ai-assistant-as-part-of-a-push-to-build-an-ai-superapp/ ；https://techcrunch.com/2026/07/07/the-coding-agent-wars-are-spilling-into-the-rest-of-the-office-claude-cowork/

### 10.8 中国
- **腾讯 LightVela**：腾讯轻量云的云端 agent 托管，底层开源 **Hermes Agent**，"7×24 在线"、长期记忆、定时任务、可装 skills；渠道微信/QQ/企微/飞书/钉钉/Telegram/WhatsApp/Discord/Slack（微信扫码授权）；模型自选（DeepSeek/Kimi/豆包/MiniMax/千问或 OpenAI 兼容端点）；国际站 Launch $7.5/月（2C4G、100 模型额度）、Cruise $15/月，14 天试用；上线日期与安全声明官网未写。
- **字节豆包**：9 月末多家报道个人助理定名"小豆"、将出独立 App，前身代号 Spell（4 月内测），能力来自豆包手机助手（09-14 消费者版落地努比亚）；官方未确认 [存疑]。阿里/百度/智谱：本轮未找到 9–10 月个人 agent 一手公告。
- [官方] https://www.tencentcloud.com/act/pro/LightVela ；[二手] https://www.ithome.com/1/008/773.htm

### 10.9 独立产品
- **Manus**：Meta 收购 04-27 被发改委否决，08-11 宣布独立；9 月末 **Manus 2.0**（Cascade harness、Cloud Computer、Automations、个人 agent app "Cue"——订餐/打电话），Manus Flex 自带 API key；10-08 融资 $5 亿+（博裕领投、腾讯参投，估值约 $40 亿 [存疑]）。
- **Perplexity Computer**：02-25 发布，云端 agent 编排约 20 个模型，Max $200/月，后以 credit 开放 Pro；"Personal Computer" 本地版仅单一来源 [存疑]。**Genspark**：Plus $24.99 / Pro $249.99（credit 制），09-18 起新用户 chat/图片不再无限；无 9–10 月产品大更新。
- [财经] https://techcrunch.com/2026/10/08/chinas-manus-raises-over-500m-in-first-funding-round-since-split-with-meta/ ；[二手] https://www.eesel.ai/blog/genspark-ai-pricing

### 对 yo-agent 的补充启示
1. **目标驱动的常驻任务是产品层标配**：Muse/dots/Grok Bot/Autopilot/Gemini agent 都是"给目标 + 边界 → 云端持久跑 → 需要时回来找人"。yo-agent 的 scheduler 不应只是 cron，要有 goal/objective 一等对象：持久状态、进度事件、主动回报点、挂起等审批。
2. **应用连接器 = 凭据托管 + API/MCP 优先、浏览器兜底**：Muse（有 API 填凭据、否则走浏览器）、Grok Bot（登录无 API 的网站）、dots（4000+ connector）、Spark（MCP）。yo-agent 需要 connector 抽象：凭据存 agent loop 之外（§9），MCP 为首选接法，浏览器工具为 fallback，并按连接记录读/写范围（Sentinel 式分级）。
3. **代用户执行必须有可审计的身份**：Autopilot"在租户里有自己的身份"、Gemini agent 有自己的 Workspace 账号、dots 接 Agent 365、Amazon 封 Muse 的理由正是"未自报身份"。yo-agent 对外动作（HTTP UA、邮件 From、消息渠道）应带 agent 身份标识，审计日志区分"用户说的"与"agent 做的"；404 Media 事件说明"实际由谁执行"也要向用户披露。
4. **proactive 模式要节流且只读**：dots 的 proactive research 限只读工具，Spark/Muse 的主动建议不执行写动作。yo-agent 若做 proactive，默认 read-only 工具集 + 频率/预算上限 + 结果只进收件箱不外发。
5. **用量与模型路由是 runtime 的事**：dots/Autopilot/Grok Bot 都把后台用量从聊天额度中拆出按 credit 计；Grok Bot/Copilot/Gemini agent 都自动路由模型。yo-agent 的事件流应按任务记录 token/成本与所用模型，provider 层支持按任务类型的路由策略，便于上层做配额。
