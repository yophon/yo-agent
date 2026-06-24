# Claude Code

> 一句话：Anthropic 官方出品的终端 agentic 编程工具，深度集成 Claude 模型，以 MCP 为扩展标准，通过 hooks/subagents/skills 三层机制实现高度可定制的自主编码工作流。厂商：Anthropic · 语言：TypeScript/Node（核心闭源，CLI npm 发布）· License：商业闭源（CLI 免费可用，需 Claude 订阅或 Anthropic API Key）· 仓库：https://github.com/anthropics/claude-code

---

## 1. 是什么 / 定位

Claude Code 是 Anthropic 官方发布的 CLI 形式 agentic 编程助手，于 2025 年 2 月首发，当前版本 v2.1.187（2026-06-23），每周多次发版。它不是补全插件，而是一个能**自主规划、读写文件、执行 shell、调用外部服务**的完整 agent 运行时。

定位上处于「通用开发 agent」而非单一语言工具——它能读代码、写代码、跑测试、提交 Git、评审 PR、触发 CI，乃至通过 MCP 连数据库、Issue Tracker、Slack。

运行入口为 `claude` CLI，也有 VS Code/JetBrains 插件（嵌入 IDE 终端）、Desktop App（macOS/Windows GUI）、claude.ai/code（Web 版云端 agent）、移动 App（iOS/Android 远程操控）和 Chrome 扩展。每个会话均绑定一个 Claude 模型（默认 Sonnet 4.6，支持 Opus 4.7/4.8/Haiku 系列）。

---

## 2. 架构总览（agent loop / 运行时主循环）

Claude Code 采用**事件驱动的单循环 ReAct 范式**：

```
用户输入 → 上下文组装（CLAUDE.md + 记忆 + 工具列表） → 模型推理
→ 工具调用（Action） → hooks 拦截/放行 → 工具执行（Observation）
→ 结果注入上下文 → 模型继续推理 → 直到 Stop
```

关键特性：

- **无显式 Plan-then-Act 分离**，但 `/plan` 命令可切换至 plan 模式，此时模型只读不写，由内置 Plan subagent 负责探索代码库，主会话保持只读直到用户批准计划。
- **并行子 agent 扇出**：`/batch` 指令将大任务分解为 5~30 个独立单元，各自在 git worktree 中并行执行，结束后各自提 PR。`/fork` 则将当前会话状态 fork 给后台 subagent 处理侧任务。
- **Background agent**：`/background` 把整个会话脱离终端后台运行，可通过 `claude agents` 监控或 Web 端继续。
- **Ultracode 模式**：`/effort ultracode` = xhigh 推理 + 自动 workflow 编排，是最重量级的单任务自主执行模式。
- **Goal 模式**：`/goal <条件>` 让 Claude 跨多轮持续工作直到条件满足，无需用户每轮手动触发。

---

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

### 内置工具完整列表（2026-06 官方文档核查，共 38 个）

| 类别 | 工具名 | 作用 |
|------|--------|------|
| 文件读写 | `Read`, `Write`, `Edit`, `MultiEdit` | 精确字符串替换；Edit 有 read-before-edit 前置校验 |
| 搜索 | `Grep`（ripgrep 底层）, `Glob`（glob 模式匹配）| Grep 自动跳过 gitignore 文件 |
| 代码智能 | `LSP` | 跳转定义/引用/类型错误，需安装语言服务器插件 |
| Shell | `Bash`（2min/10min 超时，30k 字符截断）, `PowerShell`（Windows/可选）| 均需 permission |
| Notebook | `NotebookEdit` | Jupyter notebook 单 cell 级操作（Read 用通用 Read 工具）|
| Web | `WebFetch`（先转 MD 再小模型摘要）, `WebSearch`（Anthropic 后端，最多 8 次内部搜索）| 均需 permission |
| 子 agent | `Agent` | 在独立上下文窗口中执行子任务并返回摘要；也用于 fork |
| Plan 模式 | `EnterPlanMode`, `ExitPlanMode` | 进入/退出计划模式 |
| Worktree | `EnterWorktree`, `ExitWorktree` | git worktree 隔离 |
| 任务管理 | `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskStop`, `TaskOutput`（已废弃）| 结构化任务清单，v2.1.142 后替代 `TodoWrite` |
| 定时 | `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup` | 会话内定时/循环任务 |
| MCP 资源 | `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ToolSearch`, `WaitForMcpServers` | 发现和延迟加载 MCP 工具 |
| 协作 | `SendMessage`, `PushNotification`, `Monitor` | Agent 间消息、桌面/手机推送、后台监控流 |
| 工作流 | `Workflow`, `Skill`, `AskUserQuestion` | 动态 workflow 编排、Skills 调用、多选问题 |
| 其他 | `Artifact`, `RemoteTrigger`, `ShareOnboardingGuide`, `TodoWrite`（已废弃）| 发布工件/云端 Routines/团队指南 |

