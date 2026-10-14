# Aider

> 一句话：终端内的 AI 结对编程工具，以 repo map + PageRank 做上下文选取、多 edit format + git 自动提交为核心设计，支持 100+ 语言和几乎所有主流 LLM；作者 Paul Gauthier，Apache-2.0 许可，Python 实现。
> 仓库：https://github.com/Aider-AI/aider

---

## 1. 是什么 / 定位

Aider 是一个在终端运行的 **AI 结对编程工具（pair programmer）**，而非常驻式自主 agent。它的核心假设是：开发者仍掌控决策，AI 只负责把用自然语言表达的意图转换为具体文件 diff 并提交 git。

**版本与活跃度**：最新 PyPI 版本为 **v0.86.2**（2026-02-12 补丁），最新正式 GitHub release 为 **v0.86.0**（2025-08-09），新增 GPT-5 全系列、Grok-4、Gemini 2.5 Flash Lite 支持。仓库 46,000+ stars，Aider 贡献了自身 v0.86.0 代码量的 88%（自举开发），持续活跃。

配套的 **Aider Polyglot Benchmark**（225 道 Exercism 题，覆盖 C++、Go、Java、JavaScript、Python、Rust 六种语言）已成为业界衡量 LLM 代码编辑能力的重要参照基准；截至 2026 年中，GPT-5（high）以 88% 排名第一。

---

## 2. 架构总览（agent loop / 运行时主循环）

Aider 采用**回合制（turn-by-turn）交互循环**，而非常驻自主 agent loop。每一轮的流程如下：

```
用户输入（自然语言 / /command）
  → 上下文组装（repo map + 已 /add 的文件 + chat history）
  → LLM 调用（主模型）
  → 解析响应中的 edit block
  → 写入磁盘 → git commit（auto-commits 默认开启）
  → 显示 diff / 等待下一轮用户输入
```

**关键设计选择：**

- **不是事件驱动的 ReAct 循环**：没有 Observation/Action 循环，不会自主连续行动到完成任务。每轮完成后必须等待用户确认或新输入。
- **Architect + Editor 双模型模式**（`/architect` 或 `--architect`）：用一个强推理模型（如 o3/Claude Sonnet）拟定修改方案，再用一个便宜的编辑专用模型将方案转换为精确的文件 diff。两次 LLM 调用串行执行，属于单轮内的流水线分工，不是多 agent 委派。
- **四种运行模式**：
  - `code`（默认）：直接编辑文件
  - `ask`：只问答，不改文件
  - `architect`：双模型规划 + 执行
  - `help`：回答关于 aider 工具本身的问题
- **Watch 模式**（`--watch-files`）：监听文件系统，识别代码注释里的 `AI!` / `AI?` 标记自动触发。这是唯一接近事件驱动的使用形态，但本质上仍是单次触发 → 单次响应。

---

## 3. 工具系统（内置工具集 + 函数调用机制 + MCP 支持）

### 内置工具/命令

Aider 没有独立的"工具调用框架"，而是通过 `/commands` 提供功能入口，LLM 生成的是文本 edit block，由 Python 侧解析执行：

| 类别 | 命令 | 说明 |
|------|------|------|
| 文件管理 | `/add` `/drop` `/read-only` `/ls` | 控制上下文文件集 |
| 执行 | `/run` / `!` | 运行 shell 命令，输出可注入对话 |
| 测试 | `/test` | 运行测试命令，非零退出码时把输出加入 chat |
| Lint | `/lint` | 自动 lint 并将报错反馈给 LLM |
| Git | `/diff` `/undo` `/commit` `/git` | 版本控制操作 |
| 网络 | `/web` | 抓取网页转 markdown 注入上下文 |
| 语音 | `/voice` | Whisper 语音转写 |
| Map | `/map` | 打印当前 repo map |

### 函数调用机制

Aider **刻意避免使用 LLM 的 Function Calling API**。Polyglot benchmark 显示 plain text edit format（整文件或 diff block 文本）比结构化 JSON 调用准确率更高，原因是额外的格式约束会分散模型的编码注意力。LLM 响应直接是带标记的文本块，由 Python 侧正则/解析器提取。

### MCP 支持

经核查（GitHub 源码目录无 mcp.py，官方文档无 MCP 页面，HISTORY.md 无记录）：**Aider 截至 v0.86.2 不支持 MCP，既非 MCP host，也非 MCP client。** 网络上存在若干关于"Aider MCP client support"的第三方文章，内容不实或系 AI 生成，不可信。

