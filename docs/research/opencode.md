# opencode

> 开源 AI 编程 agent · anomalyco（原 SST 团队） · TypeScript（Bun） · MIT · https://github.com/sst/opencode（重定向至 anomalyco/opencode）

## 1. 是什么 / 定位

opencode 是一个终端优先的开源 AI 编程 agent，面向专业开发者，目标是取代 Cursor、Copilot CLI 等 SaaS 工具，让用户自带 API key 使用任意 LLM。2025 年 4 月 30 日首次提交，2025 年 6 月公开发布，截至 2026 年 6 月已积累约 177,800 GitHub stars，月活用户约 750 万（官网标注 7.5M，900+ 贡献者，13,000+ commits）。最新版本为 v1.17.9（2026-06-21），仍保持每周多次发布节奏。

架构上是 **TypeScript（Bun）单进程 server + 任意 client** 的 C/S 模型：`opencode serve` 启动本地 HTTP/WebSocket 服务器，TUI、IDE 插件或 ACP 客户端均通过该 server 接入。核心包为 `packages/opencode`，整个运行时基于 Effect-TS（函数式类型安全层）构建。

## 2. 架构总览（agent loop / 运行时主循环）

opencode 的 agent loop 是**流式单循环（Streaming Single-Turn Loop）**，不是严格 ReAct 推理链，而是基于 Vercel AI SDK 的 `streamText` 流。关键文件：`packages/opencode/src/session/processor.ts`。

**每轮执行流程：**
1. 用户 prompt → `session/prompt.ts` 组装 `ModelMessage[]`
2. `session/llm.ts` 调用 AI SDK `streamText`，model 并发输出 text chunk + tool_call
3. `session/processor.ts` 的 `ProcessorContext` 逐事件消费 `LLMEvent` 流：
   - `tool-call` → 写入数据库，触发 `Permission.ask()` 审批，并发执行工具
   - `finish-step` → 检查 overflow（context 超限），设 `shouldBreak`
   - `finish` → 若有工具结果，自动附上并开下一轮流；否则终止本 turn
4. 若 token 消耗超过 usable 上限（`isOverflow` 返回 true），自动触发 `SessionCompaction.create`
5. 若检测到"doom loop"（`DOOM_LOOP_THRESHOLD = 3`：相同工具连续重复 3 次），触发 `ask` 审批打断

**primary agent vs subagent：**
- Primary agent（build/plan 模式）由用户直接对话
- Subagent 由 `task` 工具发起，可同步（foreground）或异步（background）运行
- `mode: "primary" | "subagent" | "all"` 字段控制 agent 可用场景

**内置 agent（`packages/opencode/src/agent/agent.ts`）：**
- `general`：通用多步任务，支持并行执行多个工作单元
- `explore`：只读代码库探索（`edit/write/bash` 全 deny）
- `compaction`：隐藏的压缩 agent，负责生成对话摘要
- `summary`：隐藏的摘要 agent
- `plan`：plan 模式，所有写操作 deny

注意：早期文档提到的 "scout" 子 agent 在当前源码中**不存在**，已从内置列表移除。

**多 session 并行：**用户可同时运行多个 session，每个 session 独立跑 agent loop，通过 SQLite（Drizzle ORM）持久化。

## 3. 工具系统（内置工具集 + 函数调用机制 + MCP host/client）

**内置工具集**（`packages/opencode/src/tool/`，经源码核实）：

| 工具名 | 作用 |
|--------|------|
| `read` | 读文件 |
| `edit` | 编辑文件（apply_patch） |
| `write` | 写文件 |
| `glob` | 文件模式匹配 |
| `grep` | 代码关键词搜索 |
| `list` | 列目录 |
| `shell`（bash） | 执行 shell 命令 |
| `task` | 启动子 agent session（支持 background 模式） |
| `lsp` | 调 LSP server：goToDefinition、findReferences、hover、documentSymbol、workspaceSymbol、goToImplementation、prepareCallHierarchy、incomingCalls、outgoingCalls（9 种操作，31 个内置语言服务器） |
| `webfetch` | HTTP 抓取网页 |
| `websearch` | 网络搜索 |
| `plan` | 进入/退出 plan 模式 |
| `question` | 向用户提问（需 permission） |
| `todo` / `todowrite` | 任务清单管理 |
| `skill` | 加载 Skill（按需注入额外 prompt） |
| `truncate` | 裁剪输出以防 context 爆炸 |

