# Goose (Block / AAIF)
> 一句话：Block 出品的本地优先通用 AI agent，MCP-native 架构，Rust 实现，Apache 2.0，2025-12-09 宣布捐赠 Linux Foundation AAIF，2026-04-07 正式迁移至 aaif-goose/goose；仓库 https://github.com/aaif-goose/goose

---

## 1. 是什么 / 定位

Goose 是 Block（前 Square/Cash App 母公司）在 2024 年底开源的本地 AI agent 框架。2025-12-09，Block 与 Anthropic（MCP）、OpenAI（AGENTS.md）联合宣布成立 Linux Foundation Agentic AI Foundation（AAIF），并将 goose 捐赠至该基金会。2026-04-07 仓库正式从 `block/goose` 迁移至 `aaif-goose/goose`（原 URL 保留别名重定向）。

定位：**通用本地 agent**，不限于编程——代码、研究写作、自动化、数据分析、系统操作均在其覆盖范围内。核心差异化主张是"MCP-native"：扩展能力全部通过 MCP 服务器实现，agent 本身只包含核心循环与少量内置 MCP servers。

截至 2026 年 6 月：~50,100 GitHub stars（v1.38.0，2026-06-17 发布），代码库 Rust 64.5% + TypeScript 29.2%，支持 30+ 云端 provider + 4 本地 provider，内置 3 个核心 MCP server + 数个平台扩展，外部生态 70+ MCP 扩展。

---

## 2. 架构总览（agent loop / 运行时主循环）

Goose 采用**单循环 ReAct 风格**：

```
用户输入 → LLM 推理（含工具意图）→ 工具执行（MCP call）
         → 结果注入对话 → 再次 LLM 推理 → 循环直至结束
```

核心 crate `goose`（位于 `crates/goose/src/agents/agent.rs`）负责"orchestrating conversation turns and tool execution"，以 tokio 异步运行时驱动。每个用户会话是独立进程（Session），会话间**完全隔离**，不共享状态。

**三阶段执行**：规划（生成高层计划）→ 推理（选择工具/步骤）→ 行动（调用工具）。规划并非独立的 Planner agent，而是初始 turn 时 LLM 生成的内嵌思维步骤。

**并发但孤立**：多会话可并行运行，但 Goose 自身不提供会话间通信机制（路线图"Async Goose"统一任务调度器尚未启动）。

---

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

### MCP 架构地位

Goose 是 **MCP Host**（宿主），通过 Extension Manager 管理多个 MCP Client，每个 client 与一个 MCP server 保持 1:1 连接。

### 内置 MCP Servers（goose-mcp crate）

| 扩展 | 默认启用 | 主要工具 |
|------|----------|----------|
| **Developer** | 是 | `shell`（命令执行）、`text_editor`（view/write/patch）、目录遍历 |
| **Computer Controller** | 否 | `web_scrape`、`automation_script`（Shell/Ruby/PowerShell）、`computer_control`（键鼠/UI 自动化）、`pdf_tool`、`docx_tool` |
| **Memory** | 否 | 跨会话持久存储（本地/全局），在 system prompt 中注入记忆 |
| **Tutorial** | 否 | 交互式引导教程 |

### 内置平台扩展（in-process）

| 扩展 | 默认启用 | 功能 |
|------|----------|------|
| `analyze` | 是 | Tree-sitter AST 解析 |
| `todo` | 是 | 复选框进度追踪 |
| `summon` | 是 | 生成 subagent |
| `skills` | 是 | 加载专项指令集 |
| `extensionmanager` | 是 | 扩展发现/启用/禁用 |
| `chatrecall` | 否 | 历史对话搜索 |

### 函数调用机制

通信协议为 **JSON-RPC 2.0**，传输层分 STDIO（本地进程）和 SSE（远程 HTTP）。对于不原生支持 tool-use 的模型，Goose 提供 **Tool Shim** 层做 prompt 级适配，使任何 LLM 都能使用工具。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

### 上下文窗口管理

Goose 实现**两层上下文保护**：

1. **Auto-Compaction（自动压缩）**：默认在 token 用量达到上限 **80%** 时触发（`GOOSE_AUTO_COMPACT_THRESHOLD` 可调，设为 0.0 禁用），调用 LLM 对历史对话生成摘要并替换原始消息。Headless 模式（`goose run`）默认自动 summarize；交互模式则询问用户。

2. **Context Strategy（备用兜底）**：通过 `GOOSE_CONTEXT_STRATEGY` 环境变量配置，支持四种模式：
   - `summarize`：摘要压缩（CLI + Desktop）
   - `truncate`：截断最早消息，最多 3 次（CLI only）
   - `clear`：清空历史（CLI only）
   - `prompt`：询问用户选择策略

