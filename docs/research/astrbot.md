# AstrBot

> 开源多平台 Agentic AI 聊天机器人框架，连接 15+ IM 平台与多家 LLM 提供商；作者 AstrBotDevs 社区；Python 3.12+；AGPL-3.0；https://github.com/AstrBotDevs/AstrBot

---

## 1. 是什么 / 定位

AstrBot 是一个以"Agentic IM chatbot infrastructure"为定位的开源框架（35.2k Stars，截至 2026-06-24），核心目标是：在现有 IM 生态（QQ、微信、Telegram 等）内，快速部署一个既能闲聊、又能执行多步工具调用的 AI 助手。官方自描述为"AI Agent Assistant & development framework that integrates lots of IM platforms, LLMs, plugins and AI features"，并主动对标 openclaw（国内知名闭源方案）。

技术栈：Python 3.12+（~69.4%），Vue 3（~22.4%），TypeScript（~5.6%），Quart 异步 Web 框架，SQLite 持久化，aiohttp/httpx 非阻塞 HTTP。许可证 AGPL-3.0。当前稳定版 v4.25.6（2026-06-21 发布），v4.26.0-beta.12 进行中。

---

## 2. 架构总览（agent loop / 运行时主循环）

AstrBot 采用**事件驱动的有序 Pipeline** 架构。每条入站消息从平台适配器收到后，经过六个 Stage 依次处理：

```
Platform Adapter → EventBus → Pipeline Stages → LLM / AgentRunner → Response → Platform Adapter
```

六个 Pipeline Stage（固定顺序）：

- **WakingCheckStage**：校验唤醒词（wake_prefix）或 @ 触发，群聊中默认需要唤醒。
- **WhitelistCheckStage**：ID 白名单访问控制。
- **RateLimitStage**：可配置速率限制策略，防滥用。
- **ContentSafetyCheckStage**：内容安全过滤。
- **ProcessStage**：核心 AI 执行点，选择 Provider/AgentRunner、注入 Persona、协调工具执行；支持 `max_agent_step` 限制迭代次数。
- **RespondStage**：将 AI 响应序列化为平台可用格式并发送。

注：**Plugin Filter** 逻辑在 ProcessStage 前（或通过 StarManager 提前路由），将命令类消息分流给 Star 插件处理，不进入 LLM 路径。

**AgentRunner（ReAct 式多步循环）**

ProcessStage 内部依赖可插拔的 `AgentRunner`。内置 `ToolLoopAgentRunner`（实现文件：`astrbot/core/agent/runners/tool_loop_agent_runner.py`）实现了"感知→规划→行动→观察→再规划"迭代：

1. 调用 Chat Provider 获取初始响应；
2. 若响应包含 tool_calls，依次执行工具，收集结果；
3. 将工具结果作为 observation 追加上下文，再次调用 LLM；
4. 重复直到 LLM 返回纯文本最终答案，或达到 `max_agent_step` 上限。

官方文档明确区分："Chat Provider 负责'说话'；Agent Runner 负责'思考+做事'"。

外部 AgentRunner（v4.7.0 起从 Chat Provider 迁移至 AgentRunner 层）：**Dify、Coze、阿里云百炼、DeerFlow**——这些平台自带推理循环，可与内置 Runner 无缝切换。

---

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

**内置工具**：网页搜索、Todo 提醒、代码解释器（Sandbox）。插件可注册额外工具。

**函数调用机制**：统一由 `FunctionToolManager` 管理，汇聚三类来源：

1. **Plugin 注册工具**：Star 插件通过 Python 装饰器将函数暴露为 LLM 可调用工具，schema 自动从函数签名/docstring 生成。
2. **MCP 工具**：连接外部 MCP Server 后自动发现其工具列表，注册进同一工具注册表。
3. **系统内置工具**：沙箱代码执行、搜索等，可在 WebUI 按需启用/禁用。

LLM 返回 tool_call 时，ToolLoopAgentRunner 调度执行并把结果以 observation 格式追回上下文。若模型不支持工具调用，AstrBot 会自动检测并移除 function calling 工具列表（可手动禁用所有工具），避免报错。