**函数调用机制：**工具通过 `Tool.define(id, Effect.gen(...))` 注册，汇总进 AI SDK `tools: Record<string, Tool>` 参数传给 `streamText`。工具每次调用前经 `Permission.ask()` 检查（allow/ask/deny 三态）。

**MCP host/client：**opencode 是 **MCP Client**（不是 server）。支持三种传输方式（经 `packages/opencode/src/mcp/index.ts` 核实）：
- `stdio`：本地进程（`StdioClientTransport`）
- `sse`：Server-Sent Events（`SSEClientTransport`）
- `streamable-http`：Streamable HTTP（`StreamableHTTPClientTransport`，MCP 最新标准）

MCP OAuth 2.0 已实现（`mcp/oauth-provider.ts`）。MCP 工具注册后与内置工具统一进入 permission 审批流（`McpCatalog` 管理）。能力声明中已预留 `sampling`、`elicitation`、`tasks` 字段（当前代码中均注释掉，分别对应 issue #11948、#23066、#28567）；`roots` 已启用。

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

**Context 窗口管理（`session/overflow.ts` + `session/compaction.ts`，经源码核实）：**

- `isOverflow()` 计算：`total_tokens >= usable()`，其中 `usable = model.limit.input - reserved`（默认 reserved = `COMPACTION_BUFFER = 20_000` 或 maxOutputTokens 的较小值）
- `PRUNE_MINIMUM = 20_000`、`PRUNE_PROTECT = 40_000`：compaction 内部用于判断工具输出是否需要裁剪
- 工具输出截断上限 `TOOL_OUTPUT_MAX_CHARS = 2000`，防单次 tool result 爆炸
- `PRUNE_PROTECTED_TOOLS = ["skill"]`：skill 内容不被截断

**上下文压缩（Compaction）：**
- 检测到 overflow 时，启动隐藏的 `compaction` agent（独立 session，使用 `compaction.txt` prompt），生成摘要注入对话头部
- `MIN_PRESERVE_RECENT_TOKENS = 2_000`、`MAX_PRESERVE_RECENT_TOKENS = 8_000`（约占 usable 空间 25%）：保留最近原始消息
- `DEFAULT_TAIL_TURNS = 2`：默认保留最近 2 轮完整原始对话
- `completedCompactions()` 跟踪已压缩轮次，避免重复压缩

**长期记忆：**
- 不存在独立的向量数据库或 embedding 索引
- 通过 `AGENTS.md` / `SKILL.md` 等文件为 agent 提供项目级持久上下文
- 会话全程持久化在 SQLite（`~/.local/share/opencode/`），支持跨重启恢复（`/resume` 命令，ACP `resumeSession`）

## 5. Prompt / 系统提示策略（约定文件、模式）

**约定文件：**
- `AGENTS.md`：项目根目录，描述项目背景、代码规范、常用命令，随 `/init` 命令生成，建议提交至 Git
- `SKILL.md`：技能文件，发现路径（经文档核实）覆盖 6 个位置：项目级 `.opencode/skills/<name>/`、`.claude/skills/<name>/`、`.agents/skills/<name>/`；全局级 `~/.config/opencode/skills/<name>/`、`~/.claude/skills/<name>/`、`~/.agents/skills/<name>/`

**系统 prompt 策略（`session/system.ts`，经源码核实）：**
- 针对不同 provider/model 使用专属 prompt 文件：`anthropic.txt`、`gpt.txt`、`gemini.txt`、`kimi.txt`、`beast.txt`（gpt-4/o1/o3）、`codex.txt`、`trinity.txt`、`copilot-gpt-5.txt`、`default.txt`（兜底）
- 每次构造 system prompt 时注入：当前工作目录、worktree、git 状态、日期、可用 skills 列表、项目 references
- 插件系统可通过 `experimental.chat.system.transform` hook 动态修改 system prompt

