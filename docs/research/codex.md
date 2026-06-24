# OpenAI Codex CLI

> 一句话：OpenAI 官方开源的本地编程 agent，Rust 单体二进制，通过 JSON-RPC 2.0 app-server 驱动 VS Code 扩展与移动客户端，支持 MCP 双向（client + server）及多级沙箱审批。
> 厂商/作者：OpenAI · 语言：Rust（96.5%；codex-rs 含约 70 个 crate）· License：Apache-2.0 · 仓库：https://github.com/openai/codex

---

## 1. 是什么 / 定位

Codex CLI 是 OpenAI 在 2025 年 4 月开源的本地编程 agent，定位为"终端里的 AI 结对程序员"。用户在项目目录中启动 Codex，它可以读写代码、执行 shell 命令、搜索 Web、调用 MCP 工具，并以 TUI（终端全屏界面）呈现流式进度。

早期版本用 TypeScript/Node.js 实现，随后完整重写为 Rust（`codex-rs/`），当前稳定版本为 **0.142.0**（2026 年 6 月 22 日），预发布通道已至 0.143.0-alpha，每周持续发布。Rust 重写的核心动机：零依赖安装（无需 Node.js）、毫秒级启动、原生沙箱 FFI、无 GC 暂停，以及为 IDE 扩展提供稳定的嵌入接口。

---

## 2. 架构总览（agent loop / 运行时主循环）

Codex 采用经典的**工具调用循环（ReAct-like）**，但以 Responses API 流式事件为基础驱动，而非逐步同步调用：

```
用户输入
  → 拼装 prompt（system 消息 + AGENTS.md + 对话历史 + 工具定义）
  → 调用 OpenAI Responses API（Server-Sent Events 流）
  → 解析流事件：response.output_text.delta（UI 更新）/ response.output_item.added（状态保存）
  → 若模型请求工具调用 → 执行工具（沙箱 shell / MCP 工具 / 内建工具）
  → 工具输出追加到对话历史
  → 重新提交给模型（exact prefix matching 维持缓存命中）
  → 重复直至模型给出最终文本回复，结束本轮 turn
```

**关键实现细节：**

- **无状态请求**：每次请求携带完整对话历史，不使用 `previous_response_id`，支持 Zero Data Retention 合规与多云部署。
- **Prompt 缓存优化**：静态内容（系统提示、AGENTS.md、工具定义）置于 prompt 前部，动态内容（工具输出、新用户消息）追加于末尾，最大化缓存命中率，使推理复杂度从二次降为线性。
- **自动压缩（auto compact）**：`ContextManager` 监控 token 数，接近上限时调用 `/responses/compact` 端点，返回含加密摘要项（`type=compaction`）的压缩 input，继续作为后续请求的前缀。
- **事件流解耦**：TUI（`codex-tui`）、IDE 扩展和 app-server 客户端均消费事件流，与 agent 核心逻辑（`codex-core`）解耦。

**Workspace 代码结构（codex-rs/）：**

| Crate | 职责 |
|---|---|
| `codex-core` | 核心引擎：ThreadManager、CodexThread、Session、ContextManager |
| `codex-tui` | 基于 Ratatui 的全屏终端 UI |
| `codex-exec` | headless 无 UI 运行器（CI/脚本集成） |
| `codex-app-server` | JSON-RPC 2.0 bridge（VS Code 扩展 / 自定义客户端） |
| `codex-mcp-server` | 同时作为 MCP client 和 MCP server |
| `codex-config` | 分层配置解析（TOML） |
| `codex-protocol` | 操作（Operations）与事件（Events）消息类型 |
| `codex-state` | 会话持久化 |

---

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

### 内置工具集

工具列表按来源分为三类：

1. **Codex 提供的工具**：沙箱化 shell（`bash`）、文件读写（`apply_patch`）、图片生成/编辑（`gpt-image-2`）
2. **API 提供的工具**：Web 搜索（索引模式可访问预批准 URL，`--search` 切换实时）、图片查看
3. **用户/MCP 工具**：通过 `config.toml` 配置的 MCP server 提供的所有工具

### 函数调用机制

工具定义序列化为 JSON 并包含在每次 prompt 的 `tools` 字段中，遵循 Responses API schema。工具执行结果追加至 `input` 字段供下次请求，并参与 prompt 缓存前缀匹配。

