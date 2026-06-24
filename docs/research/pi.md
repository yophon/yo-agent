# pi（Pi Coding Agent）

> 一句话：由 Mario Zechner（libGDX 作者）主导、Earendil Inc. 维护的极简终端 AI 编程 agent harness，TypeScript/Node.js，MIT 许可，仓库 https://github.com/earendil-works/pi，官网 https://pi.dev

## 1. 是什么 / 定位

Pi 是一个"minimal terminal coding harness"——有意保持内核极简，通过 TypeScript 扩展机制让用户自定义一切。口号是"there are many agent harnesses, but this one is yours"，哲学为"primitives, not features"：提供积木而非现成解法。设计动机明确：Mario Zechner 认为 Claude Code 行为不可预测，希望打造一个行为稳定、尽可能少加特性的 AI harness。

**核心组成（四包 monorepo）：**
- `@earendil-works/pi-ai`：统一多 provider LLM API 抽象层
- `@earendil-works/pi-agent-core`：工具调用 + 会话状态执行引擎
- `@earendil-works/pi-coding-agent`：面向用户的 CLI TUI（即 `pi` 命令本身）
- `@earendil-works/pi-tui`：差量渲染终端 UI 库

版本现为 **0.80.2**（2026-06-23），npm 包名 `@earendil-works/pi-coding-agent`，约 **65.1k GitHub Stars**，240+ releases。2026 年 4 月 Mario Zechner 加入 Armin Ronacher 联合创立的公益公司 Earendil（详见 lucumr.pocoo.org/2026/4/8/mario-and-earendil/），项目迁至 `earendil-works` 组织，持续 MIT 许可。OpenClaw（378k+ stars）使用 pi SDK 驱动其整个 assistant 层，是 pi 成长最大的外部引用方。

**身份确认依据（identityConfidence: high）：**
- `pi --help` 明确显示 `PI_SHARE_VIEWER_URL=https://pi.dev/session/`
- `--mode text|json|rpc` 与调研线索完全匹配
- GitHub 仓库 earendil-works/pi CHANGELOG.md 最新版 0.80.2（2026-06-23），版本系列与 npm 包完全对应
- Armin Ronacher 的博客文章独立印证 Mario Zechner / Earendil / pi.dev 的关系

## 2. 架构总览（agent loop / 运行时主循环）

Pi 采用**经典单循环 ReAct 范式**（无内置 Plan 阶段，无并行子 agent）：

```
用户输入
  └─► 系统 prompt（AGENTS.md + SYSTEM.md 拼接）+ 消息历史 + 可用工具描述
        └─► LLM 推理 → 选择工具调用 or 直接回答
              ├─► 工具执行（默认：read/write/edit/bash；可选：grep/find/ls）
              │     └─► 结果附回上下文，继续循环
              └─► 最终回答 → 输出到 TUI / JSON stream / RPC
```

**四种运行时模式：**

| 模式 | 触发方式 | 用途 |
|------|----------|------|
| Interactive TUI | `pi`（默认） | 日常开发，彩色 diff、快捷键、会话树 |
| Print / JSON | `pi -p "<prompt>"` / `--mode json` | 脚本化、CI、管道处理 |
| RPC | `--mode rpc` | 通过 stdin/stdout JSONL 双向协议驱动，供非 Node 宿主集成 |
| SDK | Node.js import | 嵌入自有应用（OpenClaw 即用此方式） |

**JSON 事件流格式（`--mode json` 输出的 JSONL 事件类型）：**
```
session / agent_start / turn_start / message_start / message_update /
message_end / turn_end / agent_end / tool_execution_start /
tool_execution_update / tool_execution_end / queue_update /
compaction_start / compaction_end / auto_retry_start / auto_retry_end
```

消息队列支持两种投递模式：steering（当前工具调用完成后插入）vs follow-up（全部工作完成后追加），可在 TUI 中 Enter / Alt+Enter 切换。

**有意不内置的能力**（核心设计选择，非遗漏）：MCP 原生支持、内置 sub-agent、plan 模式、权限弹窗、Todo 列表、后台 bash。这些均以扩展包形式可选提供。

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