### 函数调用机制

Claude 通过 Anthropic API 的**原生 tool use**发起调用，tool_input 为 JSON，harness 执行后将 tool_result 追加到对话上下文。工具名既是 API 的函数名，也是权限规则和 hook matcher 的匹配目标。ToolSearch 机制允许延迟加载大量 MCP 工具（避免超出 token 限制）；`WaitForMcpServers` 在 tool search 禁用时等待 MCP 连接完成。

### MCP 支持

Claude Code 是完整的 **MCP host/client**：
- 支持 4 种传输协议：`stdio`（本地进程）、`http`（streamable HTTP，推荐，MCP 规范名 `streamable-http` 也被接受）、`sse`（Server-Sent Events，已废弃，仍兼容）、`ws`（WebSocket，双向推送，不支持 OAuth）。
- MCP 服务器工具直接注入到 Claude 的工具列表，可通过 `mcp__<服务器名>__<工具名>` 格式在权限规则中引用。
- MCP prompts 可映射为 `/mcp__<server>__<prompt>` slash commands。
- MCP Resources 可通过 `ListMcpResourcesTool` / `ReadMcpResourceTool` 访问。
- 支持 OAuth 2.0 认证远程 HTTP MCP 服务器（WebSocket 不支持 OAuth，仅支持静态 header 认证）；`/mcp` 命令管理连接状态。
- MCP 服务器可声明 `claude/channel` 能力，成为事件推送通道（接收 Telegram/Discord/Webhook 消息触发 Claude）。
- 配置文件：`.mcp.json`（项目共享）、`~/.claude.json`（用户全局）；两者均为受保护路径，不会被自动批准写入。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

### 上下文窗口

模型最大支持 1M token（Sonnet 4.6/Opus 4.7），但一次 2 小时编码会话含文件读取、构建日志、多轮修改，实际可轻易消耗 10 万+ token。Claude Code 在约 95% 容量时自动触发 compaction，也支持 `PreCompact`/`PostCompact` hook 拦截压缩过程。

### /compact 压缩机制

`/compact [instructions]` 手动压缩，建议在 60% 容量时主动触发。Compaction 会将整个对话历史替换为 LLM 生成的摘要，**以下内容在压缩后仍会重新注入**：
- 项目根 CLAUDE.md（从磁盘重新读取）
- 活跃的 skills/hooks 配置
- 子目录 CLAUDE.md 在下次读取相应文件时重新加载

注意：仅在对话中口头约定的约束（如"不要直接 push main"）在 compaction 后可能丢失，需写入 CLAUDE.md 或 deny rule 才能持久。

### 长期记忆

**两套机制并存**：

1. **CLAUDE.md（人工编写）**：加载到每个会话上下文头部，作为 user 消息注入（软约束）。层级：组织托管 > 用户全局（`~/.claude/CLAUDE.md`）> 项目（`./CLAUDE.md` / `./.claude/CLAUDE.md`）> 本地私有（`CLAUDE.local.md`）。`.claude/rules/` 目录支持按文件路径 glob 懒加载规则（节省 token）。

2. **Auto memory（Claude 自动写入）**：存储在 `~/.claude/projects/<project>/memory/MEMORY.md`，同一 git repo 的所有 worktree 共享。每次会话启动加载 `MEMORY.md` 前 200 行或 25KB，详细 topic 文件按需读取。子 agent 可启用独立的 memory 目录（`~/.claude/agent-memory/`）。

### 会话恢复

