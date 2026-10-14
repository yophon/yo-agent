# Nanobot (obot-platform/nanobot)

> 一句话：由 Obot AI（前身 Acorn Labs）开源的 Go 语言独立 MCP Host 框架，通过 YAML/Markdown DSL 将 MCP Server 包装为可对话 agent，内置 Svelte 5 Web UI 与 Claude Code 式系统工具集；Apache 2.0；仓库 https://github.com/obot-platform/nanobot（旧镜像 https://github.com/nanobot-ai/nanobot）

---

## 1. 是什么 / 定位

Nanobot 是一个**可独立部署的 MCP Host（Model Context Protocol 宿主）**，核心定位是："把任意 MCP Server 用 LLM + 系统提示 + 工具编排包裹起来，向用户呈现 agent 体验"。与 VSCode、Claude、Cursor 等应用内嵌的 MCP Host 不同，Nanobot 是专门的、可独立运行的服务进程。

**作者/厂商**：Obot AI（前身 Acorn Labs），CEO Sheng Liang（曾创建 Rancher Labs 和 Cloud.com），2025 年 9 月完成 $35M 种子轮（Mayfield / Nexus 领投）。

**语言栈**：Go 84.4%（后端运行时）+ Svelte 5 / TypeScript（前端 UI，SvelteKit + TailwindCSS 4 + DaisyUI）。Go 运行时嵌入 `goja`（JavaScript 引擎）用于 Hooks。

**版本状态**：v0.0.86（2026-06-22 发布），仍处 alpha，自称"significant breaking changes, architectural shifts, and evolving APIs"。

**注意**：HKUDS/nanobot 是香港大学团队的完全不同 Python 项目，本报告仅覆盖 obot-platform 版本。

---

## 2. 架构总览（agent loop / 运行时主循环）

**单循环 ReAct 模式**（Tool-Use 驱动，无显式 maxToolIterations 限制，靠 context 窗口压缩保底）：

```
用户输入
  → Agents.Run：加载 config hook（TypeScript）、组装工具映射、填充历史
  → 若上下文估算超 contextWindow × 83.5%  → compact()（LLM 摘要压缩）
  → LLM Call（携带当前工具 JSON Schema）
  → 若 response 含 tool_calls → toolCalls() 执行 → 追加结果 → 回到 LLM Call
  → 若 response 为纯文本，或 ToolCallPolicyViolation → Done = true → 输出
```

核心组件：
- `pkg/agents/run.go`：主循环（`for {}` 无上限，`currentRun.Done` 为终止条件）
- `pkg/agents/compact.go`：上下文自动压缩（见第 4 节）
- `pkg/agents/truncate.go`：单条工具结果超 50 KiB 时截断并写入磁盘，返回文件路径
- `pkg/sampling/sampler.go`：MCP sampling 协议 + 模型优先级排序
- `pkg/tools/`：工具执行层；`pkg/mcp/`：MCP 协议层（stdio + HTTP/SSE）

**并发模型**：per-session 串行（单会话内按轮次顺序执行），跨 session 并发，每轮结束后 checkpoint 到数据库，支持 `/stop` 打断。

---

## 3. 工具系统（内置工具 + MCP 双向支持）

**Nanobot 既是 MCP Client（接入外部 Server）又能将 agent 暴露为 MCP Server（服务端侧）**。

### 内置 MCP Server（`pkg/servers/`）

| 包路径 | 内容 |
|---|---|
| `servers/system` | 核心系统工具：`bash`、`read`、`write`、`edit`、`glob`、`grep`、`webFetch`、`todoWrite`、`askUserQuestion`、`listSkills`、`getSkill` |
| `servers/agent` | 把当前 agent 暴露为 MCP Server（A2A 核心，含 `chat` 工具、elicitation） |
| `servers/skills` | skills 管理 |
| `servers/workflows` | 工作流编排（alpha） |
| `servers/tasks` | 任务执行（alpha） |
| `servers/artifacts` | 产物存储 |
| `servers/meta` | 元数据工具（list_chats / list_agents 等） |

系统工具权限通过 Agent `permissions` 字段按能力维度控制（见第 6 节）。

### 外部 MCP Server 接入

`nanobot.yaml` 的 `mcpServers` 块配置，支持：`url`（HTTP/SSE 远端）、`command`（本地 stdio 进程）、Docker 容器、Git 仓库 clone 后执行。默认走 Docker 沙箱隔离（`unsandboxed: true` 可关闭）。

**工具引用格式**：`server/tool` 跨 Server 引用，或直接 `tool`（当前 server 内）。

