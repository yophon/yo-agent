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