- `claude --continue`（`-c`）：继承上次会话配置，全新上下文开始。
- `claude --resume <id>`（`-r`）：完整恢复之前会话，支持分支对话（`/branch`/`/resume`）。
- `/fork <指令>`：将当前对话 fork 给后台子 agent，主线程继续工作。
- Background agent：会话脱离终端后持续运行，`--resume` 可重连。

---

## 5. Prompt / 系统提示策略

### CLAUDE.md 约定

CLAUDE.md 不进入 system prompt，而是作为第一条 **user 消息**注入上下文（可通过 `--append-system-prompt` 追加到 system prompt，但需每次传入）。这意味着它是 **软约束**，而非强制执行层。强制逻辑必须通过 hooks 实现。

写作建议：
- 每个文件目标 200 行以内（超长降低遵从率）
- 用 markdown 标题/列表结构化
- 规则要具体可验证（"npm test 前 commit" 而非 "测试你的改动"）
- 通过 `@path/to/file` 语法 import 其他文件

### 支持 AGENTS.md

可通过 `@AGENTS.md` import 兼容 OpenAI Codex CLI 的 AGENTS.md，或用 symlink 共用。

### Skills 系统

Skills 是保存在 `.claude/skills/<name>/SKILL.md` 的 prompt 模板（YAML frontmatter + Markdown 正文），通过 `Skill` 工具调用。内置 Skills 包括：`/code-review`、`/security-review`、`/simplify`、`/run`、`/verify`、`/debug`、`/batch`、`/deep-research`、`/loop` 等。Skills 的关键优势是**只在被调用时加载上下文**，而非每次会话都占用 token。

### 权限模式（Permission Mode）

| 模式 | 行为 |
|------|------|
| `default` | 仅读取免批，写操作/Shell 需逐一审批 |
| `acceptEdits` | 自动批准文件写操作和常用 FS 命令（mkdir/touch/rm/rmdir/mv/cp/sed）|
| `plan` | 只读，不执行任何修改，计划完成后用户选择切换到哪个执行模式 |
| `auto` | 由独立服务端分类器模型实时评估每个动作的安全性；需 v2.1.83+ |
| `dontAsk` | 自动拒绝所有会触发 prompt 的工具调用，仅 allow 规则和只读 Bash 命令通行，用于 CI |
| `bypassPermissions` | 跳过所有检查，包括 protected paths（v2.1.126+），仅限容器/VM 隔离环境 |

Shift+Tab 在 default → acceptEdits → plan 之间循环切换。受保护路径在 bypassPermissions 之外的所有模式下写操作不会被 allow 规则自动批准。

---

## 6. 权限与审批（工具执行如何获批、沙箱）

### 三层权限架构

1. **Permission Mode**：会话级基础策略（见上节）
2. **Permission Rules**（settings.json）：工具粒度的 allow/ask/deny 规则，格式如 `Bash(npm run *)`, `Edit(/src/**)`, `WebFetch(domain:example.com)`。规则文件层级：托管策略 > 用户（`~/.claude/settings.json`）> 项目共享（`.claude/settings.json`）> 本地私有（`.claude/settings.local.json`）。
3. **Hooks**：30 种生命周期事件（见下文），覆盖 SessionStart/End、UserPromptSubmit/Expansion、PreToolUse/PostToolUse/PostToolUseFailure/PostToolBatch、PermissionRequest/PermissionDenied、SubagentStart/Stop、PreCompact/PostCompact 等，支持 command/HTTP/MCP_tool/prompt/agent 五种实现类型。

### Hooks 系统（核心可编程拦截层）

实际支持 **30 种 hook 事件**（非原先描述的"五类"），覆盖：
- 会话级：SessionStart、SessionEnd、Setup
- 用户输入级：UserPromptSubmit、UserPromptExpansion
- 工具级：PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch
- 权限级：PermissionRequest、PermissionDenied
- 通知级：Notification、MessageDisplay、Stop、StopFailure
- 子 agent 级：SubagentStart、SubagentStop
- 任务级：TaskCreated、TaskCompleted
- 团队级：TeammateIdle
- 配置级：InstructionsLoaded、ConfigChange、CwdChanged、FileChanged、WorktreeCreate、WorktreeRemove
- 压缩级：PreCompact、PostCompact
- MCP 级：Elicitation、ElicitationResult