MCP server 支持 `notifications/tools/list_changed` 动态更新工具列表，但中途更新会导致 cache miss，因此建议在会话开始时固化工具集。

### MCP 支持

Codex 同时扮演**双重 MCP 角色**：

- **MCP Client**：连接第三方 MCP server（STDIO 本地进程 / Streamable HTTP / Plugin 内置），读取 `instructions` 字段作为 server 级指令。支持 OAuth 和 Bearer Token 认证，配置通过 `codex mcp add` 命令或直接编辑 `~/.codex/config.toml`。
- **MCP Server**：通过 `codex mcp-server` 将自身暴露为 MCP server，供 OpenAI Agents SDK 或其他 orchestrator 调用，实现多 agent 协作（具体暴露的工具名称在官方文档中未明确列出，但设计上允许外部 orchestrator 启动和回复 Codex 会话）。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复 resume）

### 上下文窗口管理

- `auto_compact_limit`：token 数阈值，触发自动压缩
- `project_doc_max_bytes`：AGENTS.md 系列文件总大小上限（默认 32 KiB），超出后跳过
- 工具输出有大小边界约束（AGENTS.md 规范：单 item 不超过 10K token）

### 压缩摘要

调用 `/responses/compact` 端点生成**加密摘要项**，作为后续 input 的前缀替代完整历史。v0.54-v0.56 修复了"摘要的摘要"问题（递归压缩导致质量下降），改用基于模板的干净压缩路径。

### 长期记忆

记忆系统默认关闭（EEA/英国/瑞士地区强制关闭）。启用后，Codex 在合适的会话结束后提取有用上下文并写入 `~/.codex/memories/` 下的文件（summaries、durable entries、recent inputs、evidence），在新会话时注入。`/memories` 斜线命令管理记忆内容。

**Chronicle**（独立的 opt-in 功能，仅限 ChatGPT Pro 订阅用户在 macOS 上使用）：从屏幕上下文中自动生成记忆，需要 macOS Screen Recording 和 Accessibility 权限，与记忆主系统协同工作。

### 会话恢复

`codex resume` 或 `codex exec resume --last` 恢复最近会话；`--all` 跨工作目录搜索。app-server 协议提供 `thread/resume` 方法，保留完整对话历史（transcript）和审批记录（approval history）。会话数据通过 `codex-state` crate 持久化到磁盘。

---

## 5. Prompt / 系统提示策略（AGENTS.md 类约定、模式如 plan/act）

### AGENTS.md 约定文件

Codex 在每次启动（TUI 会话或 exec 单次运行）时读取并合并以下层级的指令文件：

1. `~/.codex/AGENTS.override.md` 或 `~/.codex/AGENTS.md`（全局层）
2. Git 根目录 → 当前目录逐级向下，优先读 `AGENTS.override.md`，次之 `AGENTS.md`，再次 `project_doc_fallback_filenames` 配置的备选名

文件内容合并后注入 system 提示前部（稳定前缀），作为 prompt 缓存锚点。内容可包含：工作规范、仓库标准、测试命令、安全策略、service 特定规则。`/init` 命令可在项目中脚手架生成 AGENTS.md。

### Plan / Act 模式

`/plan` 命令切换到**计划模式**（只规划不执行），等待用户确认后再进入执行阶段——这是一种显式的"先推理后行动"双阶段控制。`/goal` 设置持久任务目标作为对话锚点。`--ask-for-approval untrusted` 可对所有变更操作触发人工审批，实现细粒度的 human-in-the-loop。

### Hooks 生命周期注入

**10 个 hook 事件**（`SessionStart`, `SubagentStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`）允许在关键点注入自定义脚本，可实现自动记忆创建、prompt 扫描、日志记录、工具输入改写等。`SessionStart` 和 `SubagentStart` 在 thread/subagent 启动时运行，其余 8 个在 turn 范围内运行。

---

## 6. 权限与审批（工具执行如何获批、沙箱 seatbelt/landlock/docker）

### 审批策略（--ask-for-approval / approval_policy）

| 模式 | 行为 |
|---|---|
| `on-request` | 工作区外操作或访问网络时请求审批（版本控制目录的默认值） |
| `untrusted` | 只读操作自动通过，所有变更操作需审批 |
| `never` | 全自动无需审批（脚本/CI 场景） |
| `granular` | 细粒度：对 sandbox、execpolicy-rule、MCP、request_permissions、skill-script 各自配置审批/自动拒绝 |