社区有第三方 **aider-mcp-server**（非官方，如 disler/aider-mcp-server），允许把 aider 作为 MCP server 暴露给 Claude Code 等 MCP 客户端调用，实现将文件编辑任务委托给 aider 执行。AiderDesk（第三方 GUI）通过 MCP server 实现了 agent 模式，但这不是 aider 核心的能力。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

### Repo Map（核心上下文构建机制）

这是 aider 最有辨识度的设计。工作原理：

1. **tree-sitter 解析**：对仓库所有源文件提取 `name.definition.*` 和 `name.reference.*` 标签（函数/类定义 + 符号引用），结果按文件修改时间缓存到 SQLite 磁盘缓存。
2. **符号依赖图构建**：以源文件为节点，文件间符号引用为有向边，构建依赖图。
3. **Personalized PageRank**：以当前对话中提到的符号/文件为种子，对图做 PageRank 打分，选出最相关的文件和符号定义。
4. **Token 预算裁剪**：默认 `--map-tokens 1000`，动态调整（对话中无文件时自动放大），将高分符号的签名/定义截断到预算内。

结果：LLM 得到一份"骨架视图"——足够理解全局依赖和 API，而不需要加载所有文件。

### 聊天历史压缩

- 配置参数 `--max-chat-history-tokens`：小上下文模型默认约 1024，大上下文模型约 2048。
- 到达软限制后，`ChatSummary` 类用**递归分块策略**：将历史分段，旧消息递归压缩，新消息保留原文。
- **weak model 参与**：`--weak-model` 选项指定专门用于提交消息生成和历史摘要的小模型（如 GPT-4o-mini），将摘要成本与主任务成本分离。

### 长期记忆与会话恢复

- **无向量数据库 / 无持久 memory**：aider 本身不做长期记忆。
- **`--restore-chat-history`**：从 `.aider.chat.history.md` 文件恢复上一次会话的 chat history，恢复时会自动检查并压缩过大的历史。
- **CONVENTIONS.md / `--read`**：通过把约定文件标记为 read-only 注入，变相实现"持久指令"的效果，并支持 prompt caching 节省 token 费用。
- **`/save` / `/load`**：保存/恢复会话文件集和命令序列（不含对话内容）。

### Infinite Output

对输出 token 有限制的模型，aider 支持 prefill 续写机制：当模型输出被截断，自动以已生成内容为前缀发起下一次请求，多次拼接直至 edit block 完整。

---

## 5. Prompt / 系统提示策略（约定文件、模式）

### 约定文件（CONVENTIONS.md 等效物）

aider 不内置识别 `AGENTS.md` 或 `CLAUDE.md`，但提供等效机制：

