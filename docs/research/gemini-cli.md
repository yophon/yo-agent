# Gemini CLI
> 一句话：Google 官方开源终端 AI 编程 agent，将 Gemini 模型能力直接嵌入命令行 · Google / google-gemini · TypeScript · Apache-2.0 · https://github.com/google-gemini/gemini-cli

---

## 1. 是什么 / 定位

Gemini CLI 是 Google 于 2025 年发布的开源 terminal-first AI agent，定位与 Claude Code 直接竞争。它通过 ReAct 循环让 Gemini 模型能够读写代码、执行 shell、抓取 web 内容、调用 MCP 工具，并能编排子 agent。主要使用场景：大型代码库理解与修改、自动化 workflow、PR 审查（配合 GitHub Action）。

**免费额度说明**（截至 2026-06）：Google 账号登录（Gemini Code Assist 免费层）可享受每天 1000 次模型请求，模型为 Gemini Flash 系列。Gemini 2.5 Pro 单独计算，免费层上限约为每分钟 5 次、每天 50 次；API key 无付费情况下上限为每天 250 次（仅限 Flash 模型）。早期文档中流传的"每分钟 60 次、每天 1000 次访问 Gemini 2.5 Pro"已过时，需以官方配额页面为准。

**过渡状态**：2026 年 5 月 Google I/O 宣布 Antigravity CLI 计划，2026-06-18 起 Gemini CLI 停止为 Google AI 免费、Pro、Ultra 个人用户提供服务，迁移至 Antigravity CLI（Go 语言编写，闭源）。但 Gemini CLI 开源仓库本身（Apache-2.0）继续维护，持续为企业 Code Assist Standard/Enterprise 客户提供模型更新和安全修复；最新版本 v0.47.0（2026-06-18 发布），仓库共 106k stars。

---

## 2. 架构总览（agent loop / 运行时主循环）

**ReAct 单循环（Reason → Act → Observe）**：

```
用户输入
  ↓
Turn.run()  [async generator，产出 ServerGeminiStreamEvent 事件流]
  ├─ 向 Gemini API 发送 streaming 请求（sendMessageStream）
  ├─ 逐 chunk 解析 thought parts / text parts / function_call parts
  ├─ 若有 function_call → handlePendingFunctionCall()
  │    ├─ 生成 ToolCallRequest 事件（callId / toolName / args）
  │    ├─ 触发确认事件（弹出审批 UI 或 YOLO 跳过）
  │    └─ 执行工具 → ToolResult → 以 function_response 回注历史
  ├─ 检查 finishReason 决定是否结束循环
  └─ 循环结束 → 产出 Finished 事件（含 usage metadata）
```

核心类：
- `Turn`（`packages/core/src/core/turn.ts`）：单次循环迭代，async generator 产出类型化事件（Retry / Chunk / ToolCallRequest / Finished）
- `GeminiChat`（`packages/core/src/core/geminiChat.ts`）：多轮会话管理，维护 curated history（过滤无效轮次）与 comprehensive history（全量含无效输出），通过 `sendPromise` 串行化队列防止并发竞争
- `PromptProvider`：配置驱动的 system prompt 生成，注入 GEMINI.md 内容和 memory

**思维链（Thinking）**：若模型返回 `thought` parts，自动解析并可在 UI 中展示（inline thinking），不计入普通对话 token 配额。

**错误重试**：mid-stream 错误触发指数退避重试（`StreamEventType.RETRY`），循环继续不中断；`InvalidStreamError` 区分可重试网络错误与永久内容错误，上层最多重试 4 次。

---

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

### 内置工具（`packages/core/src/tools/`）

| 工具 | 类型 |
|------|------|
| read_file / read_many_files | Read |
| write_file / edit | Edit |
| ls / glob / grep / ripgrep | Search |
| run_shell_command / shell_background | Execute |
| web_fetch / web_search | Fetch |
| memory_tool | Other |
| ask_user | Communicate |
| enter_plan_mode / exit_plan_mode | SwitchMode |
| activate_skill / complete_task | Agent |
| write_todos | Plan（TODO 追踪，部分模型上已启用） |
| trackerTools（track_task 等）| Plan |
| read_mcp_resource / list_mcp_resources | Read |
| get_internal_docs | Read |

工具基类 `BaseDeclarativeTool` 要求实现 `build()`（返回 Gemini FunctionDeclaration schema）、`execute()`、可选的 `shouldConfirmExecute()`（控制审批）。类型枚举 `Kind`：Read/Edit/Delete/Move/Search/Execute/Think/Agent/Fetch/Communicate/Plan/SwitchMode/Other。工具通过 `tool-registry.ts` 注册，运行时统一传递给 Gemini API function calling 接口。

