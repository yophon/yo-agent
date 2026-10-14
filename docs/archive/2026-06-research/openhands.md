# OpenHands

> 一句话：面向软件工程的自主 AI Agent 平台，基于 CodeAct 范式与事件流架构，支持本地/云/企业部署 · OpenHands（前身 All-Hands-AI）· Python + TypeScript · MIT（enterprise/ 目录另有许可）· https://github.com/OpenHands/OpenHands

---

## 1. 是什么 / 定位

OpenHands（前身 OpenDevin）是 OpenHands 社区主导的开源自主软件工程 Agent 平台。核心定位是「让 AI Agent 能像人类开发者一样工作」：读写代码、执行命令行、操作浏览器、提 PR、修 Bug。78k+ Stars（2026-06），MIT 开源（enterprise/ 子目录另有独立许可），Python(64%) + TypeScript(35%)，版本 v1.8.0（2026-06-10），支持 Python 3.12+。

**2026 年架构拆分**：原 `All-Hands-AI/OpenHands` 单体仓库已拆为三个独立仓库：
- `OpenHands/OpenHands`（主仓库，协调与集成）
- `OpenHands/software-agent-sdk`（核心 Python Agent 引擎，Python 98%）
- `OpenHands/agent-canvas`（前端 Agent Canvas UI）

平台四种接入形式：Agent Canvas（浏览器 UI）、OpenHands Cloud（SaaS）、Enterprise 版（Kubernetes 自托管）、以及可独立使用的 **Software Agent SDK**（Python 库，PyPI 包 `openhands-ai`）。

---

## 2. 架构总览（agent loop / 运行时主循环）

**范式：事件流驱动的 ReAct 单循环（Event-Sourced ReAct）**

核心抽象分四层：

| 组件 | 职责 |
|------|------|
| `Agent` | 无状态：接收完整事件历史 → 编排 LLM 调用与工具执行；支持 `ParallelToolExecutor` 并行工具执行 |
| `Conversation` | 拥有 `ConversationState`（唯一可变体），驱动循环，维护 append-only `EventLog`，状态机：IDLE/RUNNING/PAUSED/FINISHED/ERROR/STUCK |
| `Workspace` | 执行 Action：`LocalWorkspace` / `DockerWorkspace` / `RemoteAPIWorkspace` |
| `Event` | 所有交互的不可变记录单元（MessageEvent / ActionEvent / ObservationEvent / SystemPromptEvent） |

**Agent 主循环关键阶段**（基于 V1 SDK）：

1. **Drain** — 处理等待审批的 pending action
2. **Block** — 安全策略拒绝时挂起，进入 WAITING_FOR_CONFIRMATION
3. **Prepare** — 构造 LLM prompt（条件触发 Condenser 压缩）
4. **Call** — 带 retry 的 LLM 调用
5. **Dispatch** — 按响应类型分发（工具调用 / 纯文本 / 思考 / 空响应）

所有状态变更均通过 `on_event(event)` 回调追加，无对象直接变更。支持「确定性重放」：从任意 checkpoint 重放 EventLog 可恢复到精确状态。持久化依赖 `FileStore`（磁盘）。

**CodeAct 核心哲学**：不给 Agent 20 个 JSON schema 工具，而是给它 Bash + Python + 文件编辑 + 浏览器，让它直接生成并执行代码作为动作。Action 表达能力等价于图灵完备语言，LLM 写代码优于解析 JSON。

---

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

**内置 Action 类型**（均有对应 Observation）：

- `CmdRunAction` — Bash 命令（持久 tmux session）
- `IPythonRunCellAction` — IPython kernel 执行
- `FileEditAction` — 文件读写/diff
- `BrowseURLAction` / `BrowseInteractiveAction` — Playwright 浏览器
- `MessageAction` / `AgentThinkAction` — 对话与思维链
- `AgentFinishAction` — 任务结束
- `AgentDelegateAction` / `TaskToolSet` / `DelegateTool` — 子 agent 委派（见第 8 节）
- `RecallAction` / `CondensationAction` — 记忆召回与压缩
- `MCPAction` — 外部 MCP 工具代理