**MCP 角色：Client（非 Host/Server）**。AstrBot 自 v3.5.0 起支持 MCP 协议，以 **MCP Client** 身份连接任意 MCP Server（通过 `uv tool run` 启动 Python 服务，或 `npm` 启动 Node.js 服务）。配置通过 WebUI 填写 command + args + env。工具一旦连接即自动纳入 FunctionToolManager，与插件工具统一调度。另有社区项目 `astrbotmcp`（`xunxiing/astrbotmcp`）实现从外部通过 MCP 控制 AstrBot 本身，属于逆向使用，非官方维护。

**Skills（结构化指令包）**：遵循 Anthropic Skills 规范的轻量扩展形式——每个 Skill 是含 `SKILL.md` 的目录，SKILL.md 描述操作手册（类似 AGENTS.md）。采用**渐进式披露**：模型初始只加载 Skill 名称和简短描述，仅在任务匹配时才完整加载 SKILL.md 指令，节省 context window。Skill 可包含可执行脚本，在沙箱或本地环境运行。

---

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复）

**短期记忆**：每个会话（ConversationManager）维护完整对话历史，存入 SQLite（`data_v4.db`）。

**上下文压缩**：内置基于摘要的压缩机制。触发条件由两个阈值控制：token 数（如 3000）或消息数（如 50 条）。触发后，系统保留最近 N 条消息不动，对更早的消息调用 LLM 生成摘要，替换原始消息追加到上下文头部。摘要模型可单独指定（轻量模型即可），支持自定义 `llm_compress_instruction` 提示词控制摘要粒度。`trim_tokens` 参数指定压缩后目标 token 数，一般设为上下文窗口的 75%。

**长期记忆**：主要依赖 **Knowledge Base（RAG）**——FAISS 向量存储 + BM25 关键词检索的混合检索方案，文档可通过 WebUI 上传（TXT、PDF 等）。检索到的知识片段在 ProcessStage 注入为临时用户内容。尚无独立的对话级长期记忆（Episodic Memory）模块，长期记忆依赖外部插件或 MCP 工具扩展。

**会话恢复**：SQLite 持久化保证服务重启后会话历史不丢失，ConversationManager 按 session ID 加载历史。

---

## 5. Prompt / 系统提示策略（CLAUDE.md/AGENTS.md 类约定、模式如 plan/act）

AstrBot 没有 CLAUDE.md/AGENTS.md 等价的面向运维者约定文件，但有两层系统提示机制：

1. **Persona（人格）**：PersonaManager 管理多个命名 Persona，每个 Persona 包含 `system_prompt`、`name`、`tone`、`language` 等字段，持久化在 `data_v4.db`。ProcessStage 在调用 LLM 前将当前 Persona 的 system_prompt 注入为消息历史首条 system 消息。支持**平台差异化 Persona**：QQ 用户与 Telegram 用户可使用不同人格配置。

2. **Skills 的 SKILL.md**：每个 Skill 目录下的 `SKILL.md` 是该 Skill 的操作手册，类似微型 AGENTS.md，遵循 Anthropic Skills 规范。采用渐进式披露（progressive disclosure）：模型先仅加载 Skill 名称和描述，仅在任务匹配时才完整加载指令内容，控制 token 消耗。

无独立的 plan/act 两阶段模式；ReAct 循环本身已内嵌规划与执行。

---

## 6. 权限与审批（工具执行如何获批、沙箱 seatbelt/landlock/docker）

**用户权限分层**：
- `admins_id`：管理员用户 ID 列表，通过 `/sid` 命令获取当前用户 ID 后手工配置。
- 普通用户默认只能访问非敏感功能。
- 群聊场景可配置白名单，`RateLimitStage` 提供速率限制防滥用。

**Agent 执行环境（Computer Use / 代码执行的运行时模式）**：

AstrBot 提供两种代码/自动化执行运行时：

- **Local**：Agent 直接在 AstrBot 宿主环境执行（无沙箱隔离）。出于安全考虑，**默认仅管理员**可触发 Local 模式的 Computer Use 能力；`computer_use_require_admin=true` 进一步强制此限制。
- **Sandbox**：Agent 在隔离沙箱内执行，普通用户可用。需先单独启用沙箱模式。