**函数调用**：标准 JSON Schema 描述，复用 OpenAI/Anthropic tool_use 格式，无专有协议。

**审计日志**：`pkg/mcp/auditlogs` 记录每次 MCP 调用。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

### 自动上下文压缩（v0.0.x 已实现）

`pkg/agents/compact.go` 实现 LLM 驱动的对话压缩：

- **触发阈值**：估算 token 数超过 `contextWindow × 0.835` 时触发（`contextWindow` 默认 200,000 tokens，可在 agent 配置中覆盖）。
- **压缩机制**：调用 LLM 将历史对话摘要为结构化文本（Goal / What Happened / Current State / Next Steps / Open Questions），随后将压缩摘要注入 context 替换原始历史，允许对话无限延续而不超限。
- **渐进式 recompaction**：已存在摘要时，新消息与旧摘要合并更新，不重写整体历史。
- 压缩结果存于 `Execution.CompactedMessages`，写回数据库 checkpoint。

### 工具结果截断

单条工具输出超 50 KiB 时，`pkg/agents/truncate.go` 将完整内容写至 `sessions/<id>/truncated-outputs/` 文件，仅向 LLM 返回路径提示（防 context 爆炸）。

### 会话持久化

`pkg/session` / `pkg/sessiondata` 将对话历史写入数据库（SQLite / MySQL / PostgreSQL，GORM），WebSocket 实时推送，刷新页面可恢复会话。

### 长期记忆

通过 `MEMORY.md` 文件注入 context（持续加载）；Skills 的摘要列表注入 system prompt，全文按需通过 `getSkill` 工具展开（懒加载）。Web UI 正在开发记忆编辑器（PR #334，active）。

---

## 5. Prompt / 系统提示策略

**配置驱动，非代码驱动**：agent 系统提示写在 YAML/Markdown 配置中，无需写 Go 代码。

两种格式：
1. **单文件 YAML**（`nanobot.yaml`）：`agents.<name>.instructions` 字段（支持静态字符串或 MCP Server 动态生成提示）。
2. **目录结构**（推荐）：`agents/<name>.md`，YAML front-matter 放元数据，Markdown body 即 system prompt，`main.md` 为默认入口。

```yaml
# agents/main.md
---
name: Shopping Assistant
model: anthropic/claude-3-7-sonnet-latest
mcpServers:
  - store
temperature: 0.7
---

你是一个购物助手，负责根据用户需求推荐商品...
```

**Hooks（TypeScript/JavaScript via goja）**：支持三类 lifecycle hook：`config`（修改 agent 配置）、`request`（修改发往 LLM 的请求）、`response`（后处理 LLM 响应），在 Go 运行时以 JS 函数形式内嵌执行。

**Skills（Markdown 插件）**：`skills/` 目录存放 `.md` 文件，每条包含技能名称 + 描述；运行时注入摘要目录到 system prompt，LLM 自行决策是否调用 `getSkill` 加载全文（两级懒加载，避免 context 膨胀）。内置 skills：browser-use、python-scripts、scheduled-tasks、workflows 等。

**无 plan/act 双模式**：当前纯 ReAct 单循环，无显式计划-执行分离。

---

## 6. 权限与审批（工具执行如何获批、沙箱）

### 权限模型（per-capability 白名单）

Agent 配置中的 `permissions` 字段按工具能力维度控制访问：

```yaml
agents:
  main:
    permissions:
      bash: allow      # 启用 bash 工具
      read: allow      # 启用 read 工具
      write: deny      # 禁止 write/edit 工具
      webFetch: allow
```

`pkg/servers/system/config.go` 中定义了 `allowedPermsToTools` 映射（bash → bash；write → write + edit；skills → getSkill 等），通过 config hook 在每次请求前注入实际可用工具列表。这比全量 `require_approval: "always"` 更细粒度。

### Docker 沙箱

`pkg/mcp/sandbox/sandbox.go` 实现容器隔离：
- 按 `nanobot.yaml` 的 `dockerImage` / `dockerfile` 字段构建或复用基础镜像
- `docker run -u <host-UID>:<host-GID>`，保证文件权限一致性
- 工作目录和数据卷按配置挂载；端口通过 reverse port mapping 转发
- `unsandboxed: true` 可绕过沙箱（慎用）

**MCP 审计日志**：`pkg/mcp/auditlogs` 记录所有工具调用，为事后审计而非实时拦截。

**elicitation 机制**：OAuth 授权场景通过 MCP Elicitation 协议（`elicitation/create`）向用户请求确认，15 分钟超时（`pkg/confirm/confirm.go`）。

---

## 7. 多平台 / 传输 / 接入层