- 通过 `--read CONVENTIONS.md` 或 `.aider.conf.yml` 的 `read:` 字段，将任意 markdown 文件以 read-only 形式注入上下文。
- 社区维护了 [Aider-AI/conventions](https://github.com/Aider-AI/conventions) 仓库，提供各类开箱即用的编码约定集合。
- 配合 prompt caching（Anthropic/OpenAI 均支持），约定文件内容可以被缓存，不重复计费。

### 系统提示设计

- 每种 edit format（whole / diff / diff-fenced / udiff / architect）有**独立的系统提示模板**，核心差异在于如何描述期望的输出格式。
- 强调 LLM 遵循格式的重要性（这直接影响 parse 成功率）。
- architect 模式下主模型收到"规划指令"，editor 模型收到"精确执行指令"，两个系统提示职责分离。

### 无 plan/act 显式阶段

aider 没有强制的 plan 阶段——`ask` 模式可以用于事先规划，但切换到 `code` 模式后直接执行。不存在独立的 planning 代理步骤（除 architect 模式外）。

---

## 6. 权限与审批（工具执行获批、沙箱）

### 默认行为

- **文件编辑**：自动执行，不需逐步确认，改完直接写磁盘并 git commit。
- **Shell 命令**（`/run`）：需要用户手动输入执行，LLM 无法自主调用 shell；但 `/test` 和 `/lint` 是配置后自动触发的。
- **`--yes-always`**：所有确认提示自动接受（面向 CI/非交互场景）。

### 没有沙箱

Aider **没有 seatbelt / landlock / Docker 沙箱机制**。文件操作直接在宿主 FS 执行，安全边界依赖 git（每次改动均有提交，可 `/undo`）而非系统级隔离。

### Git 作为审计轨迹

所有 aider 的改动都标记 `(aider)` 提交者元数据，支持 conventional commits 风格消息，便于 code review 和 `git blame` 追踪。

---

## 7. 多平台 / 传输 / 接入层（CLI/IDE/TUI/聊天平台、协议）

### 主接入方式

- **终端 CLI**（主要形态）：交互式 TUI（基于 prompt_toolkit），支持多行输入、历史导航、颜色主题。
- **`--watch-files` IDE 集成**：在任何 IDE 里通过代码注释触发 AI 修改，无需离开编辑器。
- **`/copy-context` 模式**：将对话 export 成可粘贴格式，兼容 ChatGPT/Claude web UI 手动操作流程。

### 协议支持

- **无 ACP / A2A / OneBot / MCP 原生支持**。
- **Python API（非正式支持）**：可通过 `Coder.create()` 编程调用，用于脚本自动化；但不保证向后兼容。
- **`--message` 单次运行模式**：供外部 orchestrator 调用，以 shell 进程方式把 aider 作为子任务执行器。

### 无聊天平台接入

Aider 不接入 Telegram/Discord/QQ 等 IM 平台，设计上是纯开发者工具，无消息平台抽象层。

---

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

- **无插件系统**：没有标准化的插件接口，所有能力内置于核心或靠 `/run` 调用外部工具。
- **Architect + Editor 双模型**是 aider 最接近"多 agent"的机制，但本质是单会话内的两次 LLM 调用，不是独立 agent 进程。
- **无 subagent 委派**：不能在任务执行过程中动态派生子任务给其他 agent 处理。
- **外部集成**：可通过 `--message` 单次运行模式被上层 orchestrator 调用，实现 aider 作为外部子任务执行器的效果（类似 shell 工具调用）。

---

## 9. Provider 抽象（是否 BYOK 多模型）

Aider 是**完全 BYOK（Bring Your Own Key）**，没有自己的 AI 服务后端，所有模型调用由用户提供 API key 发起：

**支持的 Provider（截至 2026 年中）：**

| 类别 | Provider |
|------|---------|
| 商业 API | OpenAI（含 GPT-5 全系列）、Anthropic（含 Claude 4 系列）、Google Gemini 2.5、xAI（Grok-4）、DeepSeek、Cohere、GROQ |
| 云平台 | Azure OpenAI、Amazon Bedrock、Vertex AI |
| 聚合器 | OpenRouter、任何 OpenAI-compatible endpoint |
| 本地 | Ollama、LM Studio |

**推荐模型（2026 Polyglot Benchmark 表现最佳）：** GPT-5（high）88%、o3-pro 84.9%、GPT-5（medium）86.7%；此前 Gemini 2.5 Pro、DeepSeek、Claude Sonnet 4 系列也是热门选择。

**模型配置方式：**
- `.env` 文件（`AIDER_MODEL`、`OPENAI_API_KEY` 等）
- `.aider.conf.yml` YAML 配置
- `--model` / `--editor-model` / `--weak-model` 命令行参数
- `/model` 在线切换（不中断会话）

---

## 10. 亮点设计 / 短板 / 坑

### 亮点设计

1. **Repo Map + PageRank**：业界最优雅的"选择性上下文"方案之一。不需要用户手动 /add 文件，LLM 自动获得理解全局依赖所需的骨架。tree-sitter + SQLite 缓存保证大仓库的性能。

2. **Edit Format 分层设计**：针对不同模型能力提供 whole/diff/udiff/architect 四种格式，并有 Polyglot Benchmark（225 题 6 语言）数据支撑选择。plain text 格式刻意优于 Function Calling API，这是实测得出的反直觉结论。

3. **Git 作为原生安全网**：每次 LLM 改动均自动提交，dirty 文件先保存再 commit，`/undo` 即时回退。这让"无沙箱"的风险降至可接受范围，同时给开发者完整的审计轨迹。

4. **Architect + Editor 双模型**：以价格换质量的精妙权衡——强推理模型做规划（贵但准），弱编辑模型做执行（便宜），总成本低于全程使用强模型。

5. **Weak Model 分工**：commit message 生成、chat history 摘要都交给 cheap model，主模型专注代码任务。这是成本优化的系统性设计，而非临时补丁。

6. **Polyglot Benchmark 公开基准**：225 题覆盖 6 种语言，完整可重现，为选择模型和 edit format 提供了可信依据，也成为整个社区的参照标准。

### 短板 / 坑

1. **无真正的 agent loop**：aider 不能自主连续迭代到目标完成，每轮都需要人工触发下一步。对于"跑测试 → 看报错 → 修复"这类多轮自动化需求，需用户自行编写脚本或依赖第三方 orchestrator。
2. **无 MCP 支持（官方层面）**：不能作为 MCP host 连接外部工具服务，也不能作为 MCP client 被标准化调用。GitHub 源码中无 mcp.py，官方文档无 MCP 页面，且部分网络文章关于"Aider MCP client"的描述不实。
3. **无沙箱**：文件系统操作无系统级隔离，对不熟悉 git 的用户有数据风险。
4. **无持久记忆**：跨会话的项目知识必须靠人工维护 CONVENTIONS.md，没有 RAG / 向量存储。
5. **上下文管理粗糙**：`/clear` 是主要的上下文重置手段，`--max-chat-history-tokens` 的阈值较低（默认 1024-2048 tokens），长会话容易丢失重要中间上下文。
6. **Python API 非正式支持**：无法依赖程序化调用做稳定集成。

---

## 11. 对 yo-agent 的具体启示

1. **Repo Map 架构可直接移植**：yo-agent 做编程任务时，可用 tree-sitter（Node.js binding）+ 文件依赖图 + PageRank 实现同款上下文选取。token budget 参数化、SQLite 按文件 mtime 缓存这两个工程细节尤为重要——前者控制成本，后者避免重复解析大仓库。

2. **Edit Format 作为可配置维度**：不要假设一种输出格式对所有模型都最优。yo-agent 应把 edit format（whole / search-replace / unified diff）抽象为 coder strategy，允许按模型/任务动态切换，并建立与 aider 类似的成功率 benchmark 体系。

3. **Weak Model 分工原则**：把摘要、commit message、路由决策等"轻推理"任务分配给小模型，主任务使用强模型。yo-agent 的 token 成本控制应在架构层设计 model tier，而非单点优化。

4. **Git 作为操作安全网，而非沙箱替代**：yo-agent 若要支持文件编辑，可将 git auto-commit 作为第一道防线（成本极低），沙箱（如 landlock / Docker）作为第二道，两者不互斥。aider 只有第一道，这是其主要安全短板。

5. **`/run` + 自动 lint/test 反馈循环**：aider 把"运行结果注入下一轮上下文"的模式（`/test` 非零退出 → 自动追加报错）是实现半自主迭代的最小可行设计。yo-agent 可借鉴这一模式，将工具调用输出自动加入下一轮 prompt，无需人工复制粘贴。

6. **约定文件 + Prompt Caching 降本**：yo-agent 的 AGENTS.md 类文件若能配合 Anthropic/OpenAI 的 prompt caching，可大幅降低系统提示的重复计费。约定文件应设计为"长期不变的内容"（适合缓存）vs "任务相关的动态内容"（不缓存）两层分离。

---

## 参考来源（真实可访问 URL）

- [Aider GitHub 仓库](https://github.com/Aider-AI/aider)
- [Aider 官网](https://aider.chat)
- [Repository Map 文档](https://aider.chat/docs/repomap.html)
- [Building a better repository map with tree-sitter](https://aider.chat/2023/10/22/repomap.html)
- [Chat Modes 文档](https://aider.chat/docs/usage/modes.html)
- [In-Chat Commands 参考](https://aider.chat/docs/usage/commands.html)
- [LLM Providers 文档](https://aider.chat/docs/llms.html)
- [Options Reference](https://aider.chat/docs/config/options.html)
- [Git Integration 文档](https://aider.chat/docs/git.html)
- [Scripting 文档](https://aider.chat/docs/scripting.html)
- [Conventions 文档](https://aider.chat/docs/usage/conventions.html)
- [Watch Mode 文档](https://aider.chat/docs/usage/watch.html)
- [Aider LLM Leaderboards](https://aider.chat/docs/leaderboards/)
- [Polyglot Benchmark 发布](https://aider.chat/2024/12/21/polyglot.html)
- [HISTORY / Release Notes](https://aider.chat/HISTORY.html)
- [Aider v0.86.0 GitHub Release](https://github.com/Aider-AI/aider/releases/tag/v0.86.0)
- [PyPI aider-chat](https://pypi.org/project/aider-chat/)
- [MCP SUPPORT Issue #3314](https://github.com/Aider-AI/aider/issues/3314)
- [Aider MCP Server (community, non-official)](https://mcpservers.org/servers/disler/aider-mcp-server)
- [AiderDesk MCP Agent Mode](https://www.hotovo.com/blog/how-mcp-servers-gave-birth-to-aiderdesks-agent-mode)