**沙箱（Agent Sandbox）**：v4.12.0 引入，替代旧版代码执行器。

- 驱动后端：**Shipyard Neo**（推荐）与 Shipyard（遗留，仍支持）。Shipyard Neo 由三个组件构成：
  - **Bay**：控制平面 API，负责创建和管理 sandbox 实例。
  - **Ship**：提供 Python 代码执行、Shell 命令、文件系统能力。
  - **Gull**：提供**浏览器自动化**能力（非"网络层"，browser automation）。注意：浏览器能力并非所有 Shipyard Neo profile 都可用。
- 部署方式：可与 AstrBot 同机部署，也可将 Shipyard Neo 单独部署在远程机器上（推荐生产，资源独立）。
- 工作目录：Shipyard Neo 固定在 `/workspace`，所有文件操作基于此相对路径。
- 资源上限：每个 sandbox 实例最多 1 CPU、512 MB 内存；宿主机建议至少 2 CPU、4 GB RAM。
- 支持 warm pool 预热，降低首次启动延迟。
- 并发：`max_sessions` 参数控制并发 sandbox 会话数，支持有状态会话复用。

工具执行**无交互式审批弹窗**——安全边界通过配置（管理员 ID、运行时模式、沙箱资源限制）前置划定，而非运行时逐次确认。

---

## 7. 多平台 / 传输 / 接入层（CLI/IDE/TUI/聊天平台、协议 MCP/ACP/A2A/OneBot）

AstrBot 的平台接入层基于**适配器（Adapter）模式**，核心抽象 PlatformManager 统一注册和调度各平台适配器。

已确认支持的平台（官方维护，截至 2026-06）：

| 平台 | 协议/方式 |
|------|-----------|
| QQ（个人号/群） | OneBot v11（aiocqhttp），依赖 NapCat 或 LLOneBot |
| QQ 频道 | QQ 官方机器人 API |
| 微信（个人号） | 第三方协议 |
| 企业微信（WeCom） | 企业微信 API |
| 飞书（Lark） | 飞书开放平台 API |
| 钉钉 | 钉钉开放平台 API |
| Telegram | Bot API |
| Discord | Discord Bot API |
| Slack | Slack API |
| KOOK（开黑啦） | KOOK Bot API |
| LINE | LINE Messaging API |

WebUI（基于 Quart + Vue 3）作为管理接入层，提供配置、插件管理、日志监控、知识库上传等功能，亦支持通过内嵌 ChatUI 与 bot 直接对话（相当于 Web 平台适配器）。

消息格式在进入 Pipeline 前统一转换为 `AstrBotMessage`，屏蔽平台差异。出站时反向序列化。

协议支持：**MCP**（Client 侧）、**OneBot v11**（QQ）、各平台原生 Webhook/WebSocket。暂未见 ACP/A2A 多 agent 协议支持。

---

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

**Star 插件系统**是 AstrBot 最核心的扩展机制：

```python
from astrbot.api.star import Star, Context, filter
from astrbot.api.event import AstrMessageEvent

class MyPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    @filter.command("hello")
    async def handle_hello(self, event: AstrMessageEvent):
        """响应 /hello 命令"""
        yield event.plain_result(f"Hello, {event.get_sender_name()}!")

    async def terminate(self):
        """插件卸载/禁用时清理资源"""
        pass
```

- 入口文件必须命名 `main.py`，插件类继承 `Star`。
- 装饰器类型：`@filter.command(name)` 命令触发、`@filter.on_message_type(...)` 消息类型触发、`@filter.on_platform(...)` 平台触发等。
- 插件通过 `Context` 对象访问核心 API（调用 LLM、访问数据库、注册 LLM 工具等）。
- 插件可向 FunctionToolManager 注册 LLM 工具，使其在 Agent loop 中可被调用。
- 支持热重载；插件生命周期（安装/启用/禁用/卸载）由 StarManager 管理。
- 官方插件市场提供 **1000+ 社区插件**，WebUI 一键安装。
- `skills/` 目录内可含 Skills（基于 SKILL.md 的结构化任务指令包）。