`PreToolUse` hook 可输出 `permissionDecision: allow|deny|ask|defer` 实现代码层面的工具调用拦截，不依赖模型判断。

### Protected Paths

`.git`, `.claude`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer` 等目录及 shell rc/gitconfig/npm rc 等配置文件受保护，在 default/acceptEdits/plan 模式下写操作强制弹出审批，auto 模式路由分类器，dontAsk 拒绝，bypassPermissions 放行（v2.1.126+）。

### Auto Mode 分类器

auto 模式由独立服务端分类器模型在每次 Shell/网络操作前评估，与主模型无关（更换模型不影响分类器）。分类器可见用户消息+工具调用+CLAUDE.md，但不可见工具执行结果（防 prompt injection）。默认阻止：`curl | bash`、mass cloud 删除、强制 push main、`git reset --hard`（v2.1.182+）、`terraform destroy` 等。对 subagent 分三阶段（spawn 前/执行中/完成后）审查，spawn 前检查需 v2.1.178+。

---

## 7. 多平台 / 传输 / 接入层

### 客户端形态

| 形态 | 说明 |
|------|------|
| CLI（`claude`）| 主入口，TUI/fullscreen 两种渲染模式 |
| VS Code 扩展 | 嵌入 IDE 终端，增加侧边栏权限指示器 |
| JetBrains 插件 | 同 CLI，在 IDE 终端运行 |
| Desktop App | macOS/Windows GUI，支持模式选择器 |
| claude.ai/code（Web）| 云端 agent，运行在 Anthropic 托管环境，支持 GitHub 连接 |
| 移动 App（iOS/Android）| 通过 Remote Control 从手机继续本地会话 |
| Chrome 扩展 | `/chrome` 配置，在浏览器上下文中操作 |

### 协议接入

- **MCP**：核心扩展协议，Claude Code 是 MCP host，通过 stdio/HTTP/SSE/WebSocket 连接外部工具。
- **Channels**（MCP 扩展）：MCP 服务器可 push 消息到会话，支持接入 Telegram、Discord、Webhook 等。这是目前最接近「聊天平台接入」的机制，但仍是 CLI 主会话主导的架构，而非原生 IM bot。
- **Remote Control**：`/remote-control` 让本地会话通过 claude.ai 从另一设备继续，实质是 Web UI 代理本地 CLI 执行。
- **Agent SDK**：Anthropic 官方 SDK 允许在代码中以编程方式驱动 Claude Code 会话（headless 模式），`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` 可关闭内置 subagent。

不支持：OneBot、A2A、ACP 协议。

---

## 8. 插件 / 扩展 / 子 agent

### Plugins 系统

`.claude/plugins/` 中的插件可打包分发 skills、hooks、subagents、MCP 服务器、CLAUDE.md 片段等。通过 `/plugin install <name>@<marketplace>` 安装，支持官方 marketplace（`anthropics/claude-plugins-official`）和私有 marketplace。

### Subagents（子 agent）

Markdown 文件（YAML frontmatter + 系统提示），存储于（优先级从高到低）：
- 组织托管 > `--agents` CLI flag > `.claude/agents/`（项目）> `~/.claude/agents/`（用户）> 插件内 agents/

**内置子 agent（5 个）**：
- `Explore`：快速只读代码库探索，使用 **Haiku** 模型，跳过 CLAUDE.md 加载加速响应
- `Plan`：Plan 模式下的代码库研究，继承主会话模型，只读
- `general-purpose`：复杂多步任务，全工具权限，继承主会话模型
- `statusline-setup`：配置状态栏，使用 **Sonnet** 模型
- `claude-code-guide`：回答 Claude Code 功能问题，使用 **Haiku** 模型

**关键配置字段**：
- `model`：可指定比主会话更便宜的模型（如 Haiku）
- `tools`/`disallowedTools`：工具黑白名单（两者都设时 disallowedTools 优先）
- `permissionMode`：子 agent 的权限模式（auto 模式下被忽略，统一由分类器管控）
- `isolation: worktree`：在独立 git worktree 中运行
- `memory`：启用持久化 memory 目录（`~/.claude/agent-memory/`）
- `maxTurns`：限制子 agent 最大轮次

**多 agent 协作**（Agent Teams）：主 agent 通过 `SendMessage` 工具向 teammate agent 发送消息，v2.1.186+ 后台 subagent 的权限 prompt 会浮现到主会话（此前版本后台 subagent 会自动拒绝触发 prompt 的工具调用）。

---

## 9. Provider 抽象（是否 BYOK 多模型）

Claude Code **完整支持 BYOK 多 provider**，且是官方产品中覆盖最广的：

| Provider | 接入方式 | 认证 |
|----------|----------|------|
| Anthropic API | `ANTHROPIC_API_KEY`（默认）| API Key |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` | IAM/OIDC |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` | OIDC/服务账号 |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` | API Key / Entra ID |
| LLM Gateway | `ANTHROPIC_BASE_URL` 自定义 | 取决于网关 |

