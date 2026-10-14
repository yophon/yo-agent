# LangBot

> 生产级多平台 LLM 即时通讯 bot 开发平台，原名 QChatGPT · 作者 RockChinQ / langbot-app 组织 · Python（后端 ~58%）+ TypeScript（前端 ~37%）+ JavaScript（~4%）· Apache-2.0 · https://github.com/langbot-app/LangBot

## 1. 是什么 / 定位

LangBot（前身 QChatGPT，v4.x 后正式更名）是一个**以 IM bot 为核心场景的生产级 LLM 应用平台**，定位介于"聊天机器人框架"与"低代码 AI 应用编排平台"之间。核心卖点：一套代码库无缝接入 Discord、Telegram、Slack、LINE、QQ、微信（个人/公众号）、企微（3 种模式）、飞书、钉钉、KOOK、Satori、Email、Matrix、OpenClaw 微信、通用 WebSocket 等 17-19 个平台适配器；内建 Agent、RAG 知识库、MCP 双角色（Client + Server）、Skills、沙箱（Box Runtime）与插件进程隔离；配套全功能 WebUI（Vite + React Router 7 + shadcn/ui），无需手写配置文件即可运维。

截至 2026-06-23，主仓库 `langbot-app/LangBot`：**v4.10.4**（最新稳定）、16,430 Stars、1,459 Forks、114 open issues。v4.10.0（2026-06-04）正式发布"Agentic Sandbox & Skills"，是近期最大功能里程碑。

**语言比例（GitHub API 实测）**：Python 3,935,243 bytes（~58%）/ TypeScript 2,541,490 bytes（~37%）/ JavaScript 277,028 bytes（~4%）/ 其余 CSS、Shell、Dockerfile 合计不足 1%。

## 2. 架构总览（agent loop / 运行时主循环）

### 整体分层

```
IM 平台适配层 (src/langbot/pkg/platform/sources/)   ← 17-19 个适配器文件
    ↓ 消息事件
Pipeline 层 (src/langbot/pkg/pipeline/)
  PreProcessor → ConversationMessageTruncator → [plugins PromptPreProcessing] → Process → ResponseBack
    ↓ Query 对象贯穿各阶段
Provider / Runner 层 (src/langbot/pkg/provider/runners/)
  LocalAgentRunner | DifyRunner | n8nRunner | CozeRunner | LangflowRunner | ...
    ↓ 流式 / 非流式 LLM 调用（LiteLLM 统一后端）
Tool Manager (src/langbot/pkg/provider/tools/)
  NativeToolLoader | PluginToolLoader | MCPLoader | SkillToolLoader
```

Pipeline 是有序的 **Stage 链**，每个 Stage 接收 `Query` 对象并返回 `StageProcessResult`（CONTINUE / INTERRUPT / REJECT）。Stage 类通过装饰器 `@stage_class('StageName')` 注册。

### Agent Loop（LocalAgentRunner）

`src/langbot/pkg/provider/runners/localagent.py` 实现**标准 Function Calling 工具调用循环**，无 ReAct 文本推理模式，依赖 LLM 原生 function calling：

```
用户消息 → 注入沙箱附件路径 → 拼接 prompt + 历史 → LLM 推理
    ↓ 如果返回 pending_tool_calls
    for each tool_call: execute_func_call() → role=tool 消息追加
    ↓ 再次 LLM 推理
    ... 最多 MAX_TOOL_CALL_ROUNDS = 128 轮（硬上限，超出则 warn 并终止）
    ↓ 无 tool_calls → yield 最终回复
```

关键设计（源码核实）：
- **Fallback 模型**：维护 primary + `_fallback_model_uuids` 有序列表；首次成功后"commit to it for the tool call loop"——锁定该模型，避免跨模型 tool result 解读不一致。
- **流式/非流式统一**：`run()` 是单一 `async def run(query) -> AsyncGenerator[Message | MessageChunk, None]`，通过 `is_stream` flag 分支，使用 `_StreamAccumulator` 每 8 chunks 或完成时 yield。
- **128 轮上限**：对抗 adversarial prompt 或 looping 模型，防止失控成本。

