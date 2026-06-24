# OpenClaw（龙虾）

> 一句话：跨平台个人 AI 助手，通过统一 Gateway 接入 20+ 聊天渠道、多 LLM 提供商与编程 agent 能力 · 作者：openclaw 组织（peter@openclaw.ai）· TypeScript/Node · MIT · https://github.com/openclaw/openclaw

## 1. 是什么 / 定位

OpenClaw（别称"龙虾"）是一个以 Node.js 为运行时、TypeScript 编写的**个人 AI 助手平台**（380k GitHub Stars，2025-11-24 创建，持续活跃至 2026-06）。其核心理念是"Local-first Gateway"——你在自己机器上运行一个长驻 Gateway 进程，该进程同时充当：

- 多渠道消息路由中心（WhatsApp、Telegram、Discord、Slack、QQ、微信、iMessage、IRC、Matrix 等 20+ 渠道）
- 多 LLM 提供商适配层（OpenAI、Anthropic、Google、DeepSeek、Ollama 等 40+）
- 编程 agent 执行引擎（bash/exec 工具、读写文件、diff 审批）
- MCP host 与 MCP server（同时扮演两种角色）

官方赞助商包括 OpenAI、GitHub、NVIDIA、Vercel、Blacksmith、Convex，定位为"个人、单用户、本地优先"的助手，同时可以接入团队协作渠道。安装方式：`npm install -g openclaw@latest && openclaw onboard --install-daemon`。

**注意**：仓库 LICENSE 文件为标准 MIT 文本，但含 THIRD_PARTY_NOTICES.md 附加归因要求，GitHub API 因此将 SPDX ID 报为 "NOASSERTION"；实质上按 MIT 条款运营。

## 2. 架构总览（agent loop / 运行时主循环）

主循环范式为**流式事件驱动 + 多 lane 并发**，而非传统 ReAct 单轮问答。

核心文件：`src/agents/embedded-agent-runner/run.ts`（主入口），实际执行通过 `runEmbeddedAttemptWithBackend` 委派给选定的 harness（`src/agents/harness/selection.ts`）。

**主循环分层：**

1. **Lane 隔离**：每个 agent session 运行在独立 lane（`src/agents/embedded-agent-runner/lanes.ts`），支持 `AGENT_LANE_SUBAGENT` 等隔离泳道，防止不同会话互相阻塞。
2. **Provider Transport Stream**：底层为 SSE 流，Anthropic（`anthropic-transport-stream.ts`）、OpenAI（`openai-transport-stream.ts`）、Google（`google-simple-completion-stream.ts`）各有独立适配。
3. **Tool dispatch 嵌入流中**：assistant 生成 tool_call 事件后，在同一流循环内同步执行工具，不重启整个 loop。工具结果以 user message 注入下一轮。
4. **Failover 与 Auth Profile Rotation**：内置失败转移（`run/assistant-failover.ts`）——遇到 rate limit、billing 错误或上下文溢出时，自动轮换 auth profile 或降级模型（`model-fallback-auth.runtime.ts`）。
5. **工具循环检测**：`tool-loop-detection.ts` 监控最近 30 次工具调用（`TOOL_CALL_HISTORY_SIZE=30`），识别四类死循环并中断（详见第 3 节），另有全局 30 次硬熔断上限。

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

**OpenClaw 同时是 MCP Host（client）也是 MCP Server（host）。**

- 作为 MCP client：`src/agents/agent-bundle-mcp-runtime.ts` 使用 `@modelcontextprotocol/sdk` 的 `Client`，通过 stdio/SSE/streamable-HTTP 三种传输连接外部 MCP server，会话级别懒加载、TTL 为 10 分钟，支持 failure threshold 熔断（`BUNDLE_MCP_FAILURE_THRESHOLD=3`，3 次失败后 60 秒冷却）。
- 作为 MCP server：`src/mcp/openclaw-tools-serve.ts` 将内置工具（如 cron）暴露为 MCP server，供外部 agent 调用。

**工具描述符系统**（`src/tools/types.ts`）：统一的 `ToolDescriptor` 定义，通过 `ToolOwnerRef`（core/plugin/channel/mcp）和 `ToolExecutorRef` 分离"声明"与"执行"，`ToolAvailabilityExpression` 支持 `allOf`/`anyOf` 条件组合，按 auth/config/env/plugin-enabled/context 动态显隐工具。