3. **工具调用摘要**：会话中工具调用次数超过 10（`GOOSE_TOOL_CALL_CUTOFF` 可调）时，对工具历史进行摘要压缩，减少 token 占用。

用户也可手动运行 `/summarize` 命令主动触发摘要。

### 长期记忆

双轨机制：
- **`.goosehints` 文件**：静态、目录作用域，每次请求完整注入 system prompt。格式纯文本/Markdown，可分层（当前目录 → 父目录逐级合并）。内容：技术栈、编码规范、约定。等价于 Claude Code 的 `CLAUDE.md`。
- **Memory MCP Server**：动态、可读写，agent 在运行时主动存写记忆，并在 session 启动时将"全局记忆"注入 system prompt。用于记录用户偏好、项目状态等跨会话信息。

### 会话持久化

底层使用 SQLite（via `sqlx` crate）持久化对话历史。`chatrecall` 扩展（默认关闭）支持搜索历史会话。`GOOSE_MAX_TURNS` 控制连续行动上限（默认 1000）。

---

## 5. Prompt / 系统提示策略

### 上下文文件约定

Goose 读取两类文件注入 system prompt：

| 文件 | 作用域 | 特性 |
|------|--------|------|
| `.goosehints` | 目录级，Goose 专属 | 每请求全量注入，支持层级合并 |
| `AGENTS.md` | 仓库级，跨工具兼容 | 与 Claude Code、Cursor 等共享同一文件，OpenAI 主导的开放标准 |
| `.gooseignore` | 项目级 | 禁止 agent 修改的文件/目录黑名单 |

### Recipes：声明式 agent 配置

Goose 独有的 YAML 配置格式，将系统提示、工具集、子 agent、参数和模型选择打包成可复用单元：

```yaml
name: code-review-recipe
settings:
  goose_provider: anthropic
  goose_model: claude-sonnet-4-20250514
instructions: |  # 相当于 system prompt
  你是一个代码审查专家...
prompt: |         # 具体任务
  审查 {{ pr_url }} 中的变更
extensions:
  - github-mcp
parameters:
  - key: pr_url
    input_type: string
    requirement: required
sub_recipes:
  - security-scan
```

Recipes 可版本控制、团队共享、并行/串行调度，是 Goose 区别于其他 agent 的核心机制。

---

## 6. 权限与审批（工具执行如何获批、沙箱）

### 三级自治模式

| 模式 | 行为 |
|------|------|
| **Auto（默认）** | 不受限，自主执行所有工具和文件操作 |
| **Approve** | 执行前要求确认；启用 Smart Approve 后按风险等级自动批准低风险、上报高风险 |
| **Chat** | 纯对话，不执行任何工具/文件操作 |

工具级别可配置覆盖：Always Allow / Ask Before / Never Allow。模式可在会话内动态切换。

### 安全加固（Operation Pale Fire 后）

- Unicode 字符剥离（防止隐写攻击）
- diff 风格预览（执行前展示文件变更）
- 粒度化扩展权限
- MCP 扩展恶意软件扫描
- 次级 LLM 监控（监控 agent 行为异常）
- Prompt 注入检测

**沙箱**：Goose 本身不提供 Docker/landlock/seatbelt 级别的系统隔离，工具执行在宿主进程环境中运行（shell 命令继承 goose 进程的环境变量）。沙箱需用户自行配置（如 Docker 中运行 Goose）。

---

## 7. 多平台 / 传输 / 接入层

### 官方客户端

| 平台 | 状态 |
|------|------|
| CLI（goose-cli） | 主力，全功能 |
| Desktop（Electron，macOS/Linux/Windows） | 与 CLI 功能趋于对等 |
| JetBrains 扩展 | 官方支持（无需订阅，v2026.1+ 通过 ACP HTTP 直连） |
| VS Code、Cursor、Windsurf | 通过 ACP 兼容接入 |
| Telegram Bot | 支持（v1.37.0 出现"改进 Telegram gateway 错误报告"，引入时间约 2025 年中） |

### 协议栈

- **MCP**：扩展层，agent ↔ 工具服务器（JSON-RPC 2.0 + STDIO/SSE）
- **ACP（Agent Client Protocol）**：客户端层，editor/platform ↔ goose agent（基于 JSON-RPC 2.0，Streamable HTTP + WebSocket，单端点 `POST /acp`）。**注意**：ACP 集成截至 2026 年 6 月仍在多阶段推进中（issue #6642）：Phase 1 稳定 ACP Server → Phase 2 TypeScript TUI Alpha → Phase 3 Desktop 迁移 → Phase 4 清理旧协议。现已有 `goose-acp` crate 供开发者提前接入，但 Desktop 和 CLI 的完整迁移尚未完成。