**工具（共 7 个，4 个默认启用）：**

| 工具名 | 功能 | 默认启用 |
|--------|------|----------|
| `read` | 读取文件内容 | 是 |
| `write` | 写/覆盖文件 | 是 |
| `edit` | find/replace 编辑文件 | 是 |
| `bash` | 执行 shell 命令 | 是 |
| `grep` | 正则搜索文件内容 | 否（需手动启用） |
| `find` | glob 查找文件 | 否（需手动启用） |
| `ls` | 列目录 | 否（需手动启用） |

README 原文明确："Pi ships with four tools: `read`, `write`, `edit`, and `bash`"，grep/find/ls 可通过 CLI flag 启用。工具通过 CLI flag 管控：`--tools read,bash,edit`（白名单）、`--no-tools`（全禁）、`--no-builtin-tools`（禁内置但保留扩展工具）。

**函数调用机制：** 使用各 provider 原生 tool-use/function calling API，通过 `pi-ai` 层统一抽象。工具 schema 用 Typebox 定义，支持流式进度更新（`tool_execution_update` 事件）。

**MCP 支持：核心明确不支持**。README 原文设计哲学节："**No MCP.** Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."——这是主动设计选择而非遗漏。GitHub Issue #563 是一个用户提交的 MCP 扩展功能请求（2026-01-08），已关闭，官方未实现。第三方 fork `spences10/my-pi` 和 `can1357/oh-my-pi` 各自实现了 MCP 支持，但均非官方 pi 内置。Pi 目前**不是 MCP client/host**。

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复 resume）

**会话存储：** JSONL 文件，每条目含 `id` 和 `parentId`，构成 DAG（有向无环图）而非线性日志，支持原地分支而不复制文件。默认保存至 `~/.pi/agent/sessions/<working-dir>/session.jsonl`。

**压缩（Compaction）策略：**
- 手动：`/compact [自定义指令]`
- 自动（主动）：接近上下文限制时触发
- 自动（被动/溢出重试）：超出上下文时触发
- 历史完整保留于 JSONL，压缩只影响送给 LLM 的消息窗口
- 扩展可通过 `session_before_compact` 事件自定义摘要策略

**Token 可见性：** TUI footer 实时显示 `↑`（input）、`↓`（output）、`R`（cache read）、`W`（cache write）、`CH`（cache hit rate）。

**会话恢复机制：**
- `-c / --continue`：续接最近会话
- `-r / --resume`：TUI 浏览并选择历史会话
- `--session <path|id>`：指定会话文件或 UUID 前缀
- `--fork <path|id>`：从旧会话 fork 出新会话文件
- TUI 内 `/tree` 命令：可视化 DAG，导航任意历史节点并从该点继续
- `/fork`、`/clone` 命令：从当前活跃分支任意点创建新分支

**长期记忆：** 无内置向量检索，但扩展可通过 `pi.appendEntry()` 写入会话持久化条目，语义记忆需自行通过扩展实现。

## 5. Prompt / 系统提示策略（CLAUDE.md/AGENTS.md 类约定、模式如 plan/act）

**约定文件加载顺序（优先级由低到高）：**
1. 全局：`~/.pi/agent/AGENTS.md` 或 `CLAUDE.md`
2. 项目目录层级：从 cwd 向上遍历，所有匹配文件**拼接**（非覆盖）
3. 当前目录 AGENTS.md / CLAUDE.md

**系统 prompt 定制：**
- `~/.pi/agent/SYSTEM.md`：全局替换系统 prompt
- `.pi/SYSTEM.md`：项目级替换
- `APPEND_SYSTEM.md`：追加至系统 prompt
- CLI `--system-prompt <text>`：完全替换
- CLI `--append-system-prompt <text>`：追加（可多次使用）

**Skills（技能）：** 可按需加载的 prompt 片段，通过 slash 命令调用，避免把所有指令塞进系统 prompt，保持 prompt cache 效率。

**Plan 模式：** 非内置，作为**可选扩展**（`plan-mode` 包）提供。安装后 `--plan` flag 激活，可配置路由角色（`plan` 角色 vs `act` 角色），`Ctrl+P` 在模型间循环。