**内置工具集**（`src/agents/openclaw-tools.ts` 中汇总）：
- 文件操作：`read`、`write`、`edit`（含 workspace root guard 沙箱保护）
- Shell：`exec`（bash/sh）、`process`（长进程+进程发送键）
- Web：`web_fetch`、`web_search`
- 会话/子 agent：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`sessions_yield`
- 媒体：`image_generate`、`video_generate`、`music_generate`、`tts`、`pdf`
- 自动化：`cron`（cron 定时任务工具）、`nodes`（远程节点调用）
- 平台：`canvas`、`gateway`（调用 gateway RPC）、`message`（跨渠道发消息）
- 元：`update_plan`（可选计划工具，由 `isStrictAgenticExecutionContractActive` 控制是否显示）

**工具循环检测**（来源核查已确认）识别四种独立模式：
1. `generic_repeat`：相同工具以相同参数反复调用且结果不变
2. `unknown_tool_repeat`：连续调用不存在工具（阈值 10 次）
3. `known_poll_no_progress`：`command_status`/`process poll` 等轮询类工具持续无状态变化
4. `ping_pong`：两个工具交替调用、各自结果稳定（循环依赖）

另有全局硬截断：30 次工具调用后无论何种模式均触发 global circuit breaker。`WARNING_THRESHOLD=10` 触发警告日志。

工具调用机制：在 provider transport 层通过 SDK 原生 tool_use 格式下发，结果通过 `session-tool-result-guard.ts` 校验再写回 transcript；工具 schema 自动 quarantine（`tool-schema-quarantine.ts`）过滤不合规 schema。

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复 resume）

**上下文窗口管理：**

采用"compaction"策略（`src/agents/compaction.ts`、`embedded-agent-runner/compact.ts`）：
- 当 token 使用量接近上限，自动触发 summarization，`reserveTokensFloor` 默认 20,000 tokens（可按 agent 粒度覆盖）。
- 分块摘要（`buildSummaryChunksWithWorker`）：将历史对话分为若干 chunk，逐块生成摘要，再通过 "merge partial summaries" 合并；即使中途失败，已完成 chunk 的摘要仍部分保留。
- 合并摘要强制保留：进行中任务状态、批操作进度（如 5/17 items）、用户最后请求、决策理由、TODO 与 UUID/hash 等不透明标识符。`IDENTIFIER_PRESERVATION_INSTRUCTIONS` 明确要求："Preserve all opaque identifiers exactly as written (no shortening or reconstruction), including UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names."
- 安全 timeout 机制（`compaction-safety-timeout.ts`）：compaction 超时后有 fallback 路径。
- compaction 有 successor transcript 机制，确保 compaction 后会话无缝继续。

**会话历史限制：** `history.ts` 提供 `limitHistoryTurns`，按 provider/user 粒度配置 DM 历史轮数上限（`dmHistoryLimit`/`historyLimit`）。

**长期记忆：** 有 `active-memory` 插件（`extensions/active-memory`），另有 `memoryCitationsMode` 参数注入系统提示；会话元数据、compaction checkpoint 存 SQLite（`agents/<agentId>/agent/openclaw-agent.sqlite`）。

**会话恢复：** ACP translator（`src/acp/translator.ts`）支持 `ResumeSessionRequest`/`LoadSessionRequest`；compaction checkpoint 落盘，重启后可恢复。

## 5. Prompt / 系统提示策略（CLAUDE.md/AGENTS.md 类约定、模式如 plan/act）

**约定文件：** 仓库根目录同时存在 `AGENTS.md` 和 `CLAUDE.md`——CLAUDE.md 是 AGENTS.md 的 symlink（AGENTS.md 注明："add sibling CLAUDE.md symlink; edit AGENTS.md only"），供不同 agent 工具各自读取。AGENTS.md 采用"电报风格"（Telegraph style），内容极为详尽，包含：
- 目录 Map（src/、packages/、extensions/ 分工）
- 架构约束（如 SQLite-only 状态存储、plugin 边界、config/env 变更高门槛）
- 工作流程（如依赖检查 preflight、外部 API live-verify 要求）
- ClawSweeper review policy（PR 自动审核规则，要求完整读库 + 依赖检查 + 最优修复方案证据）

