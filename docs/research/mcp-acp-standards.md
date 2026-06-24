# Agent 互操作标准（MCP / ACP / A2A / AGENTS.md）
> 一句话：四项互补的开放协议，分别解决 AI 系统中「模型↔工具」「编辑器↔agent」「agent↔agent」「agent↔项目上下文」四个层次的互操作难题 · 多厂商联合推进 · 协议无语言限制（参考实现含 TypeScript/Python/Go/Java/Rust）· Apache 2.0 / MIT · 各自仓库见下文参考来源

---

## 1. 是什么 / 定位

本报告横跨四个标准，它们解决的问题层次不同、互相补充：

| 标准 | 定义的层 | 核心关系 | 主推方 |
|------|---------|---------|--------|
| **MCP** (Model Context Protocol) | 模型 ↔ 工具/资源 | LLM 调用外部能力 | Anthropic → AAIF/Linux Foundation（2025-12 捐赠）|
| **ACP** (Agent Client Protocol) | 编辑器 ↔ 编程 agent | IDE 驱动 agent 执行代码任务 | Zed Industries 创立（2025-08），与 JetBrains 联合演进 |
| **A2A** (Agent2Agent Protocol) | agent ↔ agent | 自主 agent 之间协作 | Google → Linux Foundation（2025-06 捐赠）|
| **AGENTS.md** | repo ↔ agent 上下文 | 项目级持久化指令文件 | OpenAI Codex → AAIF/Linux Foundation（2025-12 捐赠）|

四者不竞争：MCP 做工具管道，ACP 做编辑器接入，A2A 做 agent 间委派，AGENTS.md 做指令约定。一个完整的编程 agent 可以同时实现全部四项。

---

## 2. 架构总览

### MCP 架构

MCP 采用 **JSON-RPC 2.0** 作为数据层，分两层：

- **数据层**：capability 协商、生命周期管理（`initialize` → `notifications/initialized`）、三类原语（Tools / Resources / Prompts）、客户端原语（Sampling / Elicitation / Logging）
- **传输层**：
  - **Stdio**：本地子进程，标准输入输出，零网络开销
  - **Streamable HTTP**：HTTP POST + 可选 SSE 流，用于远端服务器；2025-03 引入，取代旧 HTTP+SSE 两端点设计

角色三分：**MCP Host**（如 Claude Desktop/VS Code）持有一或多个 **MCP Client**，每个 Client 对应一个 **MCP Server**。

MCP 当前稳定规范版本为 **2025-11-25**。2026-07 Release Candidate 核心变化：**去 Session 化**——取消 `initialize` 握手与 `Mcp-Session-Id`，客户端信息改为通过每请求的 `_meta` 字段内联传递（协议版本、能力声明、W3C trace context），使服务器可无状态水平扩展。注意：官方架构文档当前仍将 MCP 描述为有状态协议，并注明"可通过 Streamable HTTP 传输实现无状态子集"，无状态核心为 RC 阶段变化。

### ACP 架构

ACP 是 **JSON-RPC 2.0 over stdio**（本地 agent 作为子进程），远端模式支持 HTTP/WebSocket（Transport 工作组 2026-04 成立，仍在标准化中）。

生命周期：`initialize` 握手协商能力 → `session/new` | `session/load` | `session/resume` 建立会话 → `session/prompt` 发送任务 → agent 通过 `session/update` 流式推送计划/工具调用/响应片段 → `session/close`（2026-04 稳定化）。

ACP 采用 **RFD（Request for Discussion）增量稳定化**模式而非整体版本号发布，各方法独立推进至 Completed 状态。2026-01 与 JetBrains 联合发布 ACP Agent Registry，2026-03 协议内部版本约为 v0.11.0。

### A2A 架构

A2A 基于 **JSON-RPC 2.0 over HTTP(S)**，peer-to-peer 模式。当前稳定版本为 **v1.0.1**（2026-05-28 发布）。核心对象：

- **AgentCard**：发布在 `/.well-known/agent-card.json`，声明 agent 身份、技能列表、endpoint、认证需求、支持的传输绑定；v1.0 引入密码学签名（Signed Agent Cards），支持域名级身份验证
- **Task**：有状态工作单元，生命周期：`SUBMITTED → WORKING → [INPUT_REQUIRED | AUTH_REQUIRED] → COMPLETED | FAILED | CANCELED | REJECTED`（另有 `UNSPECIFIED` 兜底状态）