**思维链（Thinking）：** `--thinking <level>`，支持 off / minimal / low / medium / high / xhigh，模型需支持（如 Claude Sonnet/Opus 系列），CLI shorthand `pi --model sonnet:high`。

## 6. 权限与审批（工具执行如何获批、沙箱 seatbelt/landlock/docker）

**Trust 模型（项目信任，非工具级审批）：** Pi 的权限设计不同于 Claude Code 的逐工具审批，而是**项目级信任一次决策**：

1. 启动时检测项目本地资源（`.pi/settings.json`、`.agents/skills`、project 扩展）
2. 若 `~/.pi/agent/trust.json` 无记录，交互模式下提示用户，非交互模式使用 `defaultProjectTrust` 配置（ask/always/never）
3. 信任决策前只加载上下文文件和全局扩展；信任后加载项目扩展和设置
4. `--approve/-a` / `--no-approve/-na` flag 覆盖单次运行
5. `/trust` 命令写入 `trust.json` 持久化决策

**工具级控制：** 通过白名单 CLI flag 而非运行时弹窗。扩展可通过监听 `tool_call` 事件拦截/阻断危险操作（实现自定义 gate）。

**沙箱：** **无内置沙箱**。官方文档明确声明 pi 不提供文件系统、进程、网络、credentials 的内置访问控制，建议用户在需要更强隔离时自行容器化。README 中也强调供应链安全（依赖锁定、shrinkwrap、audit workflow），但运行时沙箱本身由用户/扩展负责。

## 7. 多平台 / 传输 / 接入层（CLI/IDE/TUI/聊天平台、协议 MCP/ACP/A2A/OneBot）

**CLI：** 主入口，支持 macOS / Linux / Windows（winpty）

**TUI：** 使用自研 `@earendil-works/pi-tui` 库实现差量渲染终端 UI，支持扩展自定义 TUI 组件（编辑器、overlay、widget）

**IDE 集成：**
- `dnouri/pi-coding-agent`：Emacs 前端扩展
- RPC 模式可供任意 IDE 插件消费

**RPC 协议（`--mode rpc`）：** stdin/stdout JSONL，LF 分隔。命令类型：
- Prompting：`prompt`, `steer`, `follow_up`, `abort`
- State：`get_state`, `get_messages`
- Model：`set_model`, `cycle_model`, `get_available_models`
- Session：`new_session`, `switch_session`, `fork`, `clone`, `export_html`
- Execution：`bash`, `compact`, `get_session_stats`

响应带可选 `id` 字段做请求/响应关联，事件异步流式推送。扩展 UI 子协议支持 `select/confirm/input/editor`（需等待用户响应）及 `notify/setStatus/setWidget`（fire-and-forget）。

**聊天平台：** 无原生接入，需自行通过 RPC 或 SDK 模式桥接。

**协议标准：** 不支持 MCP（host/client）、ACP/A2A/OneBot。MCP 哲学上被主动拒绝，用 Skills + 扩展自定义工具替代。

**会话分享：** `/share` 命令发布至 GitHub Gist，可生成 `https://pi.dev/session/<id>` 链接；另有 Hugging Face 数据集发布工具用于模型训练贡献。

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

**扩展（Extensions）：** 最核心的扩展机制，TypeScript 模块，导出默认 factory 函数：

```typescript
export default function(pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", description: "...", schema: T.Object({...}),
    execute: async (args, ctx) => { ... } });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { /* 可拦截 */ });
  pi.on("before_agent_start", async (event, ctx) => { /* 注入 context */ });
}
```

**完整扩展事件钩子（ExtensionAPI `pi.on()` 全部事件）：**

| 分类 | 事件 |
|------|------|
| 生命周期 | `project_trust` / `session_start` / `session_shutdown` |
| 会话管理 | `session_before_switch` / `session_before_fork` / `session_before_tree` / `session_compact` / `session_before_compact` / `resources_discover` |
| Agent | `before_agent_start` / `agent_start` / `agent_end` / `turn_start` / `turn_end` / `message_start` / `message_update` / `message_end` / `context` |
| 工具 | `tool_call` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `tool_result` / `user_bash` |
| Provider | `before_provider_request` / `after_provider_response` |
| 模型 | `model_select` / `thinking_level_select` |
| 输入 | `input` |