`--yolo`（等同于 `--dangerously-bypass-approvals-and-sandbox`）完全绕过审批与沙箱（仅在外部隔离环境使用）。`approvals_reviewer = "auto_review"` 启用自动审查 agent，将符合条件的请求路由给审查 agent 而非人工。

### 沙箱实现

工具执行通过 `ToolRouter` 路由，应用进程树级别的沙箱策略：

| 平台 | 机制 |
|---|---|
| macOS | Seatbelt（`sandbox-exec`），策略文件匹配所选沙箱模式 |
| Linux | bwrap + seccomp（默认） |
| Windows（WSL2 内） | 使用 Linux 沙箱机制 |
| Windows（原生） | 原生 Windows 沙箱实现（Restricted Token + ACL） |

沙箱模式（`--sandbox`）：

- `read-only`：只读限制
- `workspace-write`：**默认"Auto"模式**，可编辑项目目录，限制网络和工作区外操作
- `danger-full-access`：无限制（等同于 `--yolo`）

受保护路径（只读强制）：`.git/`、`.agents/`、`.codex/`。网络默认关闭，可通过 `network_proxy` 配置域名白名单（精确匹配、通配符、全局规则）。DNS rebinding 检查和本地目标封锁内置启用。

---

## 7. 多平台 / 传输 / 接入层（CLI/IDE/TUI/聊天平台、协议）

### 接入层

- **CLI（codex-cli）**：multitool dispatcher，命令入口
- **TUI（codex-tui）**：基于 Ratatui 的全屏交互终端
- **headless exec（codex-exec）**：`codex exec --json` 输出换行符分隔的 JSON 事件流，用于 CI/脚本集成
- **VS Code 扩展**：通过 app-server 协议深度集成，支持 diff 预览、inline 审批
- **移动端 / 桌面 App**：通过 WebSocket 连接远程 app-server

### App-Server 协议（JSON-RPC 2.0）

这是 Codex 的核心集成层，支持三种传输（加一种关闭选项）：

- **stdio**（默认）：换行符分隔的 JSONL，适合进程内嵌
- **WebSocket**（`--listen ws://IP:PORT`）：TCP 连接 + HMAC-signed JWT Bearer Token 认证，支持远程连接
- **Unix socket**（`--listen unix://`）：通过 HTTP Upgrade 握手进行 WebSocket 通信
- **off**：禁用本地传输

**核心 JSON-RPC 方法**：`thread/start`、`thread/resume`、`thread/fork`、`thread/list`、`turn/start`、`turn/steer`、`turn/interrupt`、`model/list`、`fs/readFile`、`fs/writeFile`、`fs/watch`、`command/exec`、`app/list`、`skills/list`。

服务端主动推送审批请求（server-initiated JSON-RPC），要求客户端响应后才继续执行——实现异步 human-in-the-loop。WebSocket 模式下使用有界队列，满载时返回 -32001 错误码。

### 协议生态

- **MCP**：双向（client + server），详见第 3 节
- **OpenAI Agents SDK**：Codex 作为 MCP server 被 orchestrator 调用
- 无原生 ACP/A2A/OneBot/Slack/Telegram 支持；聊天平台接入需通过 app-server 或 MCP server 自行桥接

---

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

### 插件系统

插件通过 manifest 打包，可捆绑：MCP server 配置、Hooks（`hooks/hooks.json`）、Slash Commands、Skills、AGENTS.md 片段。插件管理通过 `/plugins` 斜线命令或 `config.toml` 的 `[plugins]` 节配置。0.142.0 新增 `/plugins` 界面将远程插件分为 OpenAI Curated、Workspace、Shared with me 三类，符合条件的 turn 可自动推荐并安装相关插件。

### Skills 与 Record & Replay

Skills 是可复用任务上下文束。**Record & Replay** 将演示工作流录制为可重用 skill（macOS 专属；初始可用性不含 EEA/英国/瑞士地区）。

### 子 agent / 多 agent 委派