核心 RPC 方法：`a2a_sendMessage`、`a2a_sendStreamingMessage`（SSE 流）、`a2a_getTask`、`a2a_listTasks`、`a2a_cancelTask`、`a2a_subscribeToTask`，以及推送通知的 CRUD 系列，以及 v1.0 新增的 `a2a_getExtendedAgentCard`。

### AGENTS.md 架构

AGENTS.md 是纯 Markdown 文件，**无强制结构**。发现规则：从当前文件向上遍历到 Git 根，合并所有 AGENTS.md（子目录覆盖父级）；全局配置位于 `~/.codex/AGENTS.md`；优先级：系统提示 > 用户 prompt > 最近 AGENTS.md > 父级 AGENTS.md。

---

## 3. 工具系统

### MCP 工具系统

- **Tools**：`tools/list` 发现，`tools/call` 执行，inputSchema 用 JSON Schema 描述参数
- **Resources**：`resources/list` / `resources/read`，类似文件或数据源
- **Prompts**：`prompts/list` / `prompts/get`，可复用的提示模板
- **客户端原语**：`sampling/createMessage`（服务端请求 LLM 推理）、`elicitation/create`（请求用户输入）
- **Tasks（实验性 → 2026 RC 升级为扩展）**：客户端用 `tasks/get` / `tasks/update` / `tasks/cancel` 轮询，Tasks 在 2026 RC 中从实验核心移至正式扩展框架，生命周期设计改为无状态
- **MCP Apps**（2026 RC）：服务端交付可渲染 HTML iframe 的 UI，模板在握手时预声明以供安全审查和缓存，所有 UI 操作走同一 JSON-RPC 审计通道

MCP 自身**是工具系统的标准**，agent 通过扮演 MCP Host 来消费工具；agent 也可以作为 MCP Server 对外暴露能力。

### ACP 工具系统

ACP 定义了 **9 种标准化工具 kind**：`read`（读取文件/数据）、`edit`（修改文件/内容）、`delete`（删除）、`move`（移动/重命名）、`search`（搜索）、`execute`（执行命令/代码）、`think`（内部推理/规划）、`fetch`（获取外部数据）、`other`（默认兜底类型）。工具调用通过 `session/update`（type=`tool_call`）上报，包含 `toolCallId`、`title`、`kind`、`status`、`locations`（受影响文件路径）、`rawInput`/`rawOutput`。敏感操作前 agent 发 `session/request_permission`，编辑器用户确认后返回。

ACP 还定义了 **MCP-over-ACP**：agent 可以通过 `mcpCapabilities` 声明自己支持哪些 MCP 传输，编辑器在 `session/new` 时传入 `mcpServers` 配置，agent 在子进程内部充当 MCP Host。

### A2A 工具系统

A2A 本身不规定工具格式——agent 内部用什么工具对对端不透明。A2A 定义的是 **agent 间接口**：技能（Skills）在 AgentCard 中声明，输入/输出 MIME 类型协商，agent 可选择通过 `a2a_getExtendedAgentCard` 暴露扩展 AgentCard（包含更多实现细节，需认证后访问）。

---

## 4. 上下文与记忆

### MCP

MCP 2025-11-25 稳定规范为有状态协议（session），2026 RC 切换为无状态核心，每请求携带能力声明。长期记忆需由 MCP Server 侧实现（如 Memory MCP Server 用图数据库存知识）；协议本身不规定会话持久化。

### ACP

ACP 原生支持 **会话恢复**：`session/load` 重放完整历史，`session/resume` 无历史重放式重连接（2026-04 稳定化）；会话 ID 由 agent 分配（opaque 字符串）。上下文窗口压缩是 agent 实现细节，协议层不规定。

### A2A

A2A Task 有唯一 ID，客户端可通过 `a2a_getTask`（含 `includeHistory` 参数）获取历史消息序列；推送通知配置独立持久化。agent 内部记忆完全不透明（协议明确「不暴露内部状态、记忆或工具」）。

### AGENTS.md

AGENTS.md 是 **静态长期记忆**的一种形式：将项目约定固化成文件，agent 每次运行都读取。合并上限 32 KiB（OpenAI Codex 默认），支持 override 文件临时覆盖。

---

## 5. Prompt / 系统提示策略

### MCP

MCP 定义 **Prompts 原语**：服务端可发布带参数的提示模板，客户端用 `prompts/get` 拉取，将其注入对话。这使工具提供方可以附带使用示范（few-shot）。协议不规定 host 的系统提示结构。

### ACP

ACP 定义 `AgentPlan`（`session/update` type=`plan`）：agent 可以在回答前先流式输出执行计划供用户确认。协议声明 `StopReason` 枚举（`end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`），精确描述终止原因。

### A2A