### 外部 Runner

Pipeline 可切换为 Dify、n8n、Langflow、Coze、TBox、DeerFlow、WeKnora 等平台；这些平台自行管理 prompt/工具/模型，LangBot 充当 IM 适配层与消息转发器。

## 3. 工具系统（内置工具集 + 函数调用机制 + MCP 双向角色）

### 内置沙箱工具（Native Tools）

`src/langbot/pkg/provider/tools/loaders/native.py` 定义 6 个工具（无沙箱时返回空列表）：

| 工具名 | 功能 |
|--------|------|
| `exec` | 沙箱内执行 shell 命令 / Python / 计算 |
| `read` | 读取 /workspace 下文件 |
| `write` | 写入文件 |
| `edit` | 精确字符串替换编辑 |
| `glob` | 文件路径匹配（支持 `**/*.py` 递归）|
| `grep` | 正则文本搜索，返回文件路径 + 行号 |

技能包激活后挂载到 `/workspace/.skills/{skill-name}/`，exec 工具可直接访问。

### MCP 双向角色（源码核实）

**作为 MCP Client（Host）**（`src/langbot/pkg/provider/tools/loaders/mcp.py`）：
支持 4 种传输类型：
- **stdio**：拉起本地进程（自动安装依赖）
- **SSE**：HTTP Server-Sent Events
- **Streamable HTTP**：现代 HTTP MCP 传输
- **Remote（auto）**：先尝试 Streamable HTTP，4xx 则 fallback 到 SSE；重试 3 次，指数退避（2s/4s/8s）

自定义 headers 可通过 server_config 传入，支持 API Key 类认证。

**作为 MCP Server**（`src/langbot/pkg/api/mcp/server.py`）：在 `/mcp` 端点以 MCP 协议暴露 LangBot 自身 HTTP API 的精选子集，供外部 AI agent 操控 LangBot 实例。已实现工具包括：get_system_info、CRUD（bots/pipelines/llm_models/embedding_models）、knowledge_base 检索、list_mcp_servers、list_skills/get_skill。认证：`X-API-Key` header 或 `Authorization: Bearer <lbk_...>`。

**AGENTS.md 锁步要求**（源码核实，`AGENTS.md` 即 `CLAUDE.md` 符号链接）：*"When you add, remove, or change an HTTP API endpoint that should be agent-accessible, you MUST update both the matching MCP tool in server.py AND the relevant skill"*——HTTP API、MCP tools、Skills 三者 drift 是 bug。

### 工具管理器

`toolmgr.py` 统一聚合 4 类 Loader：NativeToolLoader（始终包含）、PluginToolLoader（按 `bound_plugins` 过滤）、MCPLoader（按 `bound_mcp_servers` 过滤）、SkillToolLoader（需 `include_skill_authoring=True`）。函数调用需模型声明 `func_call` ability，标准 OpenAI tool calling 格式。

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

### 会话与对话管理

- **Session**：以 `(launcher_type, launcher_id)` 为 key，内存维护，含 `asyncio.Semaphore` 并发锁
- **Conversation**：按 pipeline_uuid 隔离，存储 `prompt` + `messages` 列表
- 持久化：SQLite（默认，零配置）或 PostgreSQL，ORM（SQLAlchemy asyncio）+ Alembic 迁移

### 上下文截断（源码核实）

`ConversationMessageTruncator` stage 调用 **Round Truncator**（`pkg/pipeline/msgtrun/truncators/round.py`）：从最新消息倒序遍历，保留最近 `pipeline_config['ai']['local-agent']['max-round']` 轮用户消息，再反序恢复顺序。**无任何摘要压缩，只有硬截断**——源码核实。

### 长期记忆

无内建向量长期记忆。RAG 知识库（向量检索 + Rerank）提供静态知识检索，但针对文档而非个人对话历史。`PromptPreProcessing` 插件钩子允许第三方插件在每次请求前修改 system prompt 和历史，可由此实现记忆注入。