ACP 定位相当于 AI agent 领域的 LSP（Language Server Protocol）：编辑器实现 ACP client，agent 实现 ACP server，双方解耦。Zed、Neovim、JetBrains 已跟进。

---

## 8. 插件 / 扩展 / 子 agent

### MCP 扩展生态

外部扩展 70+，涵盖 GitHub、Slack、数据库、Web 服务等。v1.25.0 引入统一 `summon extension`，将扩展发现整合为单一工作流，但随即引入 stream decode error 回归问题（见"短板"）。

### 子 agent：两种范式

**Inline Subagents（通过 `summon` 平台扩展）**：
- 用自然语言内联创建，临时实例，任务结束即销毁
- 共享父会话的 LLM 模型（不可独立指定）
- 进程隔离，失败不影响主会话
- 最多 10 个并发并行 worker
- 适用于一次性独立任务

**Subrecipes（通过 Recipe 系统）**：
- 预定义 YAML 文件，可复用、可版本控制
- 每个 subrecipe 可独立指定 LLM 模型（实现 lead/worker 模型分离）
- 支持类型安全的参数传递（`{{ param }}`模板语法）
- 适用于结构化、团队共享的重复流程

两种范式均在进程隔离下运行，不共享状态。

---

## 9. Provider 抽象（是否 BYOK 多模型）

**完全 BYOK**，支持 30+ 云端 provider + 4 本地 provider（通过 `config.yaml` 配置 API key）：

- 主流云端：Anthropic、OpenAI、Google Gemini、Azure OpenAI、AWS Bedrock、AWS SageMaker TGI、GCP Vertex AI、GitHub Copilot、OpenRouter、Groq、Mistral AI、xAI、Alibaba Qwen、NEAR AI Cloud、Scaleway 等
- 本地：Ollama、LM Studio、Atomic Chat、Docker Model Runner
- llama.cpp：通过内嵌的 `llama-cpp-2` crate 实现**原生直接集成**（`LocalInferenceProvider`），支持从 Hugging Face 下载 GGUF 模型，并管理从模型下载到工具调用适配的完整生命周期
- 兼容层：任意 OpenAI 兼容端点

内部维护**约 1,700 模型的 Canonical Model Registry**（编译期从 models.dev API 生成并嵌入二进制），记录各模型的 context limit、tool-use 能力、定价。`GOOSE_PREDEFINED_MODELS` 和 `config.yaml` 允许用户覆盖默认注册表配置。

不同 subrecipe 可绑定不同 provider/model，实现 lead 模型用大模型、worker 模型用轻量模型的成本优化。文档建议："goose relies heavily on tool calling capabilities and currently works best with Claude 4 models"。

---

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **MCP-native 架构**：agent 核心极薄，工具能力全部外化为 MCP server，扩展生态与 MCP 社区完全共享，无需重新发明工具接口。

2. **Recipes 系统**：YAML 声明式 agent 配置，将系统提示 + 工具集 + 模型选择 + 参数化 + 子 agent 打包，实现 agent 行为的版本控制、团队共享和 CI/CD 集成。

3. **双记忆轨道**：静态 `.goosehints`（零 token 代价声明约定）+ 动态 Memory MCP server（agent 自主读写），分层满足不同持久化需求。

4. **ACP 标准化接入路线**：统一协议驱动 CLI/Desktop/IDE/聊天 bot，解耦 agent 引擎与客户端，使 Telegram/JetBrains/Zed 等多元客户端成为一等公民（仍在落地中）。

5. **llama.cpp 原生内嵌**：通过 `llama-cpp-2` crate 直接集成本地推理，而非仅依赖 OpenAI 兼容 API 包装，支持从 HuggingFace 自动下载 GGUF 模型并管理 KV cache slot，Tool Shim 层补足无原生 function calling 能力的模型。

6. **三级权限模式 + Smart Approve**：粒度化权限与风险自动评估，在开发效率与安全之间提供弹性平衡点。

### 短板 / 坑

1. **ACP 集成仍在推进中**：card 上一版错标"2025-12 集成完成"。实际情况：2025-12 是 AAIF 宣布日，ACP 集成（issue #6642）截至 2026-06 仍在 Phase 1-3，Desktop 和 CLI 完整迁移尚未完成，`goose-acp` crate 已可用但未成为唯一接口。

2. **MCP 标准跟进滞后**：截至 2025-07 路线图节点，仍停留在 MCP March 2025 标准，June 2025 规范（含 CIMD 客户端身份元数据）未跟进，团队正向官方 MCP Rust SDK 迁移。