- **子 agent 类型**：`default`（通用）、`worker`（执行）、`explorer`（只读分析），可通过 `~/.codex/agents/*.toml` 或 `.codex/agents/*.toml` 自定义（必填字段：`name`、`description`、`developer_instructions`）
- **触发方式**：显式 `/agent` 命令、`spawn_agents_on_csv` 批量操作，或直接提示；不自动委派
- **并发控制**：`agents.max_threads`（默认 6）、`agents.max_depth`（默认 1，防止无限递归）、`agents.job_max_runtime_seconds`（批量任务超时，默认 1800 秒）
- **委派控制（0.142.0 新增）**：可配置 `disabled`、`explicit-request-only`、`proactive` 三级委派模式
- **Token 成本**：每个子 agent 独立进行模型推理和工具调用，Token 消耗随并发度线性增长

子 agent 沙箱策略和审批门禁与主 agent 共享，跨 thread 的审批请求在主视图中可见。

---

## 9. Provider 抽象（是否 BYOK 多模型）

Codex 支持完整的 **BYOK（Bring Your Own Key）多 provider** 配置：

### 内置 Provider

`openai`、`ollama`（`http://localhost:11434/v1`）、`lmstudio`（`http://localhost:1234/v1`）——这三个 ID 保留不可覆盖。Amazon Bedrock 内置支持（AWS profile + region）。

### 自定义 Provider

`config.toml` 中通过 `[model_providers.<id>]` 定义：

```toml
model = "your-model-id"
model_provider = "custom_provider"

[model_providers.custom_provider]
name = "Custom LLM"
base_url = "https://api.example.com/v1"
env_key = "CUSTOM_API_KEY"
wire_api = "responses"  # 唯一合法值，chat/completions 已于 2026 年 2 月移除
```

**重要约束**：Codex 自 2026 年 2 月起**仅支持 OpenAI Responses API wire format**（`wire_api = "responses"` 为唯一合法值且为默认值；`chat` 值已移除，配置中出现会启动时报错）。对于只提供 Chat Completions 的 provider，需在前面放置 LiteLLM 或 OpenRouter 等转换代理。

### Profiles 机制

`$CODEX_HOME/profile-name.config.toml` 作为 overlay 叠加在基础 config 上，通过 `--profile profile-name` 切换。适合在同一机器上维护多套 provider 配置（如 openai-prod / azure-staging / local-ollama）。

### 模型选择

默认推荐 **`gpt-5.5`**（最强复杂编程/计算机使用/研究场景）；`gpt-5.4`（专业工作旗舰）；`gpt-5.4-mini`（快速低成本，适合子 agent）；`gpt-5.3-codex-spark`（实时编码迭代研究预览，仅 ChatGPT Pro）。`/model` 命令支持会话中途切换模型。

---

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **Rust 重写带来的工程质量跃升**：96.5% Rust，毫秒启动、零 GC 暂停、无 Node.js 依赖，适合 CI 并行化启动大量 agent 实例。
2. **app-server JSON-RPC 2.0 作为统一集成层**：TUI、VS Code 扩展、移动 App 共用同一协议，分离渲染层与 agent 核心逻辑。新增 `fs/*`、`model/list` 等方法使客户端功能更完整。
3. **双向 MCP（client + server）**：Codex 既消费 MCP 工具，又暴露自身为 MCP server 供 Agents SDK 编排，形成可嵌套的 agent 生态。
4. **精细化沙箱（OS 原生）**：macOS Seatbelt + Linux bwrap/seccomp + Windows 原生/WSL2，进程树级别隔离，比 Docker 更轻量，比纯软件检查更可信。`workspace-write` 作为默认模式平衡安全与可用。
5. **Hooks 生命周期框架**：10 个事件点可注入自定义脚本，实现记忆自动化、Prompt 扫描、审计日志等，而不需要 fork 核心代码。
6. **Prompt 缓存架构设计**：固定前缀（system + AGENTS.md + 工具定义）+ 动态后缀，Cache-first 的上下文组装是长会话成本控制的关键。
7. **Token 预算追踪（0.142.0）**：可配置跨 agent thread 的 rollout token 预算，提供剩余提醒，预算耗尽时中止 turn，防止意外超支。

### 短板 / 坑

1. **强绑定 OpenAI Responses API**：`wire_api = "responses"` 唯一合法值，`chat/completions` 已于 2026 年 2 月彻底移除，非兼容端点必须接代理，增加运维复杂度。
2. **子 agent Token 成本不透明**：并行 subagent 消耗倍增，但 UI 层面 token 计费粒度不够细，0.142.0 新增的预算追踪仅在用户主动配置时生效。
3. **MCP 动态工具更新 cache miss**：会话中途 MCP server 推送工具变更会破坏 prompt 缓存前缀，导致昂贵的 cache miss。
4. **IDE 扩展对子 agent 可视化滞后**：子 agent 在 app 和 CLI 中可见，IDE 扩展支持"即将推出"，多 agent 场景调试体验不一致。
5. **地区功能受限**：Record & Replay（macOS 专属，不含 EEA/英国/瑞士）、Chronicle（macOS + ChatGPT Pro 专属）、Memories 默认关闭（EEA/英国/瑞士），地区碎片化影响团队统一工作流。

