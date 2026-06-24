# Cline 与 Roo Code

> 一句话：自主编程 agent——Cline（cline/cline）是原版 VS Code 扩展，现已进化为多宿主 SDK；Roo Code（RooCodeInc/Roo-Code）是 2024 年末从 Cline 分叉、2026-05-15 已归档的竞品 · 作者/维护方：Cline Inc（Cline）/ RooCode Inc（Roo Code，已停止）· TypeScript · Apache-2.0 · https://github.com/cline/cline | https://github.com/RooCodeInc/Roo-Code（已归档）

---

## 1. 是什么 / 定位

**Cline** 起源于 2024 年的 VS Code 扩展「Claude Dev」，以「人在回路（human-in-the-loop）的自主编程 agent」为核心卖点。截止 2026 年 6 月已扩展为：VS Code 扩展、JetBrains 插件、CLI 工具（`@cline/cli` npm 包）、Node.js SDK（`@cline/sdk`），以及基于 WebSocket Hub 的 Kanban 多 agent 协作面板，总安装量超 500 万次，GitHub star 约 63.8k（2026-06 实测）。

2026 年 5 月 13 日，Cline 正式发布 SDK（`@cline/sdk`），将内核重构为分层 TypeScript 包，供外部开发者编程式接入。

**Roo Code**（原名 Roo Cline）是 Cline 的社区私有分支，2024 年末公开，以「更低 token 消耗、可定制 mode、更强自动化」为卖点，高峰期 300 万下载、约 24.2k GitHub star。Roo 团队后认为「IDE 不是编程的未来」，2026 年 4 月 21 日宣布转型，5 月 15 日正式将 VS Code 扩展、Cloud 服务和 Router 全部关闭，GitHub 仓库存档，转型为 Slack-first 的云 agent「Roomote」（roomote.dev）。Roo 的大量设计（diff 编辑、mode 系统、Boomerang 多 agent）已被 Cline 及社区分支（Kilo Code、Zoo Code）继承，Roo 官方也推荐用户迁移到 Cline。

两者均为 BYOK、完全开源（Apache-2.0），不锁定到任何模型厂商。

---

## 2. 架构总览（agent loop / 运行时主循环）

### Cline：五层 SDK + ReAct 单循环

Cline SDK 采用严格分层设计（2026-05 SDK 发布后的正式结构，通过 ARCHITECTURE.md 核实）：

```
@cline/shared → @cline/llms → @cline/agents → @cline/core → Host Apps
                                                        ↑
                                                  @cline/sdk（公开 API 门面）
```

| 包 | 职责 |
|---|---|
| `@cline/shared` | 共享类型、hook 契约、prompt 工具函数、存储路径辅助 |
| `@cline/llms` | provider 设置、模型目录、AI SDK 驱动的 handler |
| `@cline/agents` | **无状态运行时循环**（浏览器兼容），tool orchestration，事件发射，hook 执行 |
| `@cline/core` | **有状态编排**：session 生命周期、持久化、Hub WebSocket、插件加载、cron 自动化 |
| `@cline/sdk` | 对外发布的统一 API 入口 |

`@cline/agents` 实现标准 **ReAct**（Reason-Act-Observe）循环：每轮构建 turn → 调 LLM → 解析工具调用 → 执行工具 → 等待审批门 → checkpoint 提交 → 下一轮。包本身无持久存储（stateless），因此可在 serverless 和浏览器环境运行。

**Hub-Backed Runtime**：`@cline/core` 通过 WebSocket hub 守护进程支持多客户端 attach/detach 同一 session，是 Kanban 面板等多 agent 场景的底层传输。

**Plan / Act 双模式**：
- **Plan 模式**：只读，Cline 读文件、搜索代码、提问、制定策略，禁止写文件和执行命令；
- **Act 模式**：读写全开，执行已批准的计划；
- 模式切换必须由用户主动触发，agent 无法自动升级到 Act 模式。