**函数调用机制**：V1 三分架构：Action（Pydantic 验证输入）→ `ToolExecutor`（执行）→ Observation（LLM 友好结构化输出）。注册表解耦 spec 与实现，spec 可序列化为 JSON 跨进程传递。不支持 native function calling 的模型走 `NonNativeToolCallingMixin`（prompt-and-parse 回退）。工具支持 `ParallelToolExecutor` 并行执行，通过 `ResourceLockManager` 防止资源冲突。

**MCP 支持（host/client 模式）**：OpenHands 是 MCP **Client/Host**，可连接外部 MCP 服务。通过 `MCPToolDefinition` + `MCPToolExecutor` 透明集成：外部工具 JSON schema 自动映射为 Action 模型，结果以 Observation 返回，与内置工具完全同构。支持三种传输：stdio（沙箱内本地进程，生产不推荐）、SSE/SHTTP（远程服务）、HTTP Proxy（经 SuperGateway 中转，推荐）。**Cloud 版现已支持 MCP**（含 OAuth 认证型 MCP server，但 OAuth 场景不适合全自动/headless 工作流）。配置写在 `config.toml` 的 `[mcp]` 节或 UI 的 Settings → MCP 标签页。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

**Condenser 系统**（V1 核心机制）：事件数超阈值（`max_context_length`，文档示例为 100，可配置）时触发 `LLMSummarizingCondenser`（继承 `RollingCondenser`）：

1. 保留最早 `keep_first` 个事件（系统提示 + 任务，默认 2-4 条）
2. 保留最近 N 个事件（滑动窗口）
3. 将中间事件调 LLM 生成摘要，写为 `CondensationEvent` 追加到 EventLog

EventLog 本身保持完整不丢失（可审计/调试），每步 token 消耗压缩约 2×（实测无质量损失）。上下文窗口超限错误时也会响应式触发。CondensationEvent 写入保证可逆性和审计性。可通过继承 `RollingCondenser` 或 `CondenserBase` 实现自定义策略。

**长期记忆**：当前版本无向量数据库型的跨会话长期记忆；`RecallAction` 支持在 EventLog 内检索历史，本质是 in-session 的。

**会话恢复（Resume）**：基于 EventLog 的确定性重放 + `FileStore` 磁盘持久化。TaskToolSet 创建的子 agent conversation 也持久到磁盘，支持 resume（传入 task ID）。架构设计原则：「旧事件必须始终能加载」（含 schema 版本迁移和废弃字段处理）。

---

## 5. Prompt / 系统提示策略（CLAUDE.md/AGENTS.md 类约定、模式如 plan/act）

**CodeActAgent 系统提示**为 Jinja2 模板，编码了四阶段方法论：

1. **Exploration** — 读文件、grep、理解 repo 结构
2. **Analysis** — `ThinkTool`/`AgentThinkAction` 形成假设（显式思维槽）
3. **Implementation** — 最小化精准修改
4. **Verification** — 重跑测试后才调 `AgentFinishAction`

**微 Agent / Skills**（V1 正式术语 "skills"）：

- 存储为 `.agents/skills/` 目录下的 Markdown 文件（优先级最高）；`.openhands/skills/` 和 `.openhands/microagents/` 已标记为 deprecated
- 两种激活方式：**always-on**（每次对话注入，适合项目规范）和 **on-demand**（关键词匹配或 Agent 主动检索）
- 支持 `AgentSkills` 目录结构（含 `SKILL.md`，推荐渐进式披露）与遗留的单文件格式
- 反引号命令在 skill 加载前执行并内联输出