### 对话恢复

`expire-time` 超时后自动创建新对话；`conversation_id`/`session_id` 通过变量传递给外部 runner，便于 Dify 等平台实现自己的恢复逻辑。

## 5. Prompt / 系统提示策略

### Bot 系统提示

每个 pipeline 在 WebUI 中配置 system prompt（存为 `prompt_config` 列表），通过 PreProcessor 注入 `query.prompt.messages`。支持变量插值（`sender_name`、`launcher_type` 等）。

### Skills 机制（v4.10.0 新增）

Skills 是**按需激活的指令包**——prompt、过程说明、脚本、参考文件的集合。初始上下文只展示 skill 名称 + description；Agent 调用 `activate(skill_name)` 工具时才拉入完整指令内容。不激活不占 context，天然解决多场景 prompt 膨胀问题。技能包挂载到 `/workspace/.skills/{skill-name}/`，exec 工具可直接执行其中的脚本。

### AGENTS.md / CLAUDE.md

项目根有 `AGENTS.md`（`CLAUDE.md` 是符号链接），为 AI coding agent（Claude Code 等）提供详细的仓库布局、开发规范、Alembic 迁移规则、插件调试流程。Skills 目录是"the single source of truth for agent capabilities"。

## 6. 权限与审批

### 沙箱隔离（Box Runtime）

`pkg/box/` 支持 **Docker / nsjail / E2B** 三个后端，自动选第一个可用。`--standalone-box` 模式下沙箱运行时独立于主进程。exec 工具在容器内运行，其余文件工具映射 /workspace。无命令审批机制，安全依赖容器隔离。

### 工具审批

**无人工审批**——工具调用完全自动执行。访问控制在 pipeline 粒度：rate limiting、用户白名单/黑名单、sensitive word filtering。LangBot 没有类似 Claude Code 的确认步骤。

### 插件进程隔离（源码核实）

Plugin Runtime 是**独立进程**（`src/langbot/pkg/plugin/connector.py`），支持 3 种 IPC 方式：
- **Unix/Linux**：stdio（`python -m langbot_plugin.cli.__init__ rt -s`）
- **Windows**：cmd 子进程 + WebSocket（`ws://localhost:5400/control/ws`）
- **Docker**：连接独立容器 WebSocket（`ws://langbot_plugin_runtime:5400/control/ws`）

20 秒心跳 + 自动重连（stdio 模式需重启）。单插件崩溃不影响主进程。

## 7. 多平台 / 传输 / 接入层

### IM 平台适配器（`pkg/platform/sources/`，实测 22 个 .py 文件）

实际平台：QQ 官方 API（qqofficial）、QQ OneBot v11（aiocqhttp/NapCat/LLOneBot）、微信个人（wechatpad）、微信公众号（officialaccount）、OpenClaw 微信（openclaw_weixin）、企微 API（wecom）、企微机器人（wecombot）、企微客服（wecomcs）、飞书（lark）、钉钉（dingtalk）、Discord（discord）、Telegram（telegram）、Slack（slack）、LINE（line）、KOOK（kook）、Matrix（matrix，可桥接 Signal/WhatsApp/iMessage/Mattermost 等）、Email、Web 页面 bot（web_page_bot）、通用 WebSocket（websocket）、Satori 协议（satori，Koishi 生态）、HTTP Bot（http_bot）。

QQ 生态 OneBot v11 支持 NapCat、LLOneBot 等，兼容 Koishi 生态。

### 出站 Webhook

`platform/webhook_pusher.py` 将消息事件推送到外部 HTTP 端点，供外部系统触发工作流（Dify Trigger 插件即利用此机制）。后端 Quart（async Flask 兼容）HTTP API + WebUI，默认端口 5300。

## 8. 插件 / 扩展 / 子 agent

### 插件系统