Auto 模式在 Bedrock/Vertex/Foundry 需额外设置 `CLAUDE_CODE_ENABLE_AUTO_MODE=1`（v2.1.158+），且只支持 Opus 4.7/4.8；Anthropic API 支持 Opus 4.6+/Sonnet 4.6。Monitor 工具、PushNotification、RemoteTrigger/Routines 等功能在 Bedrock/Vertex/Foundry 上不可用。

模型选择：`/model` 命令会话内切换，`settings.json` 中的 `model` 字段为默认值。子 agent 可独立指定不同模型（如主会话用 Opus 4.7，探索 subagent 用 Haiku）。

---

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **30 种 Hook 事件的完备拦截矩阵**：从 SessionStart 到 PostToolBatch、PermissionRequest、PreCompact，覆盖 agent 生命周期的每个关键节点，配合 command/HTTP/MCP_tool/prompt/agent 五种实现方式，形成目前同类工具中最细粒度的可编程工作流控制系统。`PreToolUse` 输出 `permissionDecision` 不经过模型判断，彻底解耦安全策略与推理层。

2. **Subagent 上下文隔离设计**：Explore 子 agent（Haiku 模型）在独立上下文完成代码库搜索，只将摘要返回主会话，防止探索任务污染主上下文。结合 worktree 隔离，`/batch` 可并行处理复杂重构且各分支互不干扰。

3. **Permission Mode 的分类器架构**：auto 模式不依赖静态规则，而是服务端 LLM 实时评估，且与主模型独立（切换模型不影响安全分类）。分类器可见 CLAUDE.md 内容，但不可见工具执行结果（防 prompt injection），是安全性与自动化之间的精妙平衡。

4. **CLAUDE.md 软约束 + hooks 硬约束的分层设计**：行为指导（CLAUDE.md 作为 user 消息注入）与强制执行（hooks 在工具调用前/后执行不依赖模型判断）分离，避免"系统提示越狱"导致约束失效。

5. **Skills 的懒加载机制**：Skills 只在被主动调用时加载 prompt 模板，而非每次会话都占用上下文，使得可以维护大量领域专用 workflow 而不增加基础 token 消耗。

### 短板

1. **核心闭源**：CLI 本体 TypeScript 代码不开源，社区无法参与底层改进，无法自定义 agent loop 主循环。
2. **Channels 架构仍以 CLI 会话为主控**：虽然 MCP Channels 允许外部推送消息，但整体架构仍以 CLI 会话为主控，不是原生 IM bot——接入 QQ/微信等 IM 平台需要额外的桥接层，且体验不如原生 bot。
3. **上下文压缩不透明**：`/compact` 后的摘要质量由 Claude 自主生成，无法保证所有技术细节被正确保留，偶现"失忆"问题；PreCompact hook 可干预但无法完全保证。
4. **Auto mode 模型限制**：auto 模式在 Bedrock/Vertex/Foundry 仅支持 Opus 4.7/4.8，Sonnet/Haiku 系列不可用，增加使用成本。Monitor、PushNotification 等便捷功能也仅限 Anthropic API。
5. **会话状态不可移植**：auto memory 机器本地存储，无法跨机器/云环境同步，团队协作时每人各自积累记忆；cloud Routines 依赖 claude.ai 订阅，无法在 Bedrock/Vertex 使用。