**多 agent / 子 agent**：DeepWiki Section 10.1 标注了"Subagent Orchestration"作为高级主题，但官方文档尚无详细说明。当前主要通过接入 Dify/Coze 等第三方 Agent 平台的 AgentRunner 实现变相的 multi-agent（外部平台内部可有多 agent 编排）。原生子 agent 委派能力仍处于早期/计划阶段。

---

## 9. Provider 抽象（是否 BYOK 多模型）

AstrBot 是完全的 **BYOK（Bring Your Own Key）** 模式——用户自带各家 API Key，框架不托管任何密钥。

ProviderManager 采用**两层配置**：
- `provider_sources`：存储 API Key、Base URL 等凭证（一个来源可含多个 Key 实现负载均衡）。
- `provider` 实例：绑定具体模型名称和来源 ID，构成可选的 Provider 实体。

支持的 Provider 类型：

| 类型 | 代表实现 |
|------|---------|
| Chat（文本/推理） | OpenAI（含兼容 API）、Anthropic（Claude 4.x 等）、Google Gemini、阿里 Dashscope（Qwen）、DeepSeek、Ollama、各类 OpenAI 兼容聚合 API |
| STT（语音转文字） | OpenAI Whisper、SenseVoice |
| TTS（文字转语音） | Edge TTS、OpenAI TTS |
| Agent Runner | Dify、Coze、阿里云百炼、DeerFlow |

热重载：ProviderManager 支持运行时切换 Provider 无需重启。模型选择可通过 WebUI 配置，也可由插件在运行时动态指定。

---

## 10. 亮点设计 / 短板 / 坑

### 亮点

1. **平台适配器 + 统一消息格式**：15+ IM 平台统一抽象为 `AstrBotMessage`，上层逻辑完全平台无关。OneBot v11 支持使得 QQ 生态无缝接入，在国内场景极具价值。

2. **FunctionToolManager 统一工具注册表**：插件工具、MCP 工具、系统内置工具三源合一，Agent loop 对接入方式透明——"工具即服务"的良好范式。

3. **Shipyard Neo 沙箱三组件分层**：Bay（控制平面）/ Ship（Python+Shell+FS）/ Gull（浏览器自动化）分层清晰，支持同机或远程独立部署，硬性资源上限（1 CPU / 512 MB）+ 有状态会话复用，适合聊天 bot 场景的代码执行隔离。

4. **Local / Sandbox 运行时双模式**：开发调试用 Local（管理员特权），生产部署用 Sandbox（普通用户隔离），两者通过 `computer_use_require_admin` 灵活切换，无需代码改动。

5. **Skills 渐进式披露**：遵循 Anthropic Skills 规范，SKILL.md 惰性加载，仅匹配时展开，多插件/技能并存时显著节约 token，是面向 prompt 工程的实用设计。

6. **WebUI + ChatUI 一体化管理**：配置、插件、知识库、日志、对话测试全部可视化操作，降低运维门槛，并附带桌面版（AstrBot-desktop）可本地快速安装。

### 短板 / 坑

1. **无运行时交互式审批**：工具执行权限靠预配置（管理员白名单 + 沙箱限制），没有逐次弹窗确认机制。敏感操作（删文件、发消息）存在误操作风险。

2. **子 agent 能力薄弱**：原生多 agent 编排尚未成熟，依赖外部平台（Dify/Coze）变通。复杂分工的 agent 流水线当前架构力不从心。

3. **长期记忆仅靠 RAG**：无 episodic memory 或反思（reflection）机制，跨会话的用户偏好/历史需手动维护知识库或依赖插件扩展，体验不连贯。

4. **AGPL-3.0 许可证**：商业闭源部署存在合规风险，需关注。

5. **微信个人号接入灰色地带**：依赖第三方逆向协议，稳定性与合规性存疑，封号风险长期存在。

6. **Python 单栈 + asyncio 天花板**：高并发大量并行 LLM 调用场景下，Python GIL 和 asyncio 性能上限明显；CPU 密集型沙箱任务可能成为瓶颈。

---

## 11. 对 yo-agent 的具体启示