插件 SDK 独立仓库：`langbot-app/langbot-plugin-sdk`。组件类型：
- **EventListener**：监听 pipeline 事件（PersonMessageReceived、GroupNormalMessageReceived、PromptPreProcessing、NormalMessageResponded 等），可 `prevent_default()` 截断后续处理
- **Command**：注册自定义命令
- **LLMFuncCall**（Tool）：向 Agent 提供自定义工具函数

安装来源：GitHub `.lbpkg`、本地上传、LangBot Space Marketplace（37+ 插件）。

### 子 Agent / 多 Agent

LangBot 不原生支持多 agent 委派。LangTARS 是垂直场景插件（ReAct + MCP 远程 PC 控制），非通用 sub-agent 调度框架。复杂多 agent 工作流需借助 Dify/n8n 外部平台，LangBot 充当消息网关。

## 9. Provider 抽象（BYOK 多模型）

**完整 BYOK**，LiteLLM 统一后端，用户填写 API Key + Base URL + 模型名称：

**国际商业**：OpenAI、Anthropic（Claude）、Google Gemini、xAI（Grok）、Mistral、Groq、DeepSeek  
**本地部署**：Ollama、LM Studio  
**国内服务**：SiliconFlow、阿里云百炼、火山引擎 Ark、ModelScope、GiteeAI、CompShare、PPIO、盛算云、接口 AI、302.AI、七牛云、Moonshot、智谱 ChatGLM  
**Agent 平台 Runner**：Dify、Coze、n8n、Langflow、DeerFlow、Ant TBox、WeKnora  
**Embedding / Rerank**：Cohere、Jina、Voyage AI + 内置 all-MiniLM-L6-v2（通过 Chroma）

向量数据库：Chroma、Qdrant、Milvus、pgvector、SeekDB。主模型 + 有序 fallbacks 列表，失败自动顺序降级。

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **Skills = 懒加载 Prompt 机制**：description 驱动 Agent 自主决定是否 activate，不激活不占 context token，精妙解决多场景 prompt 膨胀问题。v4.10.0 新增，是最独特的架构创新之一。

2. **插件跨进程隔离（3 种 IPC 模式）**：Studio/WebSocket/Docker-container 三模式适配不同部署场景，20s 心跳自动重连，单插件崩溃不拖垮主进程。

3. **MCP 双角色 + 三锁步原则**：既作为 MCP Client 接入外部工具（4 种传输 + 指数退避），又在 `/mcp` 暴露自身 HTTP API 作为 MCP Server。AGENTS.md 强制要求 HTTP API、MCP tools、Skills 三者锁步同步——drift 是 bug，体现 agent-native 代码库设计理念。

4. **Fallback 模型链 + 工具调用内锁定**：primary + ordered fallbacks 配置，首次成功后 commit 该模型，避免跨模型 tool result 解读不一致。

5. **工具调用硬上限防护（MAX_TOOL_CALL_ROUNDS=128）**：源码核实，防止 adversarial prompt 或模型 bug 导致无限循环失控成本。

6. **WebUI 全管理**：Vite + React Router 7 + shadcn/ui SPA，几乎所有操作（Pipeline、Bot、模型、插件、知识库）可在 UI 完成，降低运维门槛。

### 短板 / 坑

1. **上下文管理简陋**：仅 Round Truncator（滑动窗口），无摘要压缩，无语义记忆检索，长对话硬截断丢失上下文——源码确认无任何压缩逻辑。

2. **无人工审批工具调用**：Agent 全自动执行，沙箱是唯一安全屏障；代码写入/命令执行前无确认步骤，高危场景（生产写操作）风险仅靠容器隔离控制。

3. **多 agent 委派弱**：无原生 sub-agent 调度机制，复杂编排依赖 Dify/n8n 等外部平台，架构耦合增加运维复杂度。

4. **Python 单栈限制**：后端 Python，TypeScript/Node 生态无法直接复用代码。

5. **插件 SDK 独立仓库**：版本对齐麻烦，`pyproject.toml` 中 `langbot-plugin==<x.y.z>` 必须精确匹配，本地开发调试流程稍繁琐。