子目录各有独立 scoped `AGENTS.md`，说明各模块约定。

**系统提示策略：** `src/agents/embedded-agent-runner/system-prompt.ts` 调用 `buildConfiguredAgentSystemPrompt`，动态注入：
- 工作区信息（workspaceDir、tools 名称列表）
- 渠道能力（channelActions、reactionGuidance）
- 技能提示（skillsPrompt）
- 记忆部分（includeMemorySection、memoryCitationsMode）
- 时区/时间格式
- Bootstrap 文件（contextFiles）
- `promptMode`（full/lite/code）和 `silentReplyPromptMode` 控制哪些 section 出现

**plan/act 模式：** `update_plan` 工具在启用"严格 agentic 执行合约"时出现，相当于显式计划阶段；`ThinkLevel`（low/medium/high）映射到不同 thinking budget，在系统提示和 provider 参数两处同步设置。

## 6. 权限与审批（工具执行如何获批、沙箱 seatbelt/landlock/docker）

**三层权限模型：**

1. **工具政策层**（`tool-policy-pipeline.ts`）：allowlist/denylist/profile/group/sender/subagent 六维过滤，`resolveEffectiveToolPolicy` 按优先级合并。
2. **Bash 执行审批**（`bash-tools.exec-approval-request.ts`）：exec 工具默认走 gateway 审批（两阶段：register → wait for decision），通过 `openclaw pairing approve` 或 UI 点击确认，`ExecApprovalDecision` 传回 allow/deny。安全分级 `ExecSecurity`/`ExecAsk`，`safe-bins` 列表（`agent-tools.safe-bins.ts`）可免批。
3. **沙箱**（`src/agents/sandbox/`）：默认对 non-main session 启用沙箱。后端插件化（`sandbox/backend.ts`），工厂模式，已注册：Docker（默认）、SSH、OpenShell 三种后端。沙箱内工具 allowlist 默认包含 bash/process/read/write/edit，deny browser/canvas/nodes/cron/discord/gateway。`sandbox.mode` 可为 `off`/`all`/`non-main`。

**DM 安全默认：** 未知发送者默认 pairing 模式，需要配对码审批（`dmPolicy="pairing"`），防止 prompt injection from untrusted DMs。

## 7. 多平台 / 传输 / 接入层（CLI/IDE/TUI/聊天平台、协议 MCP/ACP/A2A/OneBot）

**渠道列表（均为独立 extension 插件）：** WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、IRC、Microsoft Teams、Matrix、Feishu、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、QQ（`extensions/qqbot`）、WeChat、WebChat、clickclack（自研 CLI chat）。

**协议支持：**
- **MCP**：双向，既是 host 也是 server（见第 3 节）
- **ACP（Agent Client Protocol）**：`src/acp/` 完整实现，`translator.ts` 将 ACP 会话/prompt 协议翻译为 Gateway chat session；`acpx`（`openclaw/acpx` 仓库）是无头 ACP CLI client
- **Gateway Protocol**：自研 RPC 协议（`packages/gateway-protocol/`），Gateway 对外暴露 HTTP RPC + WebSocket 事件流
- **Tailscale 直连**：支持通过 Tailscale 安全远程访问 Gateway（文档中有专门 runbook）

**平台 App：**
- CLI：`openclaw` 命令行
- macOS：menu bar 应用 + Canvas（视觉工作区）
- Windows：`openclaw-windows-node`（系统托盘 + PowerToys Command Palette，C# companion app）
- iOS/Android：节点模式（Node），支持语音唤醒（Voice Wake）
- TUI：`src/tui/`

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

**插件系统：** `extensions/` 目录下有 80+ 插件，覆盖 LLM 提供商（openai/anthropic/google/deepseek/ollama/qwen/…）、渠道（telegram/discord/slack/qq…）、能力（browser/canvas/voice…）。插件通过 `plugin-sdk`（`src/plugin-sdk/`、`packages/plugin-sdk/`）与核心隔离，只能通过公开 barrel（`api.ts`、`runtime-api.ts`）访问核心。

**技能（Skills）：** `src/skills/` 管理 skill，`ClawHub`（`openclaw/clawhub`）是对应的公开 Skill + Plugin Registry（类 npm，9k stars）。技能以 markdown+YAML 形式定义工作流，注入系统提示，可在 workspace 级别配置。`lobster`（`openclaw/lobster`）是技能 pipeline shell，将 skill/tool 组合为可复用工作流。