**约定文件自动发现**：Agent 启动时自动扫描 repo 根目录的 `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`，发现则以 always-on skill 形式注入。任何针对其他工具编写的约定文件对 OpenHands 同样生效，无需迁移。

当前无显式 plan/act 两阶段模式切换，但 `ThinkTool` 步骤扮演类似 plan 的角色。

---

## 6. 权限与审批（工具执行如何获批、沙箱 seatbelt/landlock/docker）

**安全两层架构**：

- **`SecurityAnalyzer`**（风险评估）：对每个 Action 打分 `{LOW, MEDIUM, HIGH, UNKNOWN}`
- **`ConfirmationPolicy`**（策略执行）：
  - `AlwaysConfirm`：每个 Action 需人工审批
  - `NeverConfirm`：全部自动执行（headless 默认）
  - `ConfirmRisky(threshold=HIGH)`：高风险动作暂停等待审批

审批挂起时 Agent 进入 `WAITING_FOR_CONFIRMATION` 状态。子 agent（TaskToolSet / DelegateTool）命中确认时，由父 agent 的 confirmation handler 代为处理。

**沙箱方案（三档隔离）**：

| Workspace | 隔离级别 | 适用场景 |
|-----------|---------|---------|
| `LocalWorkspace` | 进程内（无隔离） | 本地开发调试 |
| `DockerWorkspace` | Docker 容器 | 生产/推荐 |
| `RemoteAPIWorkspace` | 网络 HTTP | 云/多租户 |

`DockerWorkspace` 容器内运行 FastAPI Action Execution Server，含：持久 tmux bash、IPython kernel、Playwright 浏览器、文件编辑器，以及（可选）VSCode Web + VNC 桌面。Headless 模式默认 `NeverConfirm`，生产环境务必使用 `DockerWorkspace`，容器本身是主要安全边界。Enterprise 版支持 Kubernetes 部署。

**SecretRegistry**：密钥晚绑定存储，MCP 配置密钥以 `Cipher` 加密后持久化，防止持久化 JSON 中明文泄漏，stdout 输出自动脱敏。

---

## 7. 多平台 / 传输 / 接入层（CLI/IDE/TUI/聊天平台、协议 MCP/ACP/A2A/OneBot）

**接入形式**：

- **Agent Canvas**：浏览器 UI，连接本地或远程 Agent Server（REST API + WebSocket）
- **CLI**：`python -m openhands.core.main -t "task" --headless`（注：官方文档已将 CLI 标注为 Legacy，推荐使用 SDK）
- **GitHub Action / Resolver 模式**：issue 事件触发 → Agent 自动探索修复 → 开 PR，完全无人值守
- **Slack / Linear / GitHub 集成**：通过 Automation Server 接收 webhook 触发 Agent 运行
- **VSCode-in-container**：开发者可在 Agent 容器内接管操作（Human takeover）
- **OpenAI-compatible Endpoint**：SDK 对外暴露兼容 OpenAI 格式的 REST 接口，可被 IDE 插件、聊天 UI 无缝接入

**协议**：

- **MCP 客户端**：连接外部 MCP 服务器（本地 + 云均已支持）
- **ACP（Agent Client Protocol）**：OpenHands 支持 ACP，可在 Zed、JetBrains（IntelliJ / PyCharm / WebStorm）、Neovim（CodeCompanion.nvim）等 IDE 中作为编码 Agent 使用（2025-12 正式发布，2026 持续扩展）
- 无 OneBot / A2A（Google DeepMind 标准）原生支持
- Agent Server 对外暴露 REST API，可被上层系统编排调用

---

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

**Skills**（见第 5 节）作为轻量级插件，是 OpenHands 扩展的主要形式。

**多 Agent 委派（V1.8 现状，三种模式）**：