### Roo Code：多 mode 并行 + Boomerang 子 agent

Roo Code 在 Cline 的单循环基础上增加 **mode 系统**：每个 mode 拥有独立系统提示、独立工具白名单（`groups` 字段）、独立绑定模型（Sticky Model per mode）。5 个内置 mode：Code、Debug、Ask、Architect、Orchestrator。

**Boomerang / Orchestrator 模式**（Roo 最具特色的设计，已通过官方文档核实）：
- Orchestrator mode 禁用文件 I/O、MCP 调用和命令执行，只能委派；
- `new_task` 工具将任务委派给子 agent（指定 mode 和指令）；
- 子 agent 在完全隔离的对话上下文中运行，不继承父 agent 历史（防止「context poisoning」）；
- 子 agent 通过 `attempt_completion` 仅返回精简摘要给父 agent；
- 每个 mode 记忆上次绑定的模型，实现「不同任务自动切换不同模型」。

---

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

### 工具调用格式（重要修正）

Cline **v3.35**（2025-10-31）从 XML 文本嵌入格式迁移至**原生工具调用（Native Tool Calling）**：工具定义以 JSON schema 直接发送给支持原生 function calling 的 API，模型返回原生 JSON 工具调用，而非在文本响应中嵌入 XML 标签。收益：API 错误率降低、支持并行工具执行、每次请求减少约 15% token（工具定义移出系统提示）。

**兼容路径**：对不支持原生工具调用的模型（含本地 Ollama 弱模型），Cline 仍回退到 XML 文本格式（`<execute_command>...</execute_command>` 等）。因此两条路径并存，provider 能力自动选择，而非单一 XML 格式。

### Cline 内置工具（SDK 默认组装）

| 工具 | 描述 |
|------|------|
| `bash` | 执行 shell 命令 |
| `editor` | 查看和编辑文件 |
| `read_files` | 批量读取多个文件 |
| `apply_patch` | 应用 unified diff（精准修改） |
| `search` | ripgrep 驱动的代码库搜索 |
| `fetch_web` | HTTP 请求 + HTML→Markdown 转换 |
| `ask_question` | 向用户提问 |
| `submit_and_exit` | 宣告任务完成（原 `attempt_completion`） |
| `new_task` | 结束当前 session 并启动新 session（上下文接力） |
| `start_subagent` | 在当前 session 内派生子 agent |

### Roo Code 差异工具

- **`apply_diff`**：只输出变更行（fuzzy matching + Levenshtein 距离），不重写全文件，对大文件少量修改可节省约 30% API token。
- 每个 mode 通过 `groups` 字段约束工具白名单，支持正则限制可编辑文件范围。

### MCP 支持

两者均为 **MCP host/client**，支持通过 stdio/SSE 连接任意 MCP server。Cline 有官方 MCP Marketplace，内置 MCP 发现、安装、配置 UI；Roo Code 同样支持 MCP，`groups` 里用 `"mcp"` 项控制某 mode 是否能访问 MCP tools。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

### 上下文窗口管理

Cline 实时监控 token 用量，策略分三级：
1. **去重**：将重复的文件读取替换为紧凑占位符（`[file already shown]`）；
2. **自适应截断**：context 压力高时从会话中部移除旧消息（保留首尾），截断量 25%-75% 可配置，始终保留系统提示和用户指令；
3. **关键内容保护**：系统提示、用户指令、错误信息永不截断。

公式：`maxAllowedSize = Math.max(contextWindow - 40_000, contextWindow * 0.8)`，留出 LLM 生成空间。

### 跨 session 记忆（Memory Bank 方法论）

Cline 无内置持久记忆引擎，而是通过约定文件夹 `memory-bank/` 内的 Markdown 文件实现「外部大脑」：
- 常见文件：`projectbrief.md`、`productContext.md`、`activeContext.md`、`systemPatterns.md`、`techContext.md`、`progress.md`
- `.clinerules` 定义触发规则（如「context > 50% 时」），触发 `new_task` 工具将结构化摘要注入下一 session。