A2A 不规定 agent 内部 prompt——代理的系统提示对调用方完全不透明。调用方通过 AgentCard 中的 Skills 描述理解能力边界。

### AGENTS.md

这是本组标准中**最直接的 prompt 约定层**：
- **根级**：全局编码规范、构建命令、测试要求
- **子目录级**：包/模块特定指令，最近优先
- **常见 section**：项目概览、依赖管理、代码风格、测试指令、安全约束、提交消息规范
- CLAUDE.md（Claude Code 专用）与 AGENTS.md 功能等价，Claude Code 同时支持两者

---

## 6. 权限与审批

### MCP

MCP 传输层强制 OAuth 2.1（2025-03 起），MCP 服务器作为 OAuth Resource Server，客户端必须实现 RFC 8707 Resource Indicators（token 绑定目标资源，防止 Confused Deputy 攻击）。工具执行本身是 LLM 决策，host 是否显示审批界面由 host 实现决定（MCP 协议不强制）。2026 RC 包含 authorization hardening，与 OAuth 和 OpenID Connect 部署进一步对齐。

### ACP

`session/request_permission` 是**协议级强制审批**：agent 在执行高风险工具前 **MUST** 请求权限，用户通过编辑器 UI 选择（allow_once / allow_always / reject_once / reject_always）。这是 ACP 相比 MCP 在审批层面更完整的设计。

### A2A

A2A 定义了 `AUTH_REQUIRED` Task 状态：agent 在需要凭证时将 Task 挂起，通知客户端补充认证信息。AgentCard 中声明支持的安全方案（API Key / OAuth2 / mTLS / OIDC）。v1.0 Signed Agent Cards 增加密码学身份验证层，接收方可验证卡片确实由域名拥有者签发。push notification delivery 也支持自定义认证。

### AGENTS.md

AGENTS.md 可在文件中写入安全约束（如「禁止提交 .env 文件」「所有 PR 必须通过 CI 才能合并」），这些成为 agent 的硬性约束，但执行完全依赖 agent 对文件的理解与遵守，无技术强制。

---

## 7. 多平台 / 传输 / 接入层

### MCP

- **Transports**：Stdio（本地）、Streamable HTTP（远端，带 SSE）
- **Auth**：Bearer token、API Key、自定义 Header；推荐 OAuth 2.1
- **采用**：VS Code、Claude Desktop、Claude Code、Cursor、Windsurf、ChatGPT、Gemini、Microsoft Copilot 等；官方 TypeScript/Python/C#/Java/Swift SDK；97 million 月下载量（2026-03 数据，TS + Python SDK 合计）；官方注册表 800+ 服务器，社区估计总量 13,000+
- **治理**：Agentic AI Foundation (AAIF) / Linux Foundation，co-founded by Anthropic、Block、OpenAI

### ACP

- **Transport**：JSON-RPC 2.0 over stdio（稳定）；HTTP/WebSocket（Transports Working Group 成立，WIP）
- **版本模式**：RFD 增量稳定化，各方法独立 Completed，无全局 release 版本号
- **编辑器**：Zed（创始，2025-08）、JetBrains（2025-10 加入，IntelliJ/PyCharm/WebStorm）、Kiro（AWS，2026）
- **Agent**：Claude Code、Gemini CLI、Codex CLI、GitHub Copilot CLI、OpenCode、Augment、Cline 等
- **Agent Registry**：2026-01-28 联合发布，内置于 JetBrains IDE（2025.3+）和 Zed
- **Protocol tunneling**：MCP-over-ACP 规范允许 agent 通过 ACP 会话暴露 MCP 能力

### A2A

- **Transport**：HTTP(S) + JSON-RPC 2.0；SSE 流式；Webhook push notification；规范还定义 gRPC 和 HTTP/REST 绑定
- **Discovery**：`/.well-known/agent-card.json`（标准 HTTP）
- **版本**：v1.0.1（2026-05-28），相比 v0.x 引入 Signed AgentCard、多租户端点、多协议绑定
- **采用**：150+ 组织（Google、Microsoft、AWS、Salesforce、SAP、ServiceNow、IBM 等），已有生产环境部署（供应链/金融/保险/IT 运维）；官方 JS/Python/Java/Go SDK
- **治理**：Linux Foundation Agentic AI Foundation（2025-06 捐赠）

### AGENTS.md

- **接入**：Claude Code、Google Jules、OpenAI Codex、Cursor、Aider、VS Code、GitHub Copilot 等 60,000+ 开源项目
- **覆盖**：通用 Markdown，不绑定任何传输或平台

---

## 8. 插件 / 扩展 / 子 agent