---

## 11. 对 yo-agent 的具体启示

**1. 实现分层内存架构：CLAUDE.md 模式 vs 动态 auto memory**
yo-agent 应区分「人工撰写的项目约定文件」（类 CLAUDE.md，注入每次会话头部）和「agent 自动积累的学习笔记」（类 auto memory，按 git repo 隔离，只加载 index 文件的前 N 行）。两者分离避免项目约定被 agent 随意覆盖，同时让 agent 能跨会话积累工作经验。

**2. 用 PreToolUse hook 替代系统提示内的约束声明**
Claude Code 的实践证明：把约束写入 system prompt 是软约束，只要有足够理由模型可以忽略；而 hook 在工具调用前以代码逻辑执行，不经过模型判断。yo-agent 应同样提供一个工具调用拦截层（middleware/hook），允许用户注册 `beforeToolUse(toolName, input) => allow|deny|modify` 回调，实现安全策略与业务逻辑的彻底解耦。

**3. Subagent 上下文隔离是解决长任务上下文膨胀的核心手段**
Claude Code 的 Explore subagent 最有价值：将「读取大量代码/日志/搜索结果」的探索任务放到独立上下文窗口，只把摘要返回主会话。yo-agent 在实现「通用 agent 引擎」时，应将任务分配给 child agent（独立 context）并只消费其输出结果，而不是把所有中间内容塞回主会话 — 这对接入 QQ/Telegram 等上下文较短的聊天平台尤为重要。

**4. Permission Mode 的多档策略比单一开关更实用**
yo-agent 应支持至少三档：read-only（plan mode）、supervised（default，每步审批）、autonomous（auto mode，内部策略引擎放行常见操作）。对接聊天平台时，建议默认 supervised 模式，用户可在会话中升级为 autonomous 并限定时间窗口。

**5. Skills 的懒加载 prompt 模板模式优于大 system prompt**
不要把所有 workflow 指令塞进初始 system prompt。yo-agent 应实现 skill 注册表，每个 skill 是一段 Markdown 模板（含前置条件描述），由模型根据当前任务自主判断是否调用，或用户通过斜杠命令显式触发。这样 base context 保持精简，同时支持无限扩展能力。

**6. git worktree 隔离是并行任务的基础设施**
`/batch` 的核心是给每个并行任务分配独立 git worktree，避免并发文件修改冲突。yo-agent 若要支持并行编码任务，应优先在 git worktree 而非分支或临时目录中分配工作区，完成后通过 PR 合并而非直接合并文件系统状态。

**7. 接入 IM 平台的架构参考：Channels 机制**
Claude Code 通过 MCP Channels 让外部系统（Telegram/Discord）推送消息进入 CLI 会话。yo-agent 若要原生支持 QQ/Telegram，应实现双向消息路由：IM 平台消息 → agent 事件队列 → 主循环处理 → 工具调用 → 结果格式化 → IM 平台回复。平台适配层（格式化/权限/频率限制）与 agent 核心（推理/工具执行）完全解耦，可参考 OneBot 协议的思路设计接入层标准。

---

## 参考来源

- https://code.claude.com/docs/en/permission-modes — 权限模式完整文档（2026-06 核查）
- https://code.claude.com/docs/en/hooks — hooks 完整参考（30 种事件，5 种实现类型）
- https://code.claude.com/docs/en/tools-reference — 工具系统完整参考（38 个内置工具）
- https://code.claude.com/docs/en/sub-agents — 子 agent 文档（5 个内置子 agent）
- https://code.claude.com/docs/en/mcp — MCP 接入文档（4 种传输协议）
- https://code.claude.com/docs/en/memory — 记忆/CLAUDE.md 系统文档
- https://code.claude.com/docs/en/commands — 官方命令完整参考
- https://github.com/anthropics/claude-code/releases — 发版记录（v2.1.187 为 2026-06-23 最新）
- https://github.com/anthropics/claude-code — 官方 GitHub 仓库
- https://www.anthropic.com/engineering/claude-code-auto-mode — Auto Mode 工程博客
- https://arxiv.org/html/2604.14228v1 — Claude Code 设计空间学术分析