这是「约定即记忆」的无状态设计，无 embedding/向量库依赖。

### Checkpoint（工作区快照）

Cline 在每次工具调用（文件改写/命令执行）后自动提交到 **shadow Git 仓库**（与项目主 Git 完全隔离，包括未追踪文件），用户可通过 UI 选择三种恢复模式（已通过官方文档核实）：
- **Restore Files**：还原文件，保留对话；
- **Restore Task Only**：删除对话，保留文件；
- **Restore Files & Task**：完全回滚。

---

## 5. Prompt / 系统提示策略（约定文件、模式）

### .clinerules

项目根目录的 `.clinerules` 文件是 Cline 的「项目级规则注入点」，相当于 Claude Code 的 `CLAUDE.md`：
- 定义编码规范、架构约定、代码风格；
- 定义 context 接力触发条件；
- 定义工具调用的附加权限覆盖；
- 支持 `.clinerules-{mode-slug}` 为不同 mode 设独立规则（Roo Code 兼容）。

### Roo Code：.roomodes + .roo/rules-{mode}/

Roo Code 在 `.clinerules` 基础上增加：
- `.roomodes`（YAML/JSON）：在项目根定义项目专属 mode，覆盖全局 mode；
- `.roo/rules-{mode-slug}/`：每个 mode 的专属指令目录。

### 系统提示双模式结构

Plan 模式系统提示侧重「分析 → 提问 → 制定步骤，不执行任何破坏性操作」；Act 模式提示侧重「执行已批准计划 → 具体文件变更 → 运行命令」。两套提示通过模式切换动态替换，而非条件判断分支。

---

## 6. 权限与审批（工具执行如何获批、沙箱）

### 分级审批（Cline）

8 类权限可独立开关（Auto Approve 菜单，已通过文档核实）：
1. 读取项目文件；2. 读取所有文件（系统级）；3. 编辑项目文件；4. 编辑所有文件；5. 执行安全命令；6. 执行所有命令；7. 使用浏览器；8. 使用 MCP servers。

命令安全性由 LLM 动态标注 `requires_approval` flag，而非静态白名单。

**YOLO 模式**：关闭所有安全检查，适合 CI/CD 流水线或受信任的重复性任务。

### 沙箱

Cline/Roo 均**无内置 OS 级沙箱**（无 seccomp/landlock/Docker），terminal 命令直接在用户 shell 执行。安全保障依靠审批 UI + checkpoint 回滚，而非隔离执行。

### Roo Code：mode 级工具白名单

每个 mode 通过 `groups` 字段限制可用工具，Architect mode 不含 `edit` 组，天然防止意外写文件——Roo 的「声明式沙箱」，不依赖 OS，依靠 prompt + tool allowlist 约束。

---

## 7. 多平台 / 传输 / 接入层

### Cline 当前接入面

| 接入方式 | 说明 |
|---------|------|
| VS Code 扩展 | 原始主战场，Webview UI |
| JetBrains 插件 | 同一 SDK，不同宿主 |
| CLI（`@cline/cli`） | npm 包，可用于 CI/CD 和自动化 |
| Node.js SDK（`@cline/sdk`） | 编程式 API，可嵌入任意 Node 应用 |
| Kanban 面板 | Web UI，WebSocket hub，多 agent 协调 |
| ACP 协议 | CLI 层集成 ACP（Agent Communication Protocol），用于与其他 agent 平台互联 |

**协议**：WebSocket Hub 协议跨进程通信；MCP 通过 stdio/SSE 接入外部工具；ACP 集成位于 `apps/cli/src/acp/`。

### Roo Code（归档前）

仅限 VS Code 扩展（含实验性云 agent，已随 2026-05-15 停止运营一并下线）。不支持 JetBrains 或独立 CLI。

---

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

### Cline SDK 插件系统