### MCP

MCP **Extensions 框架**（2026 RC）：在核心规范之外可选扩展能力。MCP Apps 作为第一个扩展，允许服务端交付沙箱 iframe UI（UI 模板预声明以供安全审查）；Tasks 扩展支持长时运行操作。服务端之间不直接通信，多 agent 编排由 host 层负责（如 Claude Code 的 subagent spawning 通过 `Task` tool 实现，子 agent 是独立 MCP Server）。

### ACP

ACP 的 `mcpServers` 配置允许 agent 在内部 spawn 多个 MCP 子服务，形成 **ACP → agent → MCP 工具链**。协议本身不规定 agent 内部的子 agent 委派，但不阻止。

### A2A

A2A 是**原生多 agent 协议**：任何 A2A Server 都可以将收到的 Task 委派给另一个 A2A Server（级联调用）。`Skills` 系统支持 capability-based 路由，客户端可扫描 AgentCard 选择最合适的 agent。未来 `QuerySkill()` 方法将支持动态查询非 AgentCard 预列出的能力。

### AGENTS.md

单文件，无 plugin 机制。monorepo 的子目录覆盖实现"子项目定制"。

---

## 9. Provider 抽象

MCP、ACP、A2A、AGENTS.md **均不绑定任何 LLM Provider**：

- MCP 通过 `sampling/createMessage` 让 Server 反向请求 Host 的 LLM，实现 provider-agnostic 的服务端推理
- ACP 完全不规定 agent 内部使用哪个模型
- A2A 的 AgentCard 仅描述技能和接口，模型选择对调用方不透明
- AGENTS.md 仅约定文本指令，任何模型都可消费

这四个标准都是真正的 **BYOM（Bring Your Own Model）**标准。

---

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **MCP 三原语的层次分离**：Tools（执行）/ Resources（数据）/ Prompts（模板）各司其职，比单一 function-calling 更有表达力；`listChanged` 通知支持动态工具注册
2. **MCP 2026 RC 无状态化**：每请求内联能力声明，使 MCP Server 可直接部署在无状态 HTTP 基础设施（CDN、serverless、load balancer），无需 sticky session 或共享 session store
3. **ACP session/request_permission 的四选项设计**：allow_once / allow_always / reject_once / reject_always 是最细粒度的用户授权 UX，远比「弹一个确认框」更工程化；这是协议级约定而非 UI 逻辑
4. **A2A AgentCard 的 well-known URI 自动发现 + Signed Cards**：零配置 agent 注册表，只需 HTTP GET `/.well-known/agent-card.json`；v1.0 加密签名让接收方可验证卡片确实来自域名拥有者，闭环了 agent 身份信任链
5. **A2A 任务生命周期状态机**：`INPUT_REQUIRED` 和 `AUTH_REQUIRED` 两个中间态是工程亮点，支持人机协同流程（human-in-the-loop）和凭证补充，长时异步工作流优雅暂停/续行
6. **AGENTS.md 层级覆盖**：与 `.gitignore` / `.eslintrc` 同构，monorepo 工程师天然理解，最近文件优先的规则减少认知负担

### 短板 / 坑

1. **MCP 工具调用无协议级审批**：是否显示审批界面完全由 host 实现决定，安全策略不一致
2. **ACP 远端模式尚未稳定**（HTTP/WebSocket 仍在 Transports Working Group 推进），限制云端 agent 接入；且协议无全局版本号，依赖 RFD 逐条跟踪成本较高
3. **A2A vs MCP 边界模糊**：当 agent 的「工具」是另一个 LLM agent 时，用 MCP Tools 还是 A2A Task 没有强制规范，社区实践分裂
4. **AGENTS.md 无验证机制**：agent 不受技术约束，可以忽略文件内容；32 KiB 上限在大型 monorepo 中可能不够
5. **四套标准并存的配置成本**：一个 agent 项目可能同时维护 MCP server config、ACP session config、A2A AgentCard、AGENTS.md，认知和维护负担重
6. **MCP SSE 旧传输已废弃**（2025-11 后官方标记 deprecated），但社区服务器仍在大量使用旧 SSE 实现，迁移成本高

---

## 11. 对 yo-agent 的具体启示

yo-agent 是 TypeScript/Node 单栈通用 agent 引擎，需要同时支持编程 agent（代码读写/命令执行/diff 审批）和聊天平台（QQ/Telegram/Discord）。以下 6 条启示直接可落地：

