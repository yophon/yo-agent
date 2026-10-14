# Agent 架构横向综述（_LANDSCAPE）

> 本文基于 14 份逐个调研 card 横向归纳，服务于 **yo-agent**（TypeScript/Node 单栈通用 agent 引擎：既当编程 agent，又挂接 QQ/Telegram/Discord 等聊天平台，且要能被 yo-aichat 的 Go agent-bridge 当作"自研第四类 agent"用可恢复 JSON-RPC/JSONL 协议驱动）。
> 各项目完整调研见同目录 `<slug>.md`。本文不重复 card 细节，只做横向提炼与对 yo-agent 的结论。

---

## 1. 全景分类

调研对象按定位分四类。注意 **OpenClaw 同时是编程 agent 和聊天 bot**（kind=both），最接近 yo-agent 的目标形态。

### 1.1 分类速览

- **编程 agent（coding-agent）**：Claude Code、Codex CLI、pi、opencode、Gemini CLI、Aider、OpenHands、Cline/Roo、Goose
  —— 内核是"读写代码 + 跑命令 + diff 审批"，终端/IDE 优先，agent loop 是核心资产。
- **聊天 bot 框架（chat-bot / framework）**：AstrBot、LangBot、NoneBot2、Nanobot
  —— 内核是"多平台消息接入 + 事件流水线"，LLM 能力是可插拔的一层。NoneBot2 甚至不面向 LLM（纯消息框架）。
- **通用引擎（both）**：OpenClaw
  —— 一个内核既驱动编程任务又挂 20+ 聊天渠道，正是 yo-agent 要做的事。
- **互操作标准（standard）**：MCP / ACP / A2A / AGENTS.md
  —— 不是产品，是协议层。决定 yo-agent 对外暴露什么接口、复用什么生态。

### 1.2 对比表