插件从本地路径加载（`.ts`/`.js` 或含 manifest 的包目录），能做：
- 注册自定义工具；
- 监听 lifecycle 事件（PreToolUse / PostToolUse / TaskStart / TaskComplete / SessionShutdown）；
- 注入额外规则和命令；
- 塑造 agent 看到的上下文（context shaping）。

`sdk/examples/hooks/` 目录提供 Shell/Python/TypeScript 三种语言的 hook 示例。

### 多 agent 两种模型（Cline SDK）

- **Subagent（父子模型）**：在同一 session 内，父 agent 通过 `start_subagent` 派生子 agent，子 agent 有独立的 model/tools/prompt，完成后结果返回父 agent。适合单次会话内并行任务。
- **Teams（对等协作模型）**：跨 session 持久协作，状态存于 `~/.cline/data/teams/[team-name]/`，包含任务分配、消息、协作日志。适合多 session 长期项目。

### Roo Code 的 Boomerang 多 agent

单 session 内的「暂停-委派-恢复」模式，通过 `new_task` 工具实现父子 mode 切换，子 agent 上下文完全隔离（已通过 Roo Code 官方文档核实）。已被 Kilo Code 等社区分支继承。

---

## 9. Provider 抽象（是否 BYOK 多模型）

### Cline

`@cline/llms` 包隔离所有 provider 逻辑，支持 30+ providers：Anthropic、OpenAI、Google Gemini、AWS Bedrock、Azure OpenAI、Vertex AI、OpenRouter、DeepSeek、Mistral、Cerebras、Ollama、LM Studio、LiteLLM 以及任意 OpenAI-compatible 端点。

自定义 provider：实现 `ApiHandler` 接口后通过 `llms.registerHandler()` 注入，无需修改核心代码。完全 BYOK——Cline 平台本身不收 token 费用，用户直连模型 API。

### Roo Code

同样 BYOK，支持 10+ providers，且每个 mode 可绑定不同模型（Sticky Model per mode），实现「Architect 用强模型规划、Code 用快模型实现」。

---

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **Shadow Git Checkpoint**：每次工具调用后独立 shadow repo commit，三种恢复模式（文件/对话/完全回滚），彻底解决「LLM 把代码改坏了怎么办」的焦虑，是生产可用的关键基础设施。
2. **双轨工具调用（Native JSON + XML 回退）**：v3.35 后优先原生 JSON 工具调用（降低 15% token、支持并行调用），同时保留 XML 文本格式回退，兼容无原生 function calling 支持的本地模型（Ollama 等）。
3. **new_task 上下文接力**：通过 `.clinerules` 定义触发条件 + LLM 生成结构化摘要注入新 session，实现「无向量数据库的跨 session 记忆」。
4. **SDK 分层架构**：`@cline/agents`（无状态循环，浏览器兼容）与 `@cline/core`（有状态编排）严格解耦，宿主只需实现 `RuntimeHost` 接口即可在 VS Code、JetBrains、CLI、serverless 等任意平台复用 agent 内核。
5. **Hook 系统**：PreToolUse/PostToolUse hooks 支持注入上下文、阻断危险操作，提供比 YOLO/手动审批更精细的中间层控制，无需修改核心循环。
6. **Roo 的 mode-per-model（Sticky Model）**：不同任务阶段自动切换不同 LLM（规划用强模型、编写用快模型），是精细控制 API 成本的实用设计。

### 短板 / 坑

1. **无 OS 级沙箱**：terminal 命令直接在用户环境执行，YOLO 模式下风险极高；安全只靠 UI 审批和 checkpoint 回滚，而非进程隔离。
2. **Roo Code 已停止维护**：2026 年 5 月完全归档，活跃开发转移到社区分支（Kilo Code、Zoo Code），官方推荐迁移到 Cline；Roomote 为新产品，与 Roo Code 代码库无关。
3. **大型仓库 Checkpoint 性能问题**：shadow repo 对大型 monorepo 会产生显著存储和提交延迟，需手动关闭。
4. **无原生向量记忆**：Memory Bank 依赖 Markdown 文件 + 人工/LLM 维护，不是真正的语义检索，长项目上下文积累后质量下降。
5. **VS Code 扩展 API 绑定**：部分核心功能（实时诊断、编辑器状态感知）深度依赖 VS Code API，迁移到其他宿主需要额外适配层。