### MCP Host/Client

Gemini CLI 是 **MCP Host（客户端）**，支持三种传输：
- **Stdio**：spawn 子进程，stdin/stdout 通信
- **SSE（Server-Sent Events）**：流式 HTTP
- **Streamable HTTP**：HTTP 流式双向通信

配置位于 `~/.gemini/settings.json`（`mcpServers` 字段）。支持 `includeTools`/`excludeTools` 过滤；工具自动按 `mcp_{serverName}_{toolName}` 命名；MCP server 暴露的 prompts 映射为 slash 命令；远程服务器支持 OAuth 认证（含 Google ADC 和 service account 模拟）。MCP 工具响应支持多类型 rich content（text/image/audio/binary）。安全加固：spawn MCP 子进程时自动净化环境变量，防止敏感信息泄露给第三方服务器。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

### 上下文窗口管理

- `model.maxSessionTurns`：限制保留在会话中的轮次数（-1 = 无限），超限自动裁剪旧轮次
- `context.discoveryMaxDirs`（默认 200）：GEMINI.md 搜索目录上限
- `curated history`：过滤掉无效/空 turns，防止 API 报错

### 自动压缩

- `model.chatCompression.contextPercentageThreshold`（默认 0.7）：对话 token 超过上下文窗口 70% 时自动触发压缩
- `model.summarizeToolOutput`：对 shell 工具输出做 LLM 摘要，可配置 token budget
- `/compress` 斜杠命令可手动触发
- 压缩由 `getCompressionPrompt()` 生成摘要指令，历史被"蒸馏"后重新注入

### 长期记忆（GEMINI.md 体系）

分层文件系统记忆：
1. **全局**：`~/.gemini/GEMINI.md`（所有会话通用偏好）
2. **项目**：`.gemini/GEMINI.md`（从 cwd 向祖先目录逐层加载）
3. **子目录**：从 cwd 向下扫描子目录中的 GEMINI.md

文件内使用 `@path/to/file.md` 语法导入其他 Markdown，实现模块化。`/memory refresh` 强制重扫，`/memory show` 展示当前生效上下文，`/memory add` 向记忆文件追加条目。

### JIT 上下文（Just-In-Time Context）

文件系统工具（read_file/list_directory/write_file 等）配备 JIT 上下文探测：在工具调用前自动探测相关子目录结构，仅在需要时注入，避免无谓 token 消耗。

### 会话恢复（Checkpointing）

`--checkpointing` 启用后，每次文件修改前自动保存快照（文件名含时间戳+被修改文件名+工具名）。`/restore` 命令回滚文件系统 + 对话记忆至指定检查点。**注意**：外部副作用（数据库写入等）无法回滚。

---

## 5. Prompt / 系统提示策略（约定文件、Plan/Act 模式）

### GEMINI.md 约定文件

功能等同 Claude Code 的 CLAUDE.md：存储项目规范、架构说明、编码约定。全局 + 项目 + 子目录分层加载，内容拼接后注入 system prompt。`GEMINI_SYSTEM_MD` 环境变量可指定自定义 system prompt 文件。

### 子 agent 定义文件

Subagent 以带 YAML frontmatter 的 `.md` 文件定义（`~/.gemini/agents/` 或 `.gemini/agents/`），frontmatter 声明 `name`、`description`、`tools`（允许通配符 `mcp_*` 或 `*`）、system prompt 正文。

### Plan/Act 双模式

**Plan 模式**（只读研究阶段）：
- 启动：`gemini --approval-mode=plan` 或 `Shift+Tab` 循环切换，或自然语言"enter plan mode"
- 工具访问受限于只读工具（文件读取、搜索、web 研究、ask_user）；Markdown 格式计划文件可写入指定 plan 目录
- 模型路由：自动切换到高推理 Pro 模型（配置允许时），若不可用则静默回退到 Flash
- 退出：用户批准计划后自动切换到实现阶段；非交互环境下自动进入 YOLO 模式

**Act 模式（实现阶段）**：
- 从 Plan 模式批准后自动切换
- 模型路由切换回 Flash 模型（低延迟、低成本）
- Plan 阶段的权限审批不沿用到 Act 阶段（上下文感知权限隔离）

**YOLO 模式**：`gemini --yolo` 或 `Ctrl+Y` 切换，跳过所有工具调用确认。

---

## 6. 权限与审批（工具执行如何获批、沙箱机制）

### 审批模式层级