加载路径：`~/.pi/agent/extensions/`（全局）、`.pi/extensions/`（项目）、pi 包（npm/git 分发）。

**Skills（技能）：** 可按需调用的 prompt 片段 + 可选工具集，以 slash 命令触发，不污染基础系统 prompt。

**Prompt Templates：** 可复用的 prompt，slash 命令展开，支持参数。

**Packages（包管理）：**
```bash
pi install npm:@foo/pi-tools[@version]
pi install git:github.com/user/repo[@tag]
pi install https://github.com/user/repo[@tag]
```

**Sub-agent：** 核心不内置，由扩展/包实现。`can1357/oh-my-pi`（TypeScript + ~55k 行 Rust 核心的独立重量级 fork）实现了"First-class subagents"（独立 worktree 隔离，schema 验证输出），通过 `agent://` scheme 透明访问子 agent 输出字段——但这已是一个独立项目而非 pi 扩展包。

**多 agent 委派：** 官方 pi 无原生协调机制，需通过扩展调用 SDK 或 RPC 实例化多个 pi session 来实现。

## 9. Provider 抽象（是否 BYOK 多模型）

**完整 BYOK（Bring Your Own Key）**，支持 25+ provider，40+ 模型：

**订阅 OAuth 登录（`/login`，无需 API key，token 存于 `~/.pi/agent/auth.json`）：**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro（via OpenAI Codex）
- GitHub Copilot

**API Key 模式（主要 provider）：**