**已实现**：
- **Web Chat UI**：内置 Svelte 5 + SvelteKit，默认 `:8080`；开发模式下 `:5173`（自动代理）；WebSocket 实时推送；支持 MCP-UI 协议渲染视觉组件。
- **CLI**：`nanobot run`（启动服务）/ `nanobot call`（单次工具调用）/ `nanobot targets`（列出 agents & tools）。
- **MCP Server 暴露**：`pkg/servers/agent` 把整个 agent 打包为 MCP Server，外部系统（Claude Desktop、Cursor 等）可直接通过 MCP 协议调用。
- **Sampling A2A**：MCP sampling 协议实现 agent-to-agent 的 LLM 推理委派。
- **OAuth**：v0.0.81+ 支持 MCP Server OAuth 参数传递，v0.0.86 新增 CIMD（Client ID Metadata Document / RFC 7591 动态客户端注册）支持，session 内持久化 token。

**规划中（README 提及，未完全实现）**：voice、SMS、email、AR/VR、Slack。Obot 主产品已支持 Slack，Nanobot 框架层尚未内置 IM 连接器。

**协议**：MCP（完整客户端 + 服务端）/ MCP-UI（部分实现，roadmap）/ MCP Elicitation / 不支持 OneBot / ACP。

---

## 8. 插件 / 扩展 / 多 agent 编排

**同进程多 Agent**：`agents/` 目录下多个 `.md` 文件，`main.md` 为入口。每个 agent 有独立的 model、mcpServers、permissions、instructions 配置。

**A2A 委派（跨进程）**：
- `pkg/servers/agent` 把整个 agent（prompt + model + tools）暴露为单一 MCP Server，外部只见一个 `chat` 工具，而非底层 N 个工具——这是 Nanobot 最核心的多 agent 设计，大幅压缩调用方 context。
- Sampling 接口统一 agent-to-agent 调用，MCP Client → MCP Host 发起 LLM 推理请求。
- `pkg/sampling/sampler.go` 实现基于 cost / speed / intelligence 评分的模型选择（用于委派到合适的子 agent）。

**Skills 插件**：`skills/` 目录 Markdown 文件，LLM 看摘要目录，按需 `getSkill` 展开，50+ 条不撑爆 context。

**Hooks（TypeScript via goja）**：config / request / response 三类，支持修改 agent 配置和消息。

**Workflows / Tasks**：`pkg/servers/workflows` 和 `pkg/servers/tasks` 提供结构化任务编排，仍处 alpha，文档不足。

---

## 9. Provider 抽象（BYOK 多模型）

**完整 BYOK + 多 dialect**：

```yaml
llmProviders:
  myAzure:
    dialect: OpenAIResponses
    apiKey: ${AZURE_API_KEY}
    baseURL: https://<resource>.cognitiveservices.azure.com/openai/v1

  localOllama:
    dialect: OpenResponses
    baseURL: http://localhost:11434/v1
```

**内置 dialect**：
- `OpenAIResponses`：OpenAI Responses API（默认）
- `OpenAIChatCompletions`：Chat Completions API（兼容旧版）
- `AnthropicMessages`：Anthropic Messages（v0.0.85 修复：不再错误发送 temperature/top_p 给 Anthropic）
- `OpenResponses`：泛 OpenAI 兼容（Ollama、本地模型）

**自动路由**：model 字段格式 `<provider>/<model-id>`（如 `anthropic/claude-3-7-sonnet-latest`），运行时自动分流，无需显式指定 provider 字段。

**实现层**：`pkg/llm/bifrost` 做 provider 抽象，各 dialect 在 `pkg/llm/` 子包实现。

---

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **"Agent as MCP Server" A2A 模式**：整个 agent（prompt + model + tools）打包成单一 MCP 工具暴露，调用方只见 `chat` 接口而非底层 N 个工具，极大压缩多 agent 编排的 context 开销，且天然兼容任意 MCP Client（Claude Desktop、Cursor 均可直接接入）。

2. **LLM 驱动的自动 context 压缩**：`pkg/agents/compact.go` 在 context 达 83.5% 阈值时自动调用 LLM 摘要历史，将对话压缩为结构化 Handoff 文档，允许无限长会话而不截断。这是 v0.0.x 版本中已实现的关键能力，原始资料对此严重低估。

3. **Claude Code 式内置系统工具集**：`servers/system` 内置 bash、read/write/edit/glob/grep 文件工具、webFetch、todoWrite、askUserQuestion，本质上是一个内嵌的代码执行 agent 底层工具集，无需外接 MCP Server 即可完成文件操作和 Shell 执行。