| 工具 | 执行模式 | 特点 |
|------|---------|------|
| `AgentDelegateAction` | 阻塞式 | 原始 API，父等待子完成 |
| `TaskToolSet` | 阻塞式（sequential）| 新 API，子 conversation 持久到磁盘，支持 resume；父通过 TaskObservation 获取结果 |
| `DelegateTool` | 并行（threading）| 多子 agent 并发，spawn + delegate 分两步 |

子 Agent 注册通过 **Agent Registry**（agent factory 函数，层级：programmatic → 项目 `.agents/agents/*.md` → 用户 `~/.agents/agents/*.md` → plugin → 内置默认）。共享 Workspace 文件系统，上下文不污染父 EventLog。

**Stuck 检测**（`StuckDetector`）：每步检查五类卡死模式（重复动作对、错误对、独白、乒乓循环、重复上下文溢出），触发时过渡到 STUCK 状态或发 `LoopRecoveryAction`。

---

## 9. Provider 抽象（是否 BYOK 多模型）

**完全 BYOK，通过 LiteLLM 支持 100+ provider**：

- Anthropic Claude（含 extended thinking / ThinkingBlock）
- OpenAI（Chat Completions + Responses API 双模式）
- Google Gemini
- AWS Bedrock
- Ollama（本地模型）
- 任何 OpenAI-compatible endpoint

**高级特性**：

- `RouterLLM`：图片查询路由到视觉模型，纯文本查询路由到廉价模型
- Prompt caching：在稳定前缀启用 Anthropic `cache_control`，节省 30–80% 成本
- 每步成本追踪：token 数、价格、延迟记录到 `conversation.state.stats`
- **LLM Profiles（v1.8 新增）**：可保存多组 LLM 配置并支持对话中途通过 `/model` 斜杠命令切换
- 无 native function calling 的模型走 prompt-and-parse 回退（`NonNativeToolCallingMixin`）

---

## 10. 亮点设计（值得 yo-agent 借鉴）/ 短板 / 坑

### 亮点

1. **事件溯源作为会话状态**：所有状态变更只追加 Event，从不直接变更对象。带来确定性重放、Resume、调试可追溯三大好处，几乎零额外代码成本。事件序列化设计保证旧格式向后兼容（schema 版本迁移）。
2. **Condenser 系统**：threshold 触发 + LLM 摘要 + 保留两端（首尾）的策略，实测 token 消耗减半且质量无损。可作为长 session Agent 的标配机制。CondensationEvent 可审计，策略可替换。
3. **Skills 的按需激活**：skill 激活时才注入上下文，支持 AgentSkills 目录结构的渐进式披露，避免每次会话启动时污染全部上下文。
4. **Workspace 抽象三档隔离**：同一 Agent 代码不改，切换 Workspace 即可从开发模式（进程内）无缝升级到生产模式（Docker 容器），API 完全相同。
5. **三模式多 Agent 委派**：TaskToolSet（sequential + resume）、DelegateTool（parallel）、AgentDelegateAction（原始）三种模式覆盖不同场景，且均通过标准工具机制实现，不污染核心循环。
6. **ACP 支持**：作为 ACP Agent 被主流 IDE（Zed / JetBrains / Neovim）直接集成，无需用户安装独立 UI，降低开发者使用门槛。

### 短板 / 坑

1. **Python 3.12+ 绑定**：整体用 Python 写，TypeScript 仅是前端 UI。不适合想要全栈 TypeScript 的场景。
2. **Docker 依赖**：生产级安全依赖 Docker，轻量化部署（无 Docker 环境、IoT、边缘）受限。Enterprise 依赖 Kubernetes，门槛更高。
3. **Headless 模式自动审批**：headless 默认 NeverConfirm，安全边界完全依赖容器隔离，批量自动化时风险需额外审计。
4. **OAuth 型 MCP 不适合全自动流程**：Cloud 虽已支持 MCP，但 OAuth 认证的 MCP server 需要浏览器交互，无法用于纯 headless 场景。
5. **仓库拆分带来的文档碎片**：2026 年将代码拆分到 `software-agent-sdk` 和 `agent-canvas` 两个独立仓库，文档分散，旧链接和 V0 博客/论文描述的架构已过时，社区信息噪音高。
6. **Condenser 阈值需按负载调优**：`max_context_length` 默认对短任务友好，长任务若摘要质量差会导致 Agent 丢失关键上下文，需按工作负载手动调整。