**子 agent（Multi-agent）：** 完整实现：
- `sessions_spawn` 工具：parent agent 可以 spawn 一个独立 session 作为子 agent
- `src/agents/subagent-registry-*.ts`：子 agent 注册表，跟踪运行状态、liveness、timeout
- `agent-steering-queue.ts`：子 agent 完成后，将结果通过 "steering" 注入 parent 的下一轮 user message（最大 24,000 字符，按完成时间排序）
- `sessions_yield`：子 agent 主动 yield 结果给 parent
- ACP spawn（`src/agents/acp-spawn.ts`）：通过 ACP 协议委派给外部 agent 运行时

**harness 插件系统：** `src/agents/harness/` 支持注册第三方 harness（如 `codex` 插件让 OpenAI Codex 接管某些 agent run）。

## 9. Provider 抽象（是否 BYOK 多模型）

**完全 BYOK，支持极宽广的提供商矩阵。**

默认 provider：`openai`，默认模型：`gpt-5.5`（源码 `src/agents/defaults.ts` 实测确认；README 建议用户"prefer a current flagship model from the provider you trust"，即该默认值会随时更新）。

**已实现提供商（extensions/ 目录实测）：** openai、anthropic（含 Vertex）、google（Gemini）、deepseek、ollama、qwen（阿里百炼）、moonshot（Kimi）、xai（Grok）、cohere、cerebras、deepinfra、perplexity、openrouter、copilot、azure（azure-speech）、together、stepfun、sglang、vllm、arcee、chutes、venice、volcengine（火山）、byteplus、xiaomi、alibaba、qianfan（百度）、zai 等 40+ 提供商。

**多 auth profile + 自动轮换**（`src/agents/auth-profiles.runtime.ts`）：支持配置多个 API key，遇到 rate limit/billing 错误自动轮换（`model-fallback-auth.runtime.ts`），并支持跨 provider 的 model fallback 链（`model-fallback.run-embedded.e2e.test.ts`）。

**API key 来源**：config 文件 / 环境变量 / 外部 CLI 认证（如 claude CLI、codex CLI）均支持，通过 `resolveEnvApiKey` + secret ref 机制统一管理。

## 10. 亮点设计（值得 yo-agent 借鉴）/ 短板 / 坑

**亮点：**

1. **ToolAvailabilityExpression 声明式动态工具显隐**：用 allOf/anyOf 组合 auth/config/env/context 信号，工具是否出现在 LLM 上下文完全由声明式规则控制，而非代码分支，极易扩展。
2. **Compaction 分块摘要 + 标识符保留**：对话超窗时递归分块摘要再合并，摘要 prompt 中强制要求 `IDENTIFIER_PRESERVATION_INSTRUCTIONS`（"no shortening or reconstruction"），避免 agent 恢复后因 UUID/hash/URL 改写而失效。
3. **Tool Loop Detection 四模式内置熔断**：监控 30 条历史，精确识别 generic_repeat/unknown_tool_repeat/known_poll_no_progress/ping_pong 四类模式，在应用层而非 LLM 层阻止死循环；全局 30 次硬截断作为最后防线。
4. **Subagent Steering Queue 异步结果注入**：子 agent 完成后不立即阻塞 parent，而是将结果放入 steering queue，在 parent 下一轮自然注入，实现 fire-and-forget 风格的并发委派。
5. **Harness 插件化执行后端**：整个 agent 执行后端（native openclaw vs codex vs 自定义）可插拔，允许不同 provider 的 CLI 工具以 harness 形式接管 agent run，无需改核心。
6. **DM pairing 默认安全**：新发送者必须通过 pairing code 验证才能使用 agent，防止公开渠道的 prompt injection；yo-agent 接入 QQ/Telegram 时应借鉴。
7. **ACP 协议集成**：完整的 Agent Client Protocol 适配层，让 OpenClaw 既能作为 ACP server 被外部调用，也能 spawn ACP 子 agent，为 A2A 委派提供标准协议。

**短板 / 坑：**