4. **YAML/Markdown DSL 零代码定义 agent**：`agents/<name>.md` front-matter 即配置，Markdown 正文即 system prompt，Skills 懒加载解决工具目录膨胀问题，非技术背景用户可直接操作。

5. **Docker 沙箱隔离**：自动以宿主 UID/GID 运行容器，volume 挂载 + reverse port mapping，支持自定义 Dockerfile，跨平台可移植。

6. **MCP-UI 视觉验证循环**：业务状态由 MCP Server 权威维护，UI 仅渲染，用户交互回传 agent，LLM 幻觉无法直接污染关键状态。

### 短板与坑

1. **Alpha 不稳定**：v0.0.x，自述"moving away from its original design and intent"，内部 Go API 不适合直接依赖。

2. **无原生 IM 平台适配**：Slack/Telegram/QQ/Discord 均不支持（Slack 在 Obot 主产品有，Nanobot 框架层无）。

3. **Go 语言栈**：对 TS/Node 工程师不友好，npm 生态无法复用，贡献门槛高于 Python/Node 框架。

4. **权限粒度仍较粗**：`permissions` 字段按工具类别（bash/read/write）而非单条工具控制；无类似 Claude Code `allowedTools` 的路径级或命令级白名单。

5. **MCP-UI 尚未完整实现**：roadmap 中，视觉交互场景受限。

6. **context 压缩触发后历史细节丢失**：LLM 摘要不可避免损失原始对话精确内容，对需要精确引用早期输出的任务存在风险。

---

## 11. 对 yo-agent 的具体启示

1. **移植 "Agent as MCP Server" A2A 设计**：yo-agent 的各子 agent（编程 agent / QQ agent / 搜索 agent）均可暴露为 MCP Server，上层 orchestrator 只需 `chat` 一个工具，彻底解耦编排且可被任意外部 MCP Client 接入。

2. **借鉴 `agents/<name>.md` DSL**：front-matter 存 model/tools/platform/temperature，Markdown 正文是 system prompt，用户无需写代码即可定义新 agent 实例，大幅降低配置门槛。

3. **LLM 驱动的 context 压缩**：yo-agent 处理长会话时可复用 nanobot 的 compact → Handoff Summary 模板（Goal / What Happened / Current State / Next Steps），在 context 接近上限前自动摘要，而非硬截断。

4. **Skills 懒加载模式**：50+ MCP 工具时，把工具描述按技能分组存为 Markdown，context 只注入摘要目录，触发时按需展开全文，比一次性塞入 system prompt 更经济。

5. **`<provider>/<model-id>` 单字符串 provider 路由**：BYOK 配置只需一行 `anthropic/claude-sonnet-4-5`，框架自动分流，减少双字段配置噪音。

6. **工具结果截断策略**：大输出写磁盘 + 仅返回路径（nanobot 的 50 KiB 阈值）比传入全文更安全，可直接借鉴用于 diff/代码补丁场景。

7. **"状态由服务端权威管理"原则**：yo-agent 的代码变更审批状态（pending/approved/rejected）存于服务端状态机，UI 只渲染，用户点击 approve 触发服务端转换，避免 LLM 幻觉跳过审批。

---

## 参考来源

- https://github.com/obot-platform/nanobot — 当前主维护仓库
- https://github.com/nanobot-ai/nanobot — 旧 org 镜像（v0.0.79 前）
- https://github.com/obot-platform/nanobot/releases — 版本历史（v0.0.86 最新，2026-06-22）
- https://github.com/obot-platform/nanobot/blob/main/CLAUDE.md — 架构说明文档（核查来源）
- https://github.com/obot-platform/nanobot/blob/main/pkg/agents/compact.go — context 压缩实现（核查来源）
- https://github.com/obot-platform/nanobot/blob/main/pkg/agents/run.go — agent 主循环（核查来源）
- https://github.com/obot-platform/nanobot/blob/main/pkg/servers/system/server.go — 内置工具集（核查来源）
- https://github.com/obot-platform/nanobot/blob/main/pkg/config/schema.yaml — 配置 Schema（核查来源）
- https://obot.ai/blog/introducing-nanobot-a-new-framework-for-turning-mcp-servers-into-ai-agents/ — 官方发布博客（2025-09）
- https://www.prnewswire.com/news-releases/obot-ai-secures-35m-seed-to-build-enterprise-mcp-gateway-302563687.html — $35M 融资公告
- https://pkg.go.dev/github.com/nanobot-ai/nanobot — Go 包文档（v0.0.78）
- https://brightdata.com/blog/ai/nanobot-with-web-mcp — MCP 工具接入实例