---

## 11. 对 yo-agent 的具体启示

1. **用 Event-Sourced EventLog 替代直接状态变更**：yo-agent 的内核应以 append-only 事件流作为唯一状态源。每个 Action 和 Observation 都是一条不可变 Event 记录。直接解决会话恢复（从 checkpoint 重放）、多 agent 隔离（各自独立 EventLog）、调试追溯三个问题，TypeScript 实现简单。记住要设计 schema 版本迁移机制，保证旧事件始终可加载。

2. **Condenser 是长会话的必需品，不是可选优化**：yo-agent 在对接 QQ/Telegram 等长期聊天时，上下文累积是必然场景。应预先设计 Condenser 接口（`interface Condenser { condense(events: Event[]): Event[] }`），默认实现保留首尾 + LLM 摘要中间段。阈值应可按 session 类型配置（聊天 session vs 编程 session 不同）。

3. **Skills 机制用于平台适配**：yo-agent 挂接 QQ/Telegram/Discord 时，不同平台有不同约定（消息格式、API 限制、表情规范等）。可直接复制 OpenHands 的 Skills 模式：每个平台一个 always-on Markdown skill，随 conversation 注入。比在代码里硬编码平台差异更易维护。

4. **SecurityAnalyzer + ConfirmationPolicy 解耦设计**：yo-agent 作为通用引擎，应将风险评估接口（`interface RiskAnalyzer`）与审批策略（`type ConfirmationPolicy`）分离，允许运行时注入。聊天平台场景可用 `AlwaysNoop`，编程场景用 `ConfirmHigh`。

5. **三模式委派思路适配 yo-agent**：借鉴 TaskToolSet（sequential + resume）和 DelegateTool（parallel）的区分，yo-agent 实现多 agent 时应明确区分「有序任务链」和「并行扇出」两种场景，均以标准工具接口封装，父 agent 无感知。

6. **StuckDetector 是长时 Agent 不可省的保护**：yo-agent 支持编程任务时，卡死循环会耗尽 token 预算。应在 conversation runner 中加入滑动窗口检测（TypeScript 实现约 100 行），识别重复动作对和独白序列，检测到时触发 recovery action 或终止并返回错误。

---

## 参考来源

- OpenHands GitHub 仓库（现 OpenHands org）：https://github.com/OpenHands/OpenHands
- OpenHands Software Agent SDK 仓库：https://github.com/OpenHands/software-agent-sdk
- OpenHands Agent Canvas 仓库：https://github.com/OpenHands/agent-canvas
- OpenHands V1 SDK 论文（arXiv 2511.03690）：https://arxiv.org/html/2511.03690v1
- OpenHands 官方文档：https://docs.openhands.dev/
- Software Agent SDK 文档：https://docs.openhands.dev/sdk
- Context Condenser 文档：https://docs.openhands.dev/sdk/guides/context-condenser
- TaskToolSet 文档：https://docs.openhands.dev/sdk/guides/task-tool-set
- MCP 设置文档：https://docs.openhands.dev/openhands/usage/settings/mcp-settings
- ACP IDE 集成博客（2025-12）：https://www.openhands.dev/blog/20251209-use-openhands-in-your-ide-with-acp
- OpenHands 产品更新 May 2026：https://www.openhands.dev/blog/openhands-product-update---may-2026
- DeepWiki SDK 子 Agent 委派详解：https://deepwiki.com/OpenHands/software-agent-sdk/3.3-sub-agent-delegation-and-task-management
- PyPI openhands-ai：https://pypi.org/project/openhands-ai/