**模式（Plan/Build）：**
- build mode：默认，全工具权限
- plan mode：`edit.*` 全 deny（除 `.opencode/plans/*.md`），bash deny；按 Tab 键切换，也可由 `plan_exit` 工具自动退出

**TodoWrite 机制：**系统提示强调频繁使用 `todo` / `todowrite` 工具跟踪进度，是 opencode 内置的轻量任务管理层。

## 6. 权限与审批（工具执行如何获批、沙箱）

**权限系统（`permission/index.ts`，经源码核实）：**

采用**基于 glob 模式的分层规则表（Ruleset = Rule[]）**，每条规则：`{ permission: string, pattern: string, action: "allow" | "ask" | "deny" }`。`evaluate()` 用 `findLast()` 取最后匹配规则，支持通配符优先级。

规则链合并：defaults → agent 级 permission → 用户 opencode.json permission（后规则覆盖前规则）。

**内置 permission key：**`read`、`edit`、`glob`、`grep`、`list`、`bash`（shell）、`task`、`lsp`、`webfetch`、`websearch`、`question`、`skill`、`external_directory`、`plan_enter`、`plan_exit`、`doom_loop`、`todowrite` 等。

**默认策略：**
- 项目目录内：大多数工具 `allow`
- `.env*` 文件读取：`ask`（白名单放行 `.env.example`）
- 外部目录访问：`ask`
- doom_loop（工具重复 3 次）：`ask`

**审批流程：**`Permission.ask()` 向 event bus 发布 `permission.asked` 事件，TUI/ACP client 拦截后展示给用户；用户点击 allow/deny/always，通过 `Permission.reply()` 解决 Deferred。拒绝时自动取消同一 session 中所有 pending 权限请求。

**沙箱：**无内置 seatbelt/landlock/Docker 隔离。权限完全依赖配置规则，由用户和 agent 配置自我约束。这是公认短板。

## 7. 多平台 / 传输 / 接入层

**接入方式：**
- **TUI**：原 Go 实现已废弃，现为 TypeScript/Bun 版终端界面
- **Desktop App**（BETA）：macOS/Windows/Linux 原生包（dmg/msi/deb 等）
- **CLI**：`opencode` 命令行，`opencode serve` 暴露 HTTP+WebSocket server（mDNS 广播）
- **IDE 集成**：`src/ide/index.ts`，通过 HTTP API 与 Neovim/VS Code 等对接

**协议层：**
- **ACP（Agent Client Protocol）**：已完整实现（`src/acp/service.ts`，经源码核实）。通过 `@agentclientprotocol/sdk` 提供标准化 session 管理 API：`initialize`、`authenticate`、`newSession`、`loadSession`、`listSessions`、`resumeSession`、`closeSession`、`forkSession`、`setSessionConfigOption`、`setSessionMode`、`setSessionModel`、`prompt`、`cancel`。使 opencode 可作为第三方 ACP 客户端（如 GitHub Copilot、Cursor）的后端 agent。
- **MCP**：作为 client 连接外部 MCP server（stdio/SSE/streamable-http + OAuth）
- **Share**：`/share` 命令将 session 同步到 opencode 云端，生成 `opncd.ai/s/<id>` 公开可读链接
- **GitHub/GitLab 集成**：可从 PR/Issue 评论触发 agent；GitLab Workflow Language Model 通过 WebSocket 双向工具调用

## 8. 插件 / 扩展 / 子 agent

**Skill 系统：**
- Markdown 文件（`SKILL.md`），YAML frontmatter 定义 name/description
- 发现路径覆盖项目级和全局级共 6 个目录（见第 5 节）
- Agent 通过 `skill` 工具按需加载（lazy），不预置入 context，节省 tokens
- 内置 `customize-opencode` skill，覆盖 opencode.json 配置 schema

**Plugin 系统（`src/plugin/`）：**
- Plugin 可注册 MCP server、注入 skills、修改 system prompt（`experimental.chat.system.transform` hook）
- `opencode plugin create` 生成脚手架