**1. 首选 MCP Host 架构作为工具层基础**
用 `@modelcontextprotocol/sdk`（TypeScript 官方 SDK）让 yo-agent 充当 MCP Host，所有外部能力（文件系统、shell、浏览器、数据库）通过 MCP Server 挂接。这样工具可以热插拔，不改内核代码，且兼容社区现有 13,000+ MCP Server 生态。实现优先级：stdio transport（本地工具）> Streamable HTTP（远端 API 工具）。

**2. 参考 ACP 的 session/request_permission 设计审批层**
yo-agent 需要在聊天平台和编辑器环境都支持「危险操作审批」。参考 ACP 的四选项枚举（allow_once / allow_always / reject_once / reject_always），将权限决策作为协议级消息而非 UI 逻辑，消息发到 Telegram/Discord channel 让用户按钮选择，结果写回审批状态机。关键文件参考：`agentclientprotocol.com/protocol/tool-calls`。

**3. 实现 AGENTS.md 读取作为项目上下文注入**
yo-agent 在编程 agent 模式启动时，从 `cwd` 向上遍历读取 AGENTS.md（参考 Codex 的 32 KiB 合并逻辑），注入系统提示最前端。同时支持 CLAUDE.md（向下兼容已有项目）。这让 yo-agent 在任何有 AGENTS.md 的 repo 上开箱即用，无需额外配置。

**4. 提供 A2A AgentCard 端点作为机器可读能力声明**
yo-agent 在 HTTP server 模式下暴露 `/.well-known/agent-card.json`，声明 skills（代码审查、命令执行、文档生成等）和支持的传输。这使 yo-agent 可以被其他 A2A 兼容系统发现和委派任务，无需人工配置。AgentCard 的 `capabilities.streaming: true` 字段对接 SSE 响应流。

**5. 用 ACP 的 9 种工具 kind 规范化 yo-agent 的工具上报格式**
yo-agent 在聊天平台推送工具执行状态时，用 `read`/`edit`/`execute`/`fetch`/`other` 等 kind 标签替代自定义状态字符串，用户看到的消息风格一致，且方便未来接入 ACP 兼容编辑器（Zed/JetBrains/Kiro）。

**6. 2026 年关注 MCP 无状态化迁移窗口**
yo-agent 新建的 MCP Server 直接基于 2026 RC 无状态模式实现（每请求内联 `_meta`），避免绑定旧 Session 机制。如需兼容旧客户端，加 `_meta` 字段兼容层。这使 yo-agent 的 MCP Server 组件可以无状态部署（Docker/serverless），为多实例水平扩展打好基础。RC 预计 2026-07-28 定稿，建议跟踪 Tier 1 SDK（TypeScript）对应版本。

---

## 参考来源

- [MCP 官方架构文档](https://modelcontextprotocol.io/docs/concepts/architecture)
- [MCP 当前稳定规范 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP 2026-07-28 Release Candidate 发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP TypeScript SDK（GitHub）](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Authorization 规范（OAuth 2.1 + RFC 8707）](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP 97M 下载量报道](https://www.digitalapplied.com/blog/mcp-97-million-downloads-model-context-protocol-mainstream)
- [MCP 服务器生态 2026](https://www.qcode.cc/mcp-servers-ecosystem-2026)
- [ACP 官网](https://agentclientprotocol.com/overview/introduction)
- [ACP GitHub 仓库](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP Session Setup 协议](https://agentclientprotocol.com/protocol/session-setup)
- [ACP Tool Calls 协议（9 种 kind 定义）](https://agentclientprotocol.com/protocol/tool-calls)
- [ACP Updates 日志（RFD 稳定化进度）](https://agentclientprotocol.com/updates)
- [Zed ACP 页面](https://zed.dev/acp)
- [JetBrains ACP Agent Registry 发布（2026-01-28）](https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/)
- [A2A 协议官方规范（v1.0）](https://a2a-protocol.org/latest/specification/)
- [A2A v1.0 发布公告（Signed Agent Cards 等）](https://a2a-protocol.org/latest/announcing-1.0/)
- [A2A vs MCP 官方对比](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)
- [A2A GitHub 仓库（a2aproject/A2A）](https://github.com/a2aproject/A2A)
- [Linux Foundation A2A 150+ 组织公告（2026-04）](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- [Linux Foundation 捐赠 A2A 公告](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [AGENTS.md 官网](https://agents.md/)
- [AGENTS.md GitHub 仓库](https://github.com/agentsmd/agents.md)
- [OpenAI Codex AGENTS.md 文档](https://developers.openai.com/codex/guides/agents-md)
- [Agent 互操作协议综述论文（MCP/ACP/A2A/ANP）](https://arxiv.org/html/2505.02279v1)
- [MCP Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)