3. **Summon 扩展回归**：v1.25.0 引入统一 summon extension 后出现 stream decode error（issue #7645），多用户确认"summary 几乎总是失败"，回退到 v1.24 可规避。v1.37.0 虽持续改进流式处理，但该回归是否完全修复需追踪。

4. **无系统级沙箱**：工具执行直接在宿主环境，潜在安全风险需用户自行隔离（Docker 等）。

5. **SWE-bench 专项性能差距**：Goose ~45% vs Claude Code 72.7%，通用化设计以编程专项性能为代价。

6. **会话间完全隔离**：多 agent 并行但无内置协调机制，路线图"Async Goose"统一任务调度器尚未启动。

---

## 11. 对 yo-agent 的具体启示

1. **Tool Shim 模式**：yo-agent 支持多 provider，针对不原生支持 function calling 的模型（部分开源模型），可实现 prompt 级别的 tool-use 适配层，而非直接报错——这是面向本地模型场景的关键基础设施。

2. **Recipe / 声明式 Agent 配置**：yo-agent 可参考 Recipes 的 YAML 格式，将"系统提示 + 工具白名单 + 模型绑定 + 参数模板"设计成独立的 Agent 配置单元，使 QQ/Telegram 等聊天平台的 bot 行为可配置化、可版本控制，无需改代码。

3. **ACP 作为平台解耦层**：yo-agent 的核心 agent 引擎可以暴露 ACP 兼容接口（`POST /acp`，JSON-RPC 2.0 + SSE），平台适配器（QQ、Telegram、Discord）各自实现 ACP client，引擎与接入层彻底解耦——比 OneBot 更通用，也能复用 ACP 生态的其他 client 实现。

4. **双轨记忆设计**：用静态文件（相当于 `.goosehints`）承载项目/用户偏好的低频约定，用 MCP server（相当于 Memory extension）承载高频、动态的跨会话状态，两者 token 代价和更新成本截然不同，不要用同一机制处理。

5. **三级权限模式**：yo-agent 面向真实用户时，Auto/Approve/Chat 三级 + 工具级覆盖是最小可用的权限模型，特别是 Smart Approve（风险自动评级）可在聊天平台场景下减少打扰而不降低安全性——值得在 yo-agent 权限系统设计阶段直接参考。

6. **进程隔离的 subagent**：Goose 的 subagent 强制进程隔离（失败不影响主会话），这是在多任务并行场景下保护主循环稳定性的最简单可靠手段。yo-agent 实现 subagent 时应默认选择 worker_threads 或 child_process 隔离，而非在同一事件循环内直接 await。

---

## 参考来源

- [aaif-goose/goose GitHub 仓库](https://github.com/aaif-goose/goose)（已从 block/goose 迁移，2026-04-07）
- [Goose 官方博客：迁移至 AAIF](https://goose-docs.ai/blog/2026/04/07/goose-moves-to-aaif/)
- [Linux Foundation AAIF 宣布公告（2025-12-09）](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [Block 博客：Block, Anthropic, OpenAI 联合成立 AAIF](https://block.xyz/inside/block-anthropic-and-openai-launch-the-agentic-ai-foundation)
- [TechCrunch：AAIF 报道（2025-12-09）](https://techcrunch.com/2025/12/09/openai-anthropic-and-block-join-new-linux-foundation-effort-to-standardize-the-ai-agent-era/)
- [DeepWiki: aaif-goose/goose 架构分析](https://deepwiki.com/aaif-goose/goose)
- [DeepWiki: 本地推理 & llama-cpp-2 集成](https://deepwiki.com/aaif-goose/goose/6.5-inference-mesh-and-local-models)
- [DeepWiki: Canonical Model Registry](https://deepwiki.com/block/goose/4.2.2-multi-model-configuration)
- [goose Roadmap (July 2025)](https://github.com/aaif-goose/goose/discussions/3319)
- [ACP 集成追踪 issue #6642](https://github.com/aaif-goose/goose/issues/6642)
- [goose & ACP Discussion #7309](https://github.com/aaif-goose/goose/discussions/7309)
- [Summon stream decode error issue #7645](https://github.com/block/goose/issues/7645)
- [Smart Context Management 文档](https://goose-docs.ai/docs/guides/sessions/smart-context-management/)
- [goose Provider 配置文档](https://goose-docs.ai/docs/getting-started/providers/)
- [Intro to ACP - goose 官方博客（2025-10-24）](https://goose-docs.ai/blog/2025/10/24/intro-to-agent-client-protocol-acp/)
- [ACP 官方站](https://agentclientprotocol.com/get-started/introduction)
- [Docker + Goose Model Runner 集成博客](https://www.docker.com/blog/building-an-ai-assistant-with-goose-and-docker-model-runner/)