1. **平台适配器层用统一消息格式 + Adapter 模式隔离**：AstrBot 的 `AstrBotMessage` + PlatformManager 是经过多平台验证的成熟模式。yo-agent 在支持 QQ/Telegram/Discord 时，应在 TypeScript 侧定义平台无关的 `UnifiedMessage` 类型，各平台 Adapter 负责双向转换，避免 Platform 细节渗透进 agent 内核。

2. **工具注册表统一化，来源透明**：FunctionToolManager 将插件工具、MCP 工具、内置工具统一注册并向 AgentRunner 暴露同一接口，是避免"工具碎片化"的关键。yo-agent 的 ToolRegistry 应一开始就设计为支持多来源注入（本地插件、MCP Client、内置），而不是事后拼接。

3. **AgentRunner 与 ChatProvider 解耦**：AstrBot 的 ProcessStage 不直接调用 LLM，而是通过可替换的 AgentRunner 间接调用。yo-agent 应同样抽象出 `AgentRunner` 接口，使得 ReAct 内置循环、外接编排平台、未来的 multi-agent 编排可以热插拔，不污染 Pipeline 核心代码。

4. **运行时双模式沙箱（Local/Sandbox）**：对于支持代码执行的 agent，提供"本地进程（开发者/管理员用）"和"隔离沙箱（生产/普通用户用）"两套执行环境，通过单一配置项切换，复用 AstrBot 的 Local/Sandbox 思路。Node.js 侧可考虑 `child_process` + 资源限制作为轻量 Local 模式，Docker exec 作为严格模式。

5. **Skills 的 SKILL.md 渐进式披露模式**：在 yo-agent 的 Plugin 系统中，引入"惰性 prompt 加载"——plugin manifest 只暴露名称和简短描述，仅当 agent 判断任务匹配该插件时才完整载入详细指令/工具列表，控制系统提示体积，在多插件并存时效果显著。

6. **Persona 与平台差异化系统提示**：AstrBot 支持按平台分配不同 Persona，这对于 yo-agent 同时服务 QQ（较随意）和企业微信（正式）场景非常实用。yo-agent 的 Persona 层应在 pipeline 的 system prompt 构造阶段注入，并支持按 `platform_id` + `session_type` 动态选择人格配置。

---

## 参考来源

- [AstrBotDevs/AstrBot GitHub 仓库](https://github.com/AstrBotDevs/AstrBot)
- [AstrBot 官方文档](https://docs.astrbot.app/en/dev/star/guides/simple.html)
- [DeepWiki - AstrBot 架构总览](https://deepwiki.com/AstrBotDevs/AstrBot)
- [DeepWiki - What is AstrBot](https://deepwiki.com/AstrBotDevs/AstrBot/1.1-what-is-astrbot)
- [DeepWiki - Agent Runners and Tool Execution](https://deepwiki.com/AstrBotDevs/AstrBot/5.4-agent-runners-and-tool-execution)
- [DeepWiki - Computer Use Tools and Sandbox](https://deepwiki.com/AstrBotDevs/AstrBot/2.3-computer-use-tools-and-sandbox)
- [AstrBot Wiki - MCP 使用说明](https://github.com/AstrBotDevs/AstrBot/wiki/en-use-mcp)
- [AstrBot Wiki - Function Calling](https://github.com/AstrBotDevs/AstrBot/wiki/en-use-function-calling)
- [AstrBot Wiki - Agent Runner](https://github.com/AstrBotDevs/AstrBot/wiki/en-use-agent-runner)
- [AstrBot Wiki - Agent Sandbox](https://github.com/AstrBotDevs/AstrBot/wiki/en-use-astrbot-agent-sandbox)
- [AstrBot Wiki - Skills](https://github.com/AstrBotDevs/AstrBot/wiki/en-use-skills)
- [AstrBot Agent Runners 文档](https://docs.astrbot.app/en/providers/agent-runners)
- [AstrBot FAQ](https://docs.astrbot.app/en/faq.html)
- [AstrBot Releases](https://github.com/AstrBotDevs/AstrBot/releases)
- [AstrBot PyPI](https://pypi.org/project/AstrBot/)