## 11. 对 yo-agent 的具体启示

1. **Skills 懒加载指令模式**：yo-agent 定义 `skill: { name, description, instructions }` 结构，Agent 通过 `activate_skill(name)` 工具动态加载，避免把 code-review/refactor/security-audit 等场景的 prompt 同时塞入 system message——特别适合多场景切换的编程 agent。

2. **插件进程隔离参考**：若 yo-agent 允许第三方插件，应通过 Worker 进程 / Deno sandbox 隔离，IPC 参考 LangBot 的 stdio/WebSocket bridge 三模式设计（`connector.py`），而非直接 require() 加载，防止插件崩溃拖垮主进程。

3. **MCP 双向角色规划**：yo-agent 既实现 MCP Client 调用外部工具，也通过 `/mcp` 端点暴露自身操作能力（创建任务、读取状态、发消息）作为 MCP Server，方便被 Claude Code 等其他 agent 调用；并遵守"三锁步"原则（REST API + MCP tools + Skills 保持同步）。

4. **Fallback 模型链 + 循环内锁定**：provider 层支持 primary + ordered fallbacks，工具调用循环内 commit 首个成功模型，避免多轮 tool result 被不同模型解读不一致。

5. **工具调用轮次上限 + per-query timeout**：参考 MAX_TOOL_CALL_ROUNDS=128 的防护设计，yo-agent 工具调用循环必须有硬上限和超时，防止 adversarial prompt 或模型 bug 导致无限循环失控。

6. **IM 平台适配器标准化**：LangBot 的 `platform/sources/` 每适配器一个 .py 文件 + 一个 .yaml 元数据，接口统一为消息收/发事件。yo-agent 可定义 `PlatformAdapter` 接口，让 QQ/Telegram/Discord 适配器实现该接口，核心 agent 引擎不感知平台差异。

## 参考来源

- https://github.com/langbot-app/LangBot — 主仓库（v4.10.4，2026-06-23，16,430 Stars）
- https://api.github.com/repos/langbot-app/LangBot — GitHub API 实测（stars、forks、语言统计）
- https://api.github.com/repos/langbot-app/LangBot/releases — 版本发布历史
- https://raw.githubusercontent.com/langbot-app/LangBot/master/AGENTS.md — 仓库开发指南（CLAUDE.md 符号链接，源码核实）
- https://raw.githubusercontent.com/langbot-app/LangBot/master/src/langbot/pkg/provider/runners/localagent.py — LocalAgentRunner 源码（MAX_TOOL_CALL_ROUNDS=128、fallback 锁定、run() generator 源码核实）
- https://raw.githubusercontent.com/langbot-app/LangBot/master/src/langbot/pkg/provider/tools/loaders/native.py — 6 个内置工具定义（源码核实）
- https://raw.githubusercontent.com/langbot-app/LangBot/master/src/langbot/pkg/provider/tools/loaders/mcp.py — MCP Client 4 种传输类型（源码核实）
- https://raw.githubusercontent.com/langbot-app/LangBot/master/src/langbot/pkg/api/mcp/server.py — MCP Server 暴露工具列表 + 认证（源码核实）
- https://raw.githubusercontent.com/langbot-app/LangBot/master/src/langbot/pkg/plugin/connector.py — 插件进程隔离 3 种 IPC 模式（源码核实）
- https://raw.githubusercontent.com/langbot-app/LangBot/master/src/langbot/pkg/pipeline/msgtrun/truncators/round.py — Round Truncator 无摘要压缩（源码核实）
- https://raw.githubusercontent.com/langbot-app/LangBot/master/pyproject.toml — 项目版本 4.10.4、Python >=3.11 要求、依赖项（LiteLLM、Quart、Anthropic 等）
- https://api.github.com/repos/langbot-app/LangBot/releases/tags/v4.10.0 — v4.10.0 "Agentic Sandbox & Skills" 发布说明