---

## 11. 对 yo-agent 的具体启示

1. **app-server JSON-RPC 2.0 作为引擎/客户端解耦范式**：yo-agent 核心引擎应输出一个平台无关的事件流协议，让 CLI、TUI、QQ bot adapter、Telegram adapter 作为独立消费者接入。参考 app-server 的 Thread/Turn/Item 三层抽象，把"会话-轮次-单元"分层持久化，聊天平台 session 天然映射到 Thread，用户消息到 Turn，工具调用到 Item。新增的 `fs/*` 和 `model/list` 等方法也提示协议应该为客户端能力提供足够的接口覆盖。

2. **AGENTS.md 分层覆盖机制直接复用**：yo-agent 可实现相同的"全局 ~/.yo-agent/AGENTS.md → 项目 .yo-agent/AGENTS.md → 子目录 AGENTS.md"发现链，每个聊天群/频道可有自己的 AGENTS.md 注入，实现群级行为定制而无需改代码。

3. **Hooks 框架替代 monkey-patch 插件**：PreToolUse/PostToolUse/UserPromptSubmit 钩子比"覆写核心类方法"更可维护。yo-agent 可在工具调用前后注入事件，让第三方开发者通过脚本而非 Node.js 插件扩展功能，降低插件开发门槛并保证主进程稳定性。

4. **审批策略与沙箱分层设计**：参考 Codex 的 `on-request / untrusted / never / granular` 四级 + `workspace-write` 作为"安全默认"策略，yo-agent 可为不同聊天平台角色设置不同审批级别（管理员低摩擦 / 普通用户需确认 / 自动化 CI 全自动），而非全局一刀切。

5. **Prompt 缓存前缀固定策略**：yo-agent 在组装 prompt 时，应将系统提示、工具定义、AGENTS.md 等静态内容固定在 prompt 最前部，动态内容（对话历史、工具输出）追加于末尾，最大化 Anthropic/OpenAI 的 prompt caching 命中率，直接降低长会话 token 成本。

6. **MCP server 暴露自身供外部编排**：yo-agent 应实现 `--mcp-server` 模式，将自身作为 MCP server 暴露给 Claude Code、Cursor、Agents SDK 等 orchestrator，而不仅仅是 MCP client。这样 yo-agent 既可作为独立 agent，也可作为更大多 agent 流水线中的一个节点，复用所有内置工具而无需重复开发。

---

## 参考来源

- https://github.com/openai/codex — 官方仓库（Rust 96.5%，Apache-2.0）
- https://github.com/openai/codex/releases — 版本发布页（0.142.0 稳定版，0.143.0-alpha 预发布）
- https://github.com/openai/codex/discussions/7782 — chat/completions 废弃讨论（2026 年 2 月彻底移除）
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md — app-server 协议 README
- https://developers.openai.com/codex/app-server — App-Server 官方文档
- https://developers.openai.com/codex/mcp — MCP 集成文档
- https://developers.openai.com/codex/guides/agents-md — AGENTS.md 规范文档
- https://developers.openai.com/codex/agent-approvals-security — 审批与安全文档
- https://developers.openai.com/codex/config-reference — 配置参考
- https://developers.openai.com/codex/config-advanced — 高级配置
- https://developers.openai.com/codex/cli/features — CLI 特性文档
- https://developers.openai.com/codex/cli/reference — CLI 命令参考
- https://developers.openai.com/codex/subagents — 子 agent 文档
- https://developers.openai.com/codex/hooks — Hooks 文档（10 个事件类型）
- https://developers.openai.com/codex/models — 模型选择文档（gpt-5.5 为默认推荐）
- https://developers.openai.com/codex/memories — 记忆系统文档
- https://developers.openai.com/codex/memories/chronicle — Chronicle 功能文档
- https://developers.openai.com/codex/record-and-replay — Record & Replay 技能录制文档
- https://developers.openai.com/codex/changelog — 变更日志