1. **架构极度复杂**：src/agents/ 目录有 300+ 文件，模块边界细碎，学习成本极高；对于 yo-agent 这样追求单栈简单的引擎，直接借鉴整体架构不现实。
2. **SQLite-only 状态存储硬约束**：明文禁止 JSON/JSONL/TXT 存运行时状态，迁移时全靠 doctor 命令，规范虽好但初期开发阶段灵活性不足。
3. **默认 provider 是 OpenAI**：深度集成 OpenAI（包括 Codex harness、Responses API），对 Anthropic-only 或开源模型用户有一定偏向。
4. **Windows 支持依赖额外 Companion App**：`openclaw-windows-node`（C# 项目），平台一致性差。
5. **技能/插件生态碎片化**：80+ extensions 各自一套 AGENTS.md/CLAUDE.md，维护成本高；ClawHub 是外部 registry，版本兼容性管理靠 plugin-inspector/crabpot。

## 11. 对 yo-agent 的具体启示

1. **工具声明与执行分离**：采用 `ToolDescriptor` + `ToolExecutorRef` 模式，将"工具是否可用"的条件逻辑（auth/config/env）完全声明化，避免在 agent 主循环里写大量 if-else；yo-agent 工具系统设计时应在注册阶段声明 availability 条件，runtime 统一 evaluate。

2. **Lane 隔离 + Subagent Steering Queue**：yo-agent 支持 QQ/Telegram/Discord 多渠道，不同渠道的并发消息需要 lane 隔离；子 agent 结果异步注入（而非同步阻塞）的 steering queue 模式，可以直接借鉴用于 yo-agent 的多 agent 委派场景。

3. **Compaction 中的标识符保留策略**：在摘要 prompt 中明确要求"Preserve all opaque identifiers exactly"（UUID/hash/URL/filename），这是 yo-agent 实现上下文压缩时极易被忽视的细节，否则 agent 恢复后会因 ID 截断/改写而失效。

4. **DM pairing 安全模型**：yo-agent 接入 QQ/Telegram 等开放渠道时，应默认开启 pairing 模式，只有经过 `approve` 的发送者才能触发 agent；这个设计可以直接作为 yo-agent 渠道接入层的安全基线。

5. **工具循环检测（30 条历史窗口 + 四模式 + 硬熔断）**：在 yo-agent 的 agent loop 中，应在应用层内置 loop detector，而不依赖 LLM 自身识别死循环；`TOOL_CALL_HISTORY_SIZE=30`、`WARNING_THRESHOLD=10` 是经过调试的合理默认值，四种模式检测逻辑可直接参考。

6. **Auth Profile Rotation + Cross-Provider Fallback**：yo-agent 作为 BYOK 引擎，应实现多 key 轮换 + provider fallback 链，遇到 rate limit 自动切换 key/provider，而不是直接报错给用户；参考 `model-fallback-auth.runtime.ts` 的失败分类（rate_limit vs billing vs context_overflow）再决策。

## 参考来源（真实可访问 URL 列表）

- GitHub 仓库：https://github.com/openclaw/openclaw
- 官网：https://openclaw.ai
- 文档：https://docs.openclaw.ai
- ClawHub（技能注册表）：https://clawhub.ai
- ACP SDK 参考（acpx 仓库）：https://github.com/openclaw/acpx
- 主 README：https://raw.githubusercontent.com/openclaw/openclaw/main/README.md
- AGENTS.md（开发约定）：https://raw.githubusercontent.com/openclaw/openclaw/main/AGENTS.md
- 工具类型定义：https://github.com/openclaw/openclaw/blob/main/src/tools/types.ts
- Agent tools 汇总：https://github.com/openclaw/openclaw/blob/main/src/agents/openclaw-tools.ts
- Compaction 实现：https://github.com/openclaw/openclaw/blob/main/src/agents/compaction.ts
- MCP bundle runtime：https://github.com/openclaw/openclaw/blob/main/src/agents/agent-bundle-mcp-runtime.ts
- ACP translator：https://github.com/openclaw/openclaw/blob/main/src/acp/translator.ts
- Provider index：https://github.com/openclaw/openclaw/blob/main/src/model-catalog/provider-index/openclaw-provider-index.ts
- Sandbox backend：https://github.com/openclaw/openclaw/blob/main/src/agents/sandbox/backend.ts
- Tool loop detection：https://github.com/openclaw/openclaw/blob/main/src/agents/tool-loop-detection.ts
- Session management（compaction docs）：https://docs.openclaw.ai/reference/session-management-compaction