**自定义 Agent：**
- JSON 配置 `opencode.json` 中 `agent` 字段，或 `.opencode/agents/<name>.md` Markdown 文件
- `opencode agent create` 交互式创建：指定 mode、model、permission、prompt
- `mode: "subagent"` 的 agent 由主 agent 通过 `task` 工具调用，parent session permission 通过 `deriveSubagentSessionPermission` 向下派生（只能缩紧不能放宽）

**Multi-agent 并发（`tool/task.ts`，经源码核实）：**subagent 支持 `background: true`，在独立 session 中异步运行，完成后通过 synthetic 结果消息（`<task id="..." state="completed">...</task>` XML 标签）注入父 session；主 agent 收到 completion 通知后继续，无需 sleep/poll。

## 9. Provider 抽象（是否 BYOK 多模型）

**完全 BYOK。** opencode 通过以下两层实现 75+ provider 支持：
1. **Vercel AI SDK**：统一的 `streamText` / `generateObject` 调用接口，屏蔽各 provider API 差异
2. **models.dev**：标准化模型目录，自动拉取各 provider 模型列表、context window、output token 上限

API key 通过 `/connect` 命令写入 `~/.local/share/opencode/auth.json`（本地存储，不上传）。支持 OAuth（GitHub Copilot、GitLab）和 API key 两种鉴权模式。

特殊处理：
- OpenAI OAuth（Copilot）：系统提示通过 `providerOptions` 注入而非 system message（API 限制）
- GitLab DWS Workflow 模型：WebSocket 双向通信，工具调用在本地执行后结果回传
- Google Vertex AI Anthropic：支持 `eu`/`us` 多区域端点
- 自定义 OpenAI 兼容 API：可配置 baseURL + headers

**OpenCode Zen / OpenCode Go**：官方托管订阅服务（opencode.ai/auth 注册），Zen 提供经测试的优质模型（如 Qwen 3 Coder 480B）推荐列表，Go 为低成本套餐提供可靠流量，免去用户自备 key。

## 10. 亮点设计 / 短板 / 坑

**亮点：**
1. **Effect-TS 全栈类型安全**：整个 server 用 `Effect`、`Layer`、`Schema`、`Context` 构建，依赖注入极度清晰，副作用可测试，服务间完全解耦
2. **ACP 协议原生支持**：opencode 实现完整 ACP server 端，向第三方 client 暴露 13 个标准 API，可被任意 ACP 兼容 IDE 直接接管，无需为每个平台单独写适配层
3. **多 agent 树形 session 设计**：parent/child session 树 + SQLite 持久化，支持 `resumeSession`、`forkSession`；background subagent 通过 XML 标签 synthetic 消息注入结果，主 agent 无需 polling
4. **Skill lazy-load 机制**：技能文件不预置入 context，agent 按需通过 `skill` 工具拉取，大幅节省 token 用量；skill 内容在 compaction 时受 `PRUNE_PROTECTED_TOOLS` 保护不被截断
5. **分层 permission ruleset**：glob 模式匹配 + `findLast` 优先级语义，defaults → agent → user 三层链式合并，精细可控
6. **LSP 集成**：内置 31 个语言服务器，`lsp` 工具支持 9 种精确语义操作（goToDefinition/findReferences/hover/documentSymbol/workspaceSymbol/goToImplementation/prepareCallHierarchy/incomingCalls/outgoingCalls），让 agent 具备 IDE 级代码理解能力
7. **自动 compaction**：overflow 触发时调独立 compaction agent 生成摘要，保留最近 2–8k 原始 tokens，无缝续接长任务

**短板 / 坑：**
1. **无沙箱隔离**：shell 工具执行在宿主机，无 landlock/Docker，恶意或误操作 agent 可对系统造成真实影响
2. **单机单用户设计**：session 持久化在本地 SQLite，天然不支持多用户、云端同步（share 功能仅为只读快照分享）
3. **重度依赖 Effect-TS**：学习曲线陡峭，贡献门槛高，且绑定 Bun 运行时（Node.js 兼容性需额外工作）
4. **Desktop App 仍为 BETA**：TUI 稳定性时有问题，历史遗留技术债（早期 Go TUI 已废弃）
5. **MCP sampling/elicitation/tasks 未完整支持**：相关能力代码中注释掉（issue #11948/#23066/#28567），影响高级 MCP 场景

## 11. 对 yo-agent 的具体启示