---

## 11. 对 yo-agent 的具体启示

1. **工具调用走双轨（Native JSON 优先 + XML 回退）**：yo-agent 要同时支持 Anthropic/OpenAI 原生 function calling 和本地 Ollama 弱模型，建议参考 Cline v3.35 的分路策略——按 provider 能力自动选择解析器，而非强绑单一格式。

2. **实现 Shadow Checkpoint 机制**：yo-agent 虽面向聊天平台（QQ/Telegram），同样会执行文件修改和系统命令。建议在「执行层」之上封装 checkpoint 抽象（shadow git repo 或文件快照目录），每次工具调用后持久化，提供 `rollback(checkpoint_id)` API，是「可信自主执行」的核心保障。

3. **Mode 系统（工具白名单 + 独立 system prompt + 绑定 model）**：参考 Roo 的 `.roomodes` 设计，在 yo-agent 中实现「profile」——每个 profile 有独立 system prompt 片段、独立工具白名单和绑定 model。切换 profile 即切换 agent 行为，无需修改核心循环代码。聊天平台 bot 和编程 agent 可以是同一引擎的不同 profile。

4. **new_task 上下文接力替代向量记忆**：yo-agent 面向 QQ/Telegram 长期群聊，当对话 token 超过阈值时，让 LLM 将关键状态写入结构化 JSON 存入数据库，下次对话时读取并注入新 session 的系统提示，无需引入 embedding 服务，参考 Cline 的 `.clinerules` 触发规则写法。

5. **分级审批而非二元 YOLO/审批**：Cline 的 8 类权限（读/写/命令/浏览器/MCP 各自独立控制）思路比「全信任 vs 逐条审批」好得多。yo-agent 可在 bot command 层面暴露权限开关（`/allow_exec`、`/allow_write`、`/allow_mcp`），让群主/admin 精细控制 agent 行为边界。

6. **PreToolUse/PostToolUse hook 作为策略注入点**：参考 Cline SDK 的 hook 系统，在 yo-agent 工具执行前后各提供钩子接口，允许审计日志、危险命令拦截、上下文注入等外部策略无需修改核心循环即可介入，是将通用 agent 引擎扩展为领域特化 agent 的关键设计点。

---

## 参考来源（真实可访问 URL 列表）

- https://github.com/cline/cline
- https://github.com/RooCodeInc/Roo-Code
- https://docs.cline.bot/core-workflows/plan-and-act
- https://docs.cline.bot/features/checkpoints
- https://docs.cline.bot/features/auto-approve
- https://docs.cline.bot/features/memory-bank
- https://docs.cline.bot/tools-reference/all-cline-tools
- https://docs.cline.bot/sdk/overview
- https://cline.bot/blog/introducing-cline-sdk-the-upgraded-agent-runtime
- https://cline.bot/blog/cline-v3-35
- https://cline.bot/blog/unlocking-persistent-memory-how-clines-new_task-tool-eliminates-context-window-limitations
- https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks
- https://roocodeinc.github.io/Roo-Code/features/custom-modes
- https://nerova.ai/news/roo-code-shutting-down-may-15-2026-what-users-should-do-next
- https://thenewstack.io/roo-code-cloud-ides-ai-coding/
- https://www.marktechpost.com/2026/05/14/cline-releases-cline-sdk-an-open-source-agent-runtime-now-powering-its-cli-and-ide-extensions-being-migrated/
- https://kilo.ai/compare/roo-code-shutdown-roomote
- https://deepwiki.com/cline/cline/4.6-system-prompts-and-tool-definitions