| Provider | 环境变量 |
|----------|---------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` |
| Google Gemini / Vertex AI | `GEMINI_API_KEY` |
| Amazon Bedrock | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Groq / Cerebras / xAI / Fireworks / Together | 各自 env var |
| OpenRouter | `OPENROUTER_API_KEY` |
| Cloudflare Workers AI / AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| Mistral / MiniMax / Moonshot / Kimi For Coding | 各自 env var |
| Xiaomi MiMo（CN/AMS/SGP 区域） | 各自 env var |
| NVIDIA NIM / Hugging Face / Vercel AI Gateway | 各自 env var |
| ZAI Coding Plan（Global & China） | 各自 env var |

**自定义 provider：** 使用 OpenAI/Anthropic/Google 兼容 API 的，可写入 `~/.pi/agent/models.json`；完全自定义 OAuth 或 API 格式的，通过扩展实现。

**模型切换：** 运行中 `Ctrl+L` 或 `/model` 命令；`--models` flag 配置 `Ctrl+P` 循环列表（支持 glob `anthropic/*`、模糊匹配、provider/id 前缀、`:thinking` level 后缀）。

## 10. 亮点设计（值得 yo-agent 借鉴）/ 短板 / 坑

### 亮点

**1. 三模态输出（text/json/rpc）设计极优雅**
同一个 agent 内核，`--mode json` 输出结构化 JSONL 事件流，`--mode rpc` 变成双向协议驱动的进程服务，SDK 模式嵌入 Node.js 应用。这种"内核复用、接口分层"的设计让同一引擎既能 CLI 直用，又能被 IDE、自动化脚本、聊天平台桥接消费。

**2. 树状会话（JSONL DAG）实现无损分支**
每条消息存 `id` + `parentId`，整个会话历史是 DAG，不需要复制文件就能分支。`/tree` TUI 可视化任意历史节点并从该节点继续，`/fork` 实时创建分支——这是比线性日志或快照机制更优雅的历史管理方案。

**3. "primitives, not features" 架构哲学**
Plan 模式、MCP 接入、sub-agent、权限弹窗全部通过扩展实现，内核保持极简。这使维护成本极低，核心稳定，高级功能通过包分发按需加载，不同用户的使用场景可完全不同。

**4. 扩展 API 设计完备（20+ 生命周期钩子）**
`tool_call` 事件可拦截/阻断，`before_agent_start` 可动态注入 context，`session_before_compact` 可自定义摘要策略，`before_provider_request` 可修改 payload——将 agent 生命周期关键节点全部暴露给扩展，形成完整的扩展点图谱。

**5. Token 可见性与 cache hit rate 实时展示**
footer 显示 `↑↓R W CH`，开发者对 context 使用情况一目了然，cache hit rate 指标尤其对调试 prompt 缓存策略有价值。

**6. Skills 机制减少 prompt 污染**
Skills 是按需 slash 触发的 prompt 片段，不塞进系统 prompt，保持 prompt cache token 不膨胀——对长期项目的成本控制有实质意义。

### 短板 / 坑

- **无内置沙箱**：`bash` 工具可执行任意系统命令，用户须自行容器化，对开放给第三方使用的场景危险
- **无工具级运行时审批**：不同于 Claude Code 每次危险操作弹窗确认，pi 只有项目级信任一次性决策，安全粒度粗
- **主动拒绝 MCP**：pi 以"No MCP"作为设计立场，开箱不支持 MCP 协议，需第三方 fork 或自行扩展实现
- **无内置多 agent 协调**：sub-agent 完全依赖扩展，缺乏标准化协调语义
- **扩展执行任意代码**：安全边界完全依赖用户对扩展来源的信任
- **Windows 支持**：通过 winpty 支持，体验不如 macOS/Linux

## 11. 对 yo-agent 的具体启示

**1. 三模态输出设计直接可移植**
yo-agent 应从设计之初就区分三个输出层：交互 TUI 层（给终端用户）、JSON event stream 层（给 CI/脚本/其他 agent 消费）、RPC 层（给聊天平台桥接如 QQ/Telegram）。三者复用同一内核事件总线，各自格式化。pi 的 JSONL 事件类型（session/turn_start/tool_execution_start 等）可直接作为 yo-agent 事件命名参考。

**2. 会话 DAG（JSONL + id/parentId）替代线性日志**
yo-agent 设计会话存储时不要用普通数组，用 `{id, parentId, ...}` 结构存 JSONL，天然支持分支、fork、时间旅行。聊天平台（Telegram/QQ）的消息引用回复天然映射到 DAG 的 parentId 关系，实现消息线程与 agent 分支的统一。

**3. 扩展点：在 agent 生命周期关键节点暴露钩子**
yo-agent 应在 `before_agent_start`（注入 context）、`tool_call`（权限 gate）、`before_compact`（自定义摘要）、`before_provider_request`（payload 修改）、`session_start/shutdown`（资源管理）等节点提供钩子接口。MCP 接入、聊天平台桥接、权限审批都可以做成钩子插件，而不是内核逻辑。

**4. Tool 白名单 flag + 扩展替换内置工具**
yo-agent 的工具系统应允许按名称白名单/黑名单（对应 pi 的 `--tools` flag），同时允许扩展注册同名工具覆盖内置工具（比如把 `bash` 替换为沙箱化版本）。这样可以在不 fork 内核的情况下切换安全级别。

**5. Skills 机制：按需注入而非堆叠系统 prompt**
yo-agent 针对不同聊天平台和场景（QQ 群聊 vs Telegram 频道 vs 编程任务），应把 prompt 片段设计为 skill/template，slash 命令按需激活，而不是把所有平台 prompt 全部塞进系统 prompt。这对成本控制和 prompt cache 命中率都有直接收益。

**6. 模型切换 + thinking level 快捷键**
yo-agent 应内置 `Ctrl+P` 风格的模型循环切换和 thinking level 调节，尤其在聊天平台适配层：轻量任务用 haiku，复杂编程任务用 sonnet:high，无需重启 session。

## 参考来源

- https://github.com/earendil-works/pi（主仓库）
- https://pi.dev/（官网）
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/README.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md
- https://lucumr.pocoo.org/2026/4/8/mario-and-earendil/（Armin Ronacher 博客，印证 Mario/Earendil/pi 关系）
- https://github.com/earendil-works/pi/issues/563（MCP feature request，已关闭，非官方实现）
- https://github.com/can1357/oh-my-pi（TypeScript+Rust 重量级 fork，非官方 pi 分支）
- https://pi.dev/docs/latest/providers（provider 列表）