| 名称 | 语言 | License | agent loop 范式 | 工具模型 | MCP | 平台与接入 | 审批/沙箱 | 持久化与恢复 |
|---|---|---|---|---|---|---|---|---|
| **Claude Code** | TS/Node | 闭源商业 | 事件驱动单循环 ReAct + 30 种 hook 事件 + plan/batch/background | Anthropic 原生 tool use，38 内置工具，ToolSearch 懒加载 | Host/Client 全功能（stdio/HTTP/WS） | CLI/IDE/Desktop/Web/移动；MCP Channels 桥 IM | 6 档权限 + auto 分类器模型 + seatbelt/landlock | CLAUDE.md + auto memory；/resume、/fork |
| **Codex CLI** | Rust | Apache-2.0 | ReAct，Responses API SSE 驱动，无状态请求 | 内建 shell/apply_patch + MCP，JSON schema | 双向（client + server） | CLI/TUI/headless/IDE/移动；**app-server JSON-RPC 2.0** | 4 级审批 + OS 原生沙箱（seatbelt/bwrap/Win） | ~/.codex 本地；thread/resume/fork；app-server |
| **pi** | TS/Node | MIT | 经典单循环 ReAct，消息队列 steer/follow-up | 4 默认 + 3 可选工具，**主动拒绝 MCP** | 不支持（设计立场） | CLI/TUI/**RPC(JSONL)**/SDK；无原生 IM | 项目级信任一次性决策，无沙箱 | **JSONL DAG**（id/parentId）分支；-c/-r/--fork |
| **opencode** | TS/Bun | MIT | 流式单循环，doom-loop 检测，overflow 自动压缩 | 16+ 内置工具，Permission.ask 三态 | Client（stdio/SSE/HTTP，OAuth） | CLI/TUI/Desktop/IDE；**ACP 完整 13 API** | 分层 glob ruleset，**无 OS 沙箱** | SQLite；fork/resume/listSession |
| **Gemini CLI** | TS | Apache-2.0 | ReAct 单循环，双轨历史串行化 | BaseDeclarativeTool，大量内置工具 | Host（stdio/SSE/HTTP，OAuth） | CLI/TUI/headless/GitHub Action；**A2A** | 4 级审批 + seatbelt/Docker；plan/act 权限隔离 | GEMINI.md 分层 + checkpointing/restore |
| **Aider** | Python | Apache-2.0 | 回合制交互（非常驻 loop） | **不用 function calling**，文本 edit block | 不支持（官方核实） | 终端 CLI/watch-files；无 IM/无协议 | 文件改动自动执行，**git auto-commit 当安全网** | .aider.chat.history.md 恢复；无长期记忆 |
| **OpenHands** | Python | MIT | **事件溯源 ReAct**，状态机 + EventLog | Action/Executor/Observation 三分，并行执行 | Client/Host（stdio/SSE/HTTP proxy） | CLI/Canvas/Cloud/K8s/GitHub Resolver；**ACP** | SecurityAnalyzer + ConfirmationPolicy 解耦；3 档 Workspace | **EventLog append-only 确定性重放**；schema 迁移 |
| **Cline/Roo** | TS | Apache-2.0 | ReAct，分层 SDK（无状态 loop + 有状态编排） | 双轨（Native JSON 优先 + XML 回退） | Host/Client，有 Marketplace | VS Code/JetBrains/CLI/SDK；ACP；WS Hub | 8 类独立权限，**无 OS 沙箱**，Roo mode groups | **Shadow Git Checkpoint**；Memory Bank（Markdown） |
| **Goose** | Rust | Apache-2.0 | 单循环 ReAct，tokio 异步 | **MCP-native**（核心极薄，工具全外化） | 深度 Host（STDIO/SSE） | CLI/Desktop/JetBrains/**ACP**/Telegram | 3 级 Auto/Approve/Chat + Smart Approve；无沙箱 | SQLite + Memory MCP；.goosehints；Recipes YAML |
| **AstrBot** | Python | AGPL-3.0 | 事件驱动 6 段 Pipeline + ToolLoopAgentRunner | FunctionToolManager 三源统一 | Client（WebUI 配置） | **15+ IM 平台**（OneBot/Telegram/Discord…） | 无运行时审批；Local/Sandbox（Shipyard Neo） | SQLite + FAISS RAG；会话历史恢复 |
| **LangBot** | Python+TS | Apache-2.0 | Function Calling 循环，MAX_TOOL_CALL_ROUNDS=128 | 6 沙箱工具 + MCP + 插件 + Skills | **双向**（Client 4 传输 + Server /mcp） | **17-21 IM 平台**；外接 Dify/n8n Runner | 无人工审批，沙箱（Docker/nsjail/E2B） | SQLite/PG；Round Truncator 硬截断（无压缩） |
| **NoneBot2** | Python | MIT | **事件流驱动**（非 ReAct），协程续体状态机 | 无 LLM 工具集；Bot.call_api + 钩子 | 不支持 | **Driver+Adapter 二层**（OneBot/TG/Discord…） | Permission（谁）/Rule（内容）分离；无沙箱 | 内存 State（重启即失）；靠社区插件 |
| **Nanobot** | Go+Svelte | Apache-2.0 | 单循环 ReAct，无硬迭代上限 | 标准 JSON Schema，Claude Code 式内置工具 | 双向（Client + Server） | Web UI/CLI/**Agent as MCP Server**；规划 IM | Docker 容器沙箱 + 能力维度白名单 | SQLite/MySQL/PG（GORM）；JSON checkpoint |
| **OpenClaw** | TS | MIT | 流式事件驱动 + **多 Lane 并发**，4 模式 loop 熔断 | **ToolDescriptor + ToolExecutorRef 分离**，声明式显隐 | 双向（Client + Server） | CLI/menubar/移动节点；**20+ IM 渠道**；MCP/ACP/Gateway RPC/Tailscale | 工具政策 6 维 + bash 两阶段 gateway + 沙箱（Docker/SSH）；**DM pairing** | **SQLite-only**（禁 JSON sidecar）；compaction checkpoint |
| **MCP/ACP/A2A/AGENTS.md** | 协议 | Apache/MIT | MCP=工具循环原语；ACP=editor prompt-turn；A2A=agent 委派 | MCP 三原语；ACP 9 tool kind；A2A AgentCard Skills | —— | MCP stdio/HTTP；ACP JSON-RPC/WS（WIP）；A2A HTTP+JSON-RPC+SSE | ACP `session/request_permission` 四选项是协议级强制审批 | MCP 有状态→RC 无状态；ACP session load/resume；A2A Task ID |

---

## 2. 架构模式提炼

### 2.1 Agent loop 范式

| 范式 | 代表 | 取舍 |
|---|---|---|
| **经典单循环 ReAct**（infer→tool→observe→loop） | pi、Goose、Gemini CLI、Aider(回合制)、AstrBot/LangBot 内嵌 | 实现最简、好维护；缺点是子任务/plan/并发都要额外机制。pi 把这些全做成扩展（primitives-not-features）。 |
| **事件驱动单循环 + hook 矩阵** | Claude Code（30 事件）、Codex（10 事件）、Cline | 主循环不变，所有横切关注点（审批/审计/记忆/拦截）做成生命周期钩子。最适合"通用引擎"——内核稳定，行为可编程。 |
| **事件溯源（Event-Sourced）** | OpenHands（EventLog append-only） | 所有状态变更是 append-only 事件，天然得到确定性重放 + resume + 调试追溯三件套。对"可恢复流"是降维打击，但需要 schema 版本迁移机制。 |
| **流式 + 多 Lane 并发** | OpenClaw、opencode | 多渠道/多任务并发不互相阻塞，子 agent 结果异步注入。聊天平台多群并发场景必需，但复杂度高。 |
| **事件流（非 ReAct）** | NoneBot2 协程续体 | 纯消息框架，handler 线性书写、pause/got 挂起恢复。这是"聊天侧"的范式，不是"agent 侧"——但其续体模型对多轮人机交互非常优雅。 |

**共识**：所有有自主能力的实现都有 **loop 熔断**（OpenClaw 4 模式 + 30 历史窗 + 30 次硬截断；opencode DOOM_LOOP=3；LangBot 128 轮；Goose MAX_TURNS=1000）。**不依赖 LLM 自我识别死循环，必须在引擎层做。**

### 2.2 工具与 MCP

| 做法 | 代表 | 取舍 |
|---|---|---|
| **声明与执行分离** | OpenClaw（ToolDescriptor+ExecutorRef，availability 表达式）、OpenHands（spec 可序列化跨进程） | 工具是否进入上下文完全声明化（按 auth/config/env/context 条件），主循环无 if-else 膨胀。对"既编程又聊天、工具集动态切换"最关键。 |
| **多源统一注册表** | AstrBot（FunctionToolManager 三源）、LangBot（4 类 Loader）、Goose（Extension Manager） | 插件工具/MCP 工具/内置工具走同一接口，agent loop 对接入方式透明。生产验证过的范式。 |
| **双轨工具调用** | Cline（Native JSON 优先 + XML 回退）、OpenHands（NonNativeToolCallingMixin）、Goose（Tool Shim） | 强模型用原生 function calling（省 token + 并行），弱/本地模型用 prompt-and-parse。**BYOK 全模型覆盖的必备基础设施。** |
| **不用 function calling** | Aider（plain text edit block，benchmark 证明成功率更高） | 反共识但有数据支撑；提示"编辑格式应是可配置维度"，按模型选最优。 |
| **ToolSearch / Skills 懒加载** | Claude Code（ToolSearch）、所有 Skills 实现 | 大量工具/技能不预置入上下文，按需拉取，避免 token 爆炸。 |

**MCP 立场分化**：
- **双向（Client+Server）**：Codex、OpenClaw、Nanobot、LangBot、OpenHands(client/host) —— 既消费外部工具，又把自身暴露为 MCP Server 供编排。这是"可嵌套 agent 生态"的关键。
- **仅 Client/Host**：opencode、Gemini CLI、Goose、AstrBot、Cline。
- **主动拒绝**：pi（"No MCP"是设计立场，用 CLI 工具 + README 替代）、Aider（官方无）、NoneBot2（无）。
- **教训**：MCP 动态工具更新会破坏 prompt 缓存前缀（Codex 明确指出 cache miss）；会话级懒加载 + TTL + 失败熔断是生产做法（OpenClaw BUNDLE_MCP_FAILURE_THRESHOLD=3 / 60s 冷却）。

### 2.3 上下文压缩 / 记忆

| 维度 | 业界做法 |
|---|---|
| **触发阈值** | 70%（Gemini）/ 80%（Goose、Nanobot 83.5%）/ 95%（Claude Code）/ usable()（opencode）。多数在 80% 左右。 |
| **压缩策略** | 保首 keep_first + 保尾 N + 中段 LLM 摘要（OpenHands Condenser、opencode、OpenClaw 分块）。**比纯截断安全得多。** LangBot/NoneBot 只做硬截断（弱点）。 |
| **关键防护** | **强制保留不透明标识符**（OpenClaw IDENTIFIER_PRESERVATION：UUID/hash/URL 不许改写）——否则 agent 压缩后因标识符失真无法续接。这是踩过坑的经验。 |
| **结构化摘要** | Nanobot Handoff 文档（Goal/What Happened/Current State/Next Steps）、Cline new_task 结构化注入。比自由文本摘要可靠。 |
| **独立压缩 agent** | opencode/Claude Code 用专属 prompt 的 compaction agent，可换便宜模型（haiku/mini）降本。 |
| **记忆双轨** | **静态约定文件**（CLAUDE.md/AGENTS.md/GEMINI.md/.goosehints，人工写、每次注入、token 固定）+ **动态 auto-memory**（agent 自学习、按需加载、Memory MCP/MEMORY.md）。两者权限不同：人工文件 agent 不可覆盖。 |
| **工具输出截断** | 大输出写磁盘只返路径（Nanobot 50KiB、opencode 2000 字符）。 |

### 2.4 权限审批 UX

| 范式 | 代表 | 特点 |
|---|---|---|
| **多档模式** | Claude Code（6 档）、Codex（4 级）、Gemini（4 级）、Goose（3 级 Auto/Approve/Chat） | 至少 read-only / supervised / autonomous 三档是共识下限。 |
| **策略与沙箱正交** | Codex（审批策略 × 沙箱模式独立配置）、OpenHands（SecurityAnalyzer 风险打分 + ConfirmationPolicy 解耦） | 同一内核换 policy 即适配聊天 bot（宽松）和编程 agent（严格）。**对通用引擎最重要。** |
| **分层 glob 规则** | opencode（defaults→agent→user，findLast）、Cline（8 类独立权限） | 精确到 `read:{"*.env":"ask"}`，比布尔开关灵活。 |
| **hook 硬约束 vs prompt 软约束** | Claude Code 核心设计 | CLAUDE.md 是软指导（user 消息），hooks 是代码强制（不经模型判断）。**避免越狱的关键分层。** auto mode 用独立分类器模型且看不到工具结果（防注入）。 |
| **协议级审批** | ACP `session/request_permission` 四选项（allow_once/always、reject_once/always） | 把授权决策建模为协议消息而非 UI 事件，任何前端（CLI/IDE/IM）渲染相同语义。**yo-agent 应直接采用。** |
| **渠道安全基线** | OpenClaw DM pairing（未知发送者需配对码） | 开放渠道防 prompt injection 的最低门槛。 |
| **沙箱实现** | OS 原生（Codex seatbelt/bwrap/Win、Gemini）、容器（Nanobot/LangBot/AstrBot Docker/E2B）、**无沙箱靠 git/checkpoint**（Aider、Cline、opencode、Goose、pi） | 注意：大量 TS 编程 agent **没有 OS 沙箱**，靠 checkpoint 回滚兜底，是已知风险。 |

### 2.5 多平台适配层

| 做法 | 代表 | 取舍 |
|---|---|---|
| **Transport + Adapter 二层解耦** | NoneBot2（Driver 管连接 + Adapter 管协议，新平台只需实现 ~8 方法）、AstrBot（AstrBotMessage 统一格式） | 接入 N 个平台开销最小的架构，已被数十个真实适配器验证。**yo-agent 应一开始就这么设计。** |
| **统一内部消息类型** | AstrBot UnifiedMessage、LangBot UniMessage（跨 22 平台富文本） | 平台细节不渗透 agent 内核。 |
| **协议解耦（agent-as-server）** | Codex app-server、opencode/Goose/OpenHands ACP、Nanobot "Agent as MCP Server" | 渲染层与核心彻底分离，IM adapter 作为协议 client 接入，免去逐平台写适配。 |
| **MCP Channels / 双向推送** | Claude Code MCP Channels（服务端 push 消息进会话） | 让 CLI agent 响应外部事件，是向平台无关演进的方向。 |

**标准协议覆盖度**：QQ/微信靠 **OneBot v11**（AstrBot/LangBot/NoneBot）；IDE/编辑器靠 **ACP**（opencode/Goose/OpenHands/Cline）；跨 agent 靠 **A2A**（Gemini）。没有任何编程 agent 原生支持 QQ/Telegram——**这正是 yo-agent 的空白机会**。

### 2.6 会话恢复 / 可恢复流

| 做法 | 代表 | 取舍 |
|---|---|---|
| **事件溯源重放** | OpenHands EventLog（确定性重放 + schema 迁移） | 恢复能力最强，调试可追溯。yo-agent 应作为内核唯一状态源。 |
| **JSONL DAG（id/parentId）** | pi（树状会话，原地分支不复制） | 聊天平台的 reply_to/引用天然映射 parentId，分支/fork 免额外设计。 |
| **协议化 resume** | Codex（thread/resume/fork）、opencode ACP（loadSession 重放 / resumeSession 无历史重连）、ACP 标准 | 区分"带历史重放"和"无历史重连"两种语义。 |
| **SQLite checkpoint** | OpenClaw（compaction checkpoint 落盘）、opencode、Goose、Nanobot、AstrBot、LangBot | 进程重启续接的生产做法。OpenClaw 甚至强制 SQLite-only、禁 JSON sidecar。 |
| **文件快照 / shadow git** | Cline（每次工具调用提交 shadow repo，3 种恢复）、Gemini（checkpointing/restore）、Aider（auto-commit /undo） | 文件层可撤销性，与会话恢复正交。 |

**RPC 协议范本**（yo-agent 要被 Go bridge 当第四类 agent 驱动，这是核心）：
- **Codex app-server**：JSON-RPC 2.0，**Thread/Turn/Item 三层事件流**，turn/start+steer+interrupt，stdio/WS/Unix socket，WS 满载 -32001 错误码退避。最成熟范本。
- **pi `--mode rpc`**：stdin/stdout JSONL（LF 分隔），prompt/steer/abort/set_model/new_session/fork 命令。最轻量范本。
- **ACP**：session/prompt → session/update 流 → tool_call → request_permission，StopReason 枚举。

### 2.7 子 agent / 多 agent

| 模式 | 代表 | 取舍 |
|---|---|---|
| **上下文隔离子 agent** | Claude Code（Explore/Plan 独立窗口只回摘要）、Gemini、Cline Boomerang、opencode | 探索型任务（读大量文件/搜索）spawn 子 agent，只消费摘要，防主上下文污染。**IM 场景尤其需要（预算更紧）。** |
| **异步 steering queue** | OpenClaw（子 agent 完成放 steering queue 下轮注入）、opencode（XML 标签 synthetic 消息） | fire-and-forget 并发委派，主循环不阻塞。 |
| **sequential + resume** | OpenHands TaskToolSet（子 conversation 持久到磁盘可恢复）、DelegateTool（parallel） | 长任务中断后续跑。 |
| **进程隔离** | Goose（child_process）、OpenClaw（lane）、LangBot/NoneBot 插件独立进程 | 子任务崩溃不拖垮主循环。 |
| **Agent as MCP Server** | Nanobot、Codex | 整个 agent 打包成一个 chat 工具暴露，外部只见一个工具，彻底消除多 agent context 膨胀。 |
| **声明式 mode/recipe** | Roo mode（工具白名单+独立 prompt+绑定 model）、Goose Recipes YAML | agent 行为可版本控制、GitOps 管理。 |

---

## 3. 可借鉴 / 要避开

### 3.1 可借鉴

1. **Codex app-server 三层事件流（Thread/Turn/Item）+ JSON-RPC 2.0** 作为 yo-agent 对外协议蓝本——CLI/TUI/IM adapter/Go bridge 共用同一抽象（Codex）。
2. **OpenHands EventLog append-only 事件溯源**作内核唯一状态源，免费得到 resume + 重放 + 审计；务必做 schema 版本迁移（OpenHands）。
3. **pi JSONL DAG（id/parentId）会话存储**，聊天 reply 映射 parentId，fork/resume 零额外设计（pi）。
4. **Claude Code hook 矩阵 + 软约束/硬约束分层**：CLAUDE.md 软指导 + PreToolUse hook 代码强制，hook 结果不经模型判断防越狱（Claude Code）。
5. **OpenClaw 工具声明/执行分离 + availability 表达式**，编程/聊天两形态动态切工具集无 if-else（OpenClaw）。
6. **双轨工具调用（Native JSON 优先 + XML/prompt 回退）**覆盖 Anthropic/OpenAI 原生与 Ollama 弱模型（Cline/Goose/OpenHands）。
7. **保首+保尾+中段 LLM 摘要的 Condenser，且强制保留不透明标识符**（OpenHands + OpenClaw）。
8. **NoneBot2 Transport+Adapter 二层 + 统一 UnifiedMessage**，QQ/TG/Discord 接入开销最小（NoneBot2/AstrBot）。
9. **SecurityAnalyzer + ConfirmationPolicy 正交解耦**，同内核换 policy 适配宽松聊天与严格编程（OpenHands/Codex）。
10. **ACP `session/request_permission` 四选项协议化审批 + OpenClaw DM pairing** 作开放渠道安全基线（ACP/OpenClaw）。

### 3.2 要避开

1. **强绑单一 provider wire format**：Codex 砍掉 chat/completions 只剩 Responses API，非兼容端点必须前置代理——yo-agent 必须 provider 抽象（Codex 反例）。
2. **强锁单一模型生态**：Gemini CLI 无 provider 抽象，最终个人用户被弃用迁 Antigravity——BYOK 是生命线（Gemini 反例）。
3. **上下文只做硬截断、无摘要压缩**：LangBot Round Truncator / NoneBot 内存 State，长对话失忆、重启即失（LangBot/NoneBot 反例）。
4. **无 loop 熔断 / 靠 LLM 自识别死循环**：会烧 token 失控——必须引擎层四模式 + 历史窗 + 硬上限（参考 OpenClaw）。
5. **无沙箱 + 无 checkpoint 同时缺失**：纯靠规则自约束的 bash 裸跑很危险（pi/opencode 弱点）；至少要 checkpoint 回滚兜底。
6. **聊天 bot 全自动执行无任何审批/pairing**：AstrBot/LangBot 敏感工具仅靠预配置白名单，开放渠道误操作/注入风险高。
7. **架构过度复杂**：OpenClaw src/agents 300+ 文件、80+ 插件各维护 AGENTS.md，碎片化——yo-agent 取其模式不照搬规模（OpenClaw 反例）。
8. **SQLite-only 早期强约束**：快速迭代期灵活性不足（OpenClaw 自陈弱点）——但生产期是优点。
9. **插件直接 require() 进主进程无隔离**：pi 扩展/NoneBot 插件崩溃拖垮全局——应进程/Worker 隔离（参考 LangBot 3 种 IPC）。
10. **核心闭源 / 主循环不可定制**：Claude Code 社区无法改底层——yo-agent 作为引擎须保持 loop 可扩展（Claude Code 反例）。

---

## 4. 对 yo-agent 最关键的结论（可操作）

1. **对外协议 = JSON-RPC over (TLS) socket + Thread/Turn/Item 三层事件流**：直接以 Codex app-server 为范本，方法集 `turn/start`+`turn/steer`+`turn/interrupt`、`session/resume(cursor)`、`fs/*`、`model/list`；事件类型参考 pi 命名（session/turn_start/tool_execution_start/tool_approval/...）。同时支持 `--mode rpc`（JSONL/LF，给轻量场景）。这套协议同时满足"被 yo-aichat Go bridge 当第四类 agent 驱动"和"独立 CLI"两个要求。

2. **内核唯一状态源 = append-only EventLog（OpenHands 模式）**，落盘 SQLite，带 schema 版本号。`resume(cursor)` 直接 = 从某事件 id 之后重放/重连；聊天平台长会话 resume 与多 agent 隔离一并解决。务必从第一天就设计版本迁移。

3. **会话存储用 JSONL DAG / 事件图（id+parentId）**：Telegram `reply_to_message_id`、QQ 引用映射到 parentId，fork/branch 免设计；与 EventLog 结合即"可恢复 + 可分支"流。

4. **工具层：声明/执行分离 + 多源统一注册 + 双轨调用**：`ToolDescriptor{availability 表达式} + ToolExecutorRef`（OpenClaw），内置/插件/MCP 三源走同一接口（AstrBot/LangBot）；调用按 provider 能力自动选 Native JSON 或 prompt-parse 回退（Cline/Goose）。编程态/聊天态靠 availability 条件切工具集，不写分支。

5. **MCP 做双向**：用 `@modelcontextprotocol/sdk` 当 Host（挂外部工具，会话级懒加载 + TTL + 失败熔断），并以 `--mcp-server` 把 yo-agent 自身暴露为 MCP Server（Codex/Nanobot 模式），使其既能独立跑、又能当更大流水线的执行节点。注意 MCP 动态工具变更会破坏 prompt 缓存前缀。

6. **权限：SecurityAnalyzer × ConfirmationPolicy 正交 + 协议化审批**：风险打分与确认策略解耦（OpenHands），同内核聊天态注 `ConfirmRisky`、编程态注 `ConfirmHigh`；审批走 ACP 式 `request_permission` 四选项消息（前端无关，IM 渲染按钮）。开放渠道默认 **DM pairing**（OpenClaw）。

7. **软约束/硬约束分层**：YOAGENT.md / AGENTS.md（兼容 CLAUDE.md，cwd 向上合并 ≤32KiB）作 user 消息注入软指导；`beforeToolUse(tool,input)=>allow|deny|modify` hook 作代码强制，**不经模型判断**（Claude Code）。这是防越狱与平台级定制（群/频道级 AGENTS.md）的根基。

8. **上下文压缩 = 独立 Condenser 组件**：阈值默认 ~80% 触发，保首 keep_first + 保尾 N + 中段 LLM 摘要，生成结构化 Handoff 文档（Goal/State/Next Steps，Nanobot），**摘要 prompt 必须强制"不透明标识符逐字保留"**（OpenClaw）；压缩用可换的便宜模型。Condenser 接口按 session 类型可配阈值。

9. **多平台接入 = Transport + Adapter 二层 + UnifiedMessage**（NoneBot2/AstrBot）：`Transport`(连接生命周期) 与 `PlatformAdapter`(平台↔AgentEvent 转换) 分离，一个引擎实例同时 register 多个 adapter；平台消息推入 EventLog，结果由 adapter 格式化回写。OneBot v11 优先（覆盖 QQ）。

10. **子 agent = 独立上下文 + 进程/Worker 隔离 + 异步 steering 注入**：探索型任务 spawn child（只回摘要，防污染，Claude Code/Gemini）；并发用 worker_threads/child_process 隔离（Goose）；子结果放 steering queue 下轮注入不阻塞主循环（OpenClaw/opencode）。声明式 mode/recipe（YAML：prompt+工具白名单+绑定 model）使行为可版本控制（Roo/Goose）。

11. **多重熔断与硬上限**：loop detector 四模式（generic_repeat/unknown_tool_repeat/poll_no_progress/ping_pong，30 历史窗，OpenClaw）+ 工具调用轮次硬上限（~128，LangBot）+ per-turn token 预算追踪（耗尽中止，Codex）。引擎层做，不依赖 LLM。

12. **可恢复性兜底 = checkpoint**：编程态在工具执行层封装 checkpoint（shadow git 或文件快照，Cline/Gemini/Aider），暴露 `rollback(id)`；与会话 EventLog 恢复正交，互补而非互斥。无 OS 沙箱时这是最低安全网。

---

### 附：与 yo-aichat 兼容性要点

yo-aichat 的 Go agent-bridge 用"cursor-可恢复 JSON-RPC over (TLS) socket"驱动 claude/codex/pty 三类 agent，有 ed25519 设备鉴权 + 配对码、AgentEvent sealed 事件流、原生工具审批。yo-agent 作为"第四类"应：
- 说一套**与 AgentEvent 同构的 sealed 事件流**（session/turn/message/tool-approval），支持 `resume(cursor)`（即结论 1+2）；
- 审批走**协议消息**而非进程内 UI（结论 6），与 bridge 的原生审批对接；
- **配对/鉴权**复用 OpenClaw DM pairing 思路，与 bridge 的 ed25519 + 配对码模型一致（结论 6）；
- 既能被 bridge 驱动，也能独立 CLI + 挂 IM（结论 1 的双模式）。