| 模式 | 行为 |
|------|------|
| `default` | 每次工具调用前弹出确认 |
| `auto_edit` | 仅文件编辑工具自动审批，shell 仍需确认 |
| `plan` | 只读安全模式，Plan 阶段使用 |
| `yolo` | 全部跳过（--yolo 标志或 Ctrl+Y） |

支持 `confirmationPolicy.ts` 中配置 tool 级别 allowlist/blocklist 永久豁免；MCP server 可设置 `trust: true` 跳过该服务器工具的确认。

### 沙箱

- **macOS Seatbelt**：四档预设 profile（`permissive-open`/`restrictive-open`/`strict-open`/`strict-proxied`），环境变量 `SEATBELT_PROFILE` 控制
- **Linux**：支持 Docker、Podman、LXC 容器沙箱，环境变量 `GEMINI_SANDBOX` 控制
- **Windows**：Windows-native 沙箱选项
- 命令替换（`$(...)` 注入）检测：发现即阻断，提示"security risk"
- Shell 工具探测到 `npm install` 等命令时，自动提示请求网络权限扩展

---

## 7. 多平台 / 传输 / 接入层（CLI/IDE/TUI/聊天平台、协议）

### 当前接入层

- **CLI/TUI**：React + Ink 构建的终端 UI，支持 vim 模式、主题、屏幕阅读器
- **非交互/Headless**：`gemini -p "prompt"` 单次运行；`--output-format json` 结构化输出；`--output-format stream-json` 实时事件流
- **GitHub Action**：官方提供，用于 CI/CD 场景的 PR 审查和 issue 分类

### 协议支持

- **MCP**（Model Context Protocol）：作为 client，接入任意 MCP server（stdio/SSE/HTTP）
- **A2A**（Agent-to-Agent Protocol）：用于 Remote Subagent，HTTP+JSON，认证支持 API key / Bearer / Google ADC / OAuth 2.0 PKCE
- **无 OneBot/Telegram/Discord 等聊天平台接入**：设计上纯 terminal-first

---

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

### Extensions 系统

- `gemini -e my-extension` 指定扩展，`-e none` 禁用所有
- 扩展可打包 subagent 定义文件（放 `agents/` 目录），自动发现

### 本地 Subagent

- 定义：`.gemini/agents/*.md` 或 `~/.gemini/agents/*.md`，YAML frontmatter 声明工具集（`*`/`mcp_*` 通配符）和 system prompt
- 调用：主 agent 通过 `@agent-name 任务描述` 语法，或自动路由
- **上下文隔离**：在独立 context loop 中运行，结果摘要返回主 agent（节省主上下文 token）
- **递归保护**：subagent 不能调用其他 subagent；即使 subagent 拥有 `*` 工具通配符，也无法看到或调用其他 agent
- 内置 subagent：`generalist`（全工具）、`cli_help`（文档查询）、`codebase_investigator`（代码分析）
- **执行模型**：官方文档描述为顺序委派（主 agent 调用 subagent 工具并等待结果），并行执行无文档保证

### Remote Subagent（A2A）

- 通过 `kind: remote` + `agent_card_url` 或 `agent_card_json` 配置
- 通信走 A2A 协议（HTTP+JSON），支持多种认证，敏感值支持环境变量/shell 命令动态解析
- `/agents list|reload|enable|disable` 命令管理 agent 状态

---

## 9. Provider 抽象（是否 BYOK 多模型）

**强绑定 Gemini**，不支持其他 provider。三种认证路径：
1. **OAuth（Google 账号）**：免费（Flash 模型 1000 次/天），不支持 token 缓存
2. **API key（`GEMINI_API_KEY`）**：BYOK，支持 token 缓存，灵活计费
3. **Vertex AI（`GOOGLE_APPLICATION_CREDENTIALS`）**：企业级，支持 VPC、审计日志

模型选择：`GEMINI_MODEL` 环境变量或配置的 `model.name`，支持模型别名系统。Plan 模式自动路由 Pro 模型，Act 模式路由 Flash 模型。社区存在通过 Bifrost/Cloudflare AI Gateway 等网关的非官方绕过方案；GitHub issue #23385 提出支持 OpenAI-compatible endpoint 的 feature request，尚未合并。

---

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **Plan/Act 双模式 + 自动模型路由**：Planning 阶段自动用推理更强的 Pro 模型，执行阶段切换 Flash 节省成本，且 Plan 阶段的工具权限与 Act 阶段完全隔离（上下文感知权限），防止意外执行。

2. **Subagent 上下文隔离架构**：子 agent 在独立 context loop 中运行，仅摘要结果返回主 agent，主上下文不被子任务污染，递归保护确保不会形成调用环。