1. **用"能力域"而非"工具黑名单"描述权限**：opencode 的 permission 系统用 `{ permission, pattern, action }` 三元组 + glob 匹配，既能精确到 `read: { "*.env": "ask" }`，又能通配 `"*": "allow"`。yo-agent 面向多平台（QQ/Telegram/Discord + 本地代码工具），权限粒度不够会导致滥权，建议直接采用类似分层 ruleset 设计而非简单布尔开关。

2. **Skill lazy-load 是多平台聊天 bot 的救命稻草**：QQ/Telegram 对话窗口 context 远比编程 agent 小。opencode 的 `SKILL.md` 按需注入机制可直接移植：为不同聊天场景（群管理/技术答疑/提醒）各写一份 Skill，agent 识别用户意图后再 load，避免 system prompt 膨胀。注意：skill 内容应在 compaction 时受保护，否则压缩后 agent 会"忘记"技能。

3. **ACP 协议值得作为 yo-agent 的对外接口标准**：ACP 定义了 13 个标准 session 管理 API。yo-agent 若实现 ACP server 端，未来可直接被 opencode、Cursor 等支持 ACP 的工具调用，零额外集成成本。

4. **Session 树 + background subagent 是并发任务的正确抽象**：yo-agent 可能需要同时处理"搜索资料 + 写报告 + 发 Telegram 通知"等并发任务。opencode 的 parent/child session + `background: true` + XML 标签 synthetic 消息注入模式清晰分离了任务调度与结果聚合，不必重新发明 Promise.all 式拼接。

5. **compaction agent 做独立服务而非内嵌逻辑**：opencode 把 compaction 抽成隐藏 agent，有独立 prompt（`compaction.txt`）和独立 session 运行。yo-agent 处理长对话时应同样将"摘要压缩"当作独立可替换组件，方便针对不同 provider 调优压缩策略（如 Claude 用 claude-3-5-haiku 做压缩，GPT 用 gpt-4o-mini）。

6. **多 provider 抽象用 AI SDK + models.dev 的组合是成熟方案**：yo-agent 作为 TypeScript/Node 单栈项目，直接引入 Vercel AI SDK 即可获得 75+ provider 的统一接口；models.dev 提供动态模型目录，避免硬编码 context window。无需自研 provider 抽象层。

## 参考来源

- https://github.com/sst/opencode（重定向至 anomalyco/opencode）
- https://github.com/anomalyco/opencode
- https://opencode.ai/docs
- https://opencode.ai/docs/agents
- https://opencode.ai/docs/skills
- https://opencode.ai/docs/providers
- https://opencode.ai/docs/lsp
- https://opencode.ai/docs/share
- GitHub API：`gh api repos/sst/opencode`（stars 177,800，TypeScript，MIT，2025-04-30 创建，2026-06-24 更新，latest release v1.17.9 2026-06-21）
- `packages/opencode/src/session/processor.ts`（agent loop、doom loop 逻辑）
- `packages/opencode/src/session/overflow.ts`（isOverflow 计算）
- `packages/opencode/src/session/compaction.ts`（PRUNE_MINIMUM/PRUNE_PROTECT 常量）
- `packages/opencode/src/session/system.ts`（provider-specific prompt 选择逻辑）
- `packages/opencode/src/session/prompt/`（anthropic.txt/beast.txt/codex.txt/copilot-gpt-5.txt/default.txt/gemini.txt/gpt.txt/kimi.txt/trinity.txt）
- `packages/opencode/src/acp/service.ts`（ACP 13 个标准 API）
- `packages/opencode/src/mcp/index.ts`（stdio/SSE/streamable-http 三种传输，OAuth 2.0，sampling/elicitation/tasks 注释）
- `packages/opencode/src/permission/index.ts`（evaluate/findLast ruleset 实现）
- `packages/opencode/src/tool/task.ts`（background subagent 机制）
- `packages/opencode/src/tool/lsp.ts`（9 种 LSP 操作）
- `packages/opencode/src/agent/agent.ts`（内置 agent：general/explore/compaction/summary/plan，无 scout）
- `packages/opencode/src/skill/index.ts`（skill 发现路径）