3. **分层 GEMINI.md + `@import` 模块化记忆**：全局/项目/子目录三级覆盖，内部可用 `@path` 导入其他 Markdown，将大型项目上下文拆分管理。

4. **A2A 协议 Remote Agent**：内置 Agent-to-Agent 协议支持，可通过 HTTP+JSON 连接外部独立 agent 服务，支持 OAuth PKCE 等企业认证。

5. **OTel 全链路可观测**：内置 OpenTelemetry，符合 GenAI 语义规范，session/tool/token 维度 metrics 可推送任意 OTLP 后端（Jaeger/Prometheus 等）。

6. **Checkpointing 会话快照**：文件修改前自动保存带时间戳快照，`/restore` 一键回滚文件系统和对话记忆，降低 YOLO 模式风险。

### 短板 / 坑

1. **强锁 Gemini**：原生不支持任何非 Google 模型，无 provider 抽象层
2. **subagent 并行无文档保证**：官方文档描述为顺序委派，并行能力存疑，早期 blog 描述不一致
3. **免费层 Gemini 2.5 Pro 配额极低**：实际上 Pro 模型有独立配额（约 50 次/天），远低于 Flash 的 1000 次/天；OAuth 路径不支持 token 缓存
4. **外部副作用无法回滚**：Checkpointing 只覆盖文件系统，数据库/API 调用无法撤销
5. **聊天平台接入缺失**：设计上纯 terminal-first，无官方 Telegram/Discord/QQ 接入
6. **Antigravity 迁移不透明**：个人用户被迁往闭源替代品，社区贡献者因此不满（过 6000 个 PR 合入后项目"弃置"），开源可持续性存疑

---

## 11. 对 yo-agent 的具体启示

1. **Plan/Act 模式分离 + 模型路由**：yo-agent 可在内核层面区分 `plan` 和 `exec` 两个状态机节点，plan 阶段限制工具集为只读，并在 config 中声明"plan 模型"和"exec 模型"对接不同 provider/model-id，节省成本同时让用户在审批前看到完整计划。

2. **Subagent 上下文隔离模式**：将子任务 dispatch 给独立的 child agent（独立上下文、独立工具集），只将 summary 返回主 loop。可避免工具调用历史爆炸性增长，适合 Telegram/QQ 等对话平台的长任务场景。

3. **分层约定文件（类 GEMINI.md）**：设计 `YOAGENT.md`（全局）+ `.yoagent/context.md`（项目级）分层加载，支持 `@import` 语法引入其他 Markdown，让用户在不同项目/频道中维护各自 agent 行为上下文。

4. **A2A 远程 agent 接入**：yo-agent 若需跨实例协作，可参考 A2A 的 `agent_card` + HTTP+JSON 模式设计通信协议，比自研协议更具互操作性。

5. **OTel 可观测性内置**：从第一天起在 agent loop 关键节点（工具调用前/后、token 消耗、session 开始/结束）埋 OpenTelemetry span，输出到本地 OTLP 端点，方便调试 agent 行为和优化成本。

6. **上下文压缩阈值自动触发**：context window 使用率达阈值（如 70%）时自动调用压缩模型生成 summary 替换历史，压缩 prompt 与 system prompt 分开维护以便独立调优，防止对话中途超限崩溃。

---

## 参考来源

- [google-gemini/gemini-cli GitHub 仓库](https://github.com/google-gemini/gemini-cli)
- [Gemini CLI 官方文档（geminicli.com）](https://geminicli.com/)
- [Gemini CLI 配置参考](https://geminicli.com/docs/reference/configuration/)
- [Plan Mode 文档](https://geminicli.com/docs/cli/plan-mode/)
- [Subagents 文档](https://geminicli.com/docs/core/subagents/)
- [Remote Subagents / A2A 文档](https://geminicli.com/docs/core/remote-agents/)
- [MCP Server 集成文档](https://geminicli.com/docs/tools/mcp-server/)
- [配额与定价文档](https://geminicli.com/docs/resources/quota-and-pricing/)
- [OTel 可观测性文档](https://google-gemini.github.io/gemini-cli/docs/cli/telemetry.html)
- [Antigravity 迁移公告（Google Developers Blog）](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- [Antigravity 迁移讨论（GitHub Discussion #27274）](https://github.com/google-gemini/gemini-cli/discussions/27274)
- [GitHub Issue #23385：OpenAI-compatible endpoint 支持](https://github.com/google-gemini/gemini-cli/issues/23385)
- [write_todos 工具 Issue #15246](https://github.com/google-gemini/gemini-cli/issues/15246)
