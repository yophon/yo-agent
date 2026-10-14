# NoneBot2

> 跨平台 Python 异步聊天机器人框架 · nonebot 社区 · Python · MIT · https://github.com/nonebot/nonebot2

## 1. 是什么 / 定位

NoneBot2 是一个以「平台无关」为核心设计目标的 Python 异步 bot 框架，本身**不内置任何 LLM**，定位是通用的聊天平台接入与事件路由引擎。它的价值在于通过统一的 Adapter 抽象，让开发者一套代码同时接入 QQ（OneBot v11/v12）、Telegram、Discord、飞书、钉钉、GitHub、Console 等 30+ 平台。

版本：**v2.5.0（2026-04-01，GitHub API 实证）**，~7,581 GitHub stars，MIT 协议，仓库截至 2026-06-21 仍有活跃提交，社区 plugin registry（registry.nonebot.dev/plugins.json）记录 895 个插件。NB-CLI 脚手架是官方推荐的项目初始化工具。框架核心语言 Python（`requires-python = ">=3.10, <4.0"`），依赖 AnyIO（>=4.4.0）+ Trio（>=0.27.0）作为并发后端（v2.4.0 迁移自纯 asyncio），Pydantic v1（>=1.10）和 v2 均支持。

## 2. 架构总览（agent loop / 运行时主循环）

NoneBot2 的运行时范式是**事件流驱动（Event-stream）**，不是 ReAct / 计划-执行循环。主循环由 Driver 持有，流程如下：

```
平台协议
  ↓ (HTTP Webhook / WebSocket)
Driver（AnyIO 事件循环 + ASGI/Client 连接管理）
  ↓ payload
Adapter.payload_to_event()
  ↓ Event 对象
Bot.handle_event()
  ↓
event_preprocessor hooks
  ↓
Matcher 优先级队列遍历（priority 从小到大）
  ↓ Rule + Permission 过滤
Handler 链（handle / got / receive / pause / finish / reject 状态机）
  ↓
event_postprocessor hooks
  ↓ API 调用
Bot._call_api() → Adapter → Driver → 平台
```

Handler 链本质上是一个**协程状态机**：Matcher 内部维护 `remain_handlers` 列表，每步 `handle()` 顺序执行，`got()` / `receive()` / `pause()` 遇到需要用户输入时抛出异常（源码确认：`RejectedException` / `PausedException` / `FinishedException` / `SkippedException`），框架捕获后创建一个临时 Matcher 保存剩余 handlers 与 State（continuation），等待下一条消息到达后恢复执行——这是 NoneBot2 实现多轮对话的核心机制，概念上接近 coroutine 续体（continuation）。

事件在 Matcher 间按优先级传播，`stop_propagation()` 可终止向低优先级传播。

## 3. 工具系统（内置工具集 + 函数调用机制 + 是否 MCP host/client）

NoneBot2 **不是 LLM agent 框架**，没有内置工具集，也**不支持 MCP**（官方无 MCP host/client 实现，官方文档未提及，nonebot.dev 首页无任何 AI agent 特性描述）。「工具」在这里的等价物是：

- **Bot API**：各 Adapter 实现的 `bot.call_api()` / `bot.send()` 等方法，是框架对平台 API 的封装。
- **plugin-alconna**：官方维护的扩展插件，提供跨 22+ 平台统一的 `UniMessage` 消息 API（发送图片、文件、Markdown、表情回应等），是最接近「工具调用」的抽象层。
- **事件钩子**：`@Bot.on_calling_api` / `@Bot.on_called_api` 可拦截/Mock 所有 API 调用，功能类似代理层工具审计。

若要在 NoneBot2 中集成 LLM，需要自行写插件调用 LLM SDK。社区有第三方 AI 对话插件（如基于 NoneBot2 的 Muice-Chatbot 实现了 MCP Host），但这属于社区应用层而非框架核心。

## 4. 上下文与记忆（窗口管理 / 压缩摘要 / 长期记忆 / 会话恢复 resume）

NoneBot2 的会话上下文是**轻量级、短期的 State 字典**：

- **`T_State`**：`dict[Any, Any]`，与单个 Matcher 实例绑定，生命周期与该次对话流程相同。多个 handler 函数按顺序读写同一 State。
- **会话恢复**：通过临时 Matcher 保存 `remain_handlers + state`，在下一条匹配消息到达时恢复，实现多轮对话中间状态持久化。但这只在进程内存中，**重启即失**。
- **长期记忆**：框架本身无内置长期存储；官方维护 `nonebot-plugin-localstore`（本地文件存储路径标准化）、`nonebot-plugin-datastore`（SQLite/异步 ORM），供插件使用。
- **无上下文压缩**：框架不涉及 LLM token 窗口，无摘要/压缩机制。
- **Permission 持久性**：不同于 Rule（每次事件重新评估），Permission 在会话更新时默认加入 USER 条件校验，隐式保持「谁发起此会话」的一致性。

## 5. Prompt / 系统提示策略（CLAUDE.md/AGENTS.md 类约定、模式如 plan/act）

NoneBot2 **没有 CLAUDE.md / AGENTS.md 类约定**，不面向 LLM prompt 工程。框架层面的「配置」通过以下机制完成：

- **`.env` / `.env.*` 文件**：存储所有环境变量配置，Pydantic Settings 自动解析，插件通过声明 `Config` 类消费配置。
- **`pyproject.toml`**：记录插件列表、适配器、驱动器选择。
- **`PluginMetadata`**：插件头部声明元信息（name / description / usage / supported_adapters / config），供商店索引与帮助生成使用。

没有 plan/act 模式切换，因为框架不是 agent 引擎——事件响应是无状态规则匹配，而非多步推理。

## 6. 权限与审批（工具执行如何获批、沙箱 seatbelt/landlock/docker）

NoneBot2 有**消息/用户级权限系统**，无代码执行沙箱：

- **Permission**：由一到多个 `PermissionChecker`（async/sync callable）组成，任一返回 `True` 即通过。内置：`SUPERUSER`（全局超管）、`GROUP_ADMIN`、`GROUP_OWNER`、`PRIVATE_FRIEND` 等。`|` 运算符组合权限（OR 语义）。
- **Rule**：过滤事件内容（消息文本、命令前缀、正则等），`&` 运算符组合（AND 语义）。Rule 与 Permission 的核心区别：Permission 关注「谁」，Rule 关注「什么内容」。
- **SUPERUSER 配置**：`.env` 文件写 `SUPERUSERS=["123456789"]`，框架在 Permission 检查时自动对比平台 user_id。
- **审批机制**：无人工审批环节；`@run_preprocessor` 钩子可实现自定义拦截（如频率限制、黑白名单）。
- **沙箱**：框架层无沙箱，代码在宿主进程中执行，部署时靠 Docker 隔离。

## 7. 多平台 / 传输 / 接入层（CLI/IDE/TUI/聊天平台、协议 MCP/ACP/A2A/OneBot）

这是 NoneBot2 **最核心的设计价值**：

### Driver 层（传输实现）
| Driver | 类型 | 说明 |
|--------|------|------|
| FastAPI（默认）| Reverse（Server） | ASGI，接受 Webhook/WS 连接 |
| Quart | Reverse | Flask-like ASGI |
| HTTPX | Forward（Client）| 仅 HTTP |
| websockets | Forward | 仅 WebSocket client |
| AIOHTTP | Forward | HTTP + WebSocket client |
| None | 无网络 | 纯本地/测试 |

Driver 组合语法：`fastapi+httpx`，允许一个 Server Driver 混入多个 Client Driver Mixin。

### Adapter 层（平台协议）
| Adapter | 平台 |
|---------|------|
| OneBot v11 | QQ（via go-cqhttp、LLOneBot 等） |
| OneBot v12 | QQ 新协议、Chronocat |
| Telegram | Telegram Bot API |
| Discord | Discord Bot |
| 飞书（Feishu）| 飞书/Lark |
| 钉钉（DingTalk）| 钉钉 |
| GitHub | GitHub App / Webhook |
| Console | 终端（调试） |
| Satori | Satori 协议（跨平台协议层） |
| Red | Chronocat QQ Red 协议 |
| + 社区适配器 | Line、Matrix、KOOK 等 |

Adapter 接口：4 个核心基类（`Adapter` / `Bot` / `Event` / `Message`），约 8 个必须实现的抽象方法。注册方式：`driver.register_adapter(MyAdapter)`，多 Adapter 共存，同一进程可同时连接多个平台。

**MCP / ACP / A2A**：官方均不支持，无相关实现（nonebot.dev 文档及首页无任何 MCP 提及）。

## 8. 插件 / 扩展 / 子 agent（subagent、多 agent 委派）

NoneBot2 的扩展单元是**插件（Plugin）**：

- **加载方式**：`load_plugin()` / `load_plugins(dir)` / `load_from_toml()` / `nb-cli` 一键安装。每个插件是 Python 模块或包，仅加载一次，重复加载被忽略。
- **嵌套插件（Nested Plugins）**：父插件在 `__init__.py` 中调用 `load_plugins()` 加载子插件目录，形成树状结构。`Plugin` 对象暴露 `parent_plugin` / `sub_plugins` 属性。
- **跨插件调用**：`require("plugin_name")` 声明依赖并确保目标插件先于当前插件加载，然后直接 import 目标插件的模块。
- **插件生命周期钩子**：插件模块顶层代码在加载时执行，可注册 `@driver.on_startup` 等全局钩子。
- **无多 agent 委派**：NoneBot2 没有 subagent / orchestrator 概念，不是 LLM multi-agent 框架。「多机器人」指同一进程中多个 Bot 实例（不同平台账号），通过 `get_bots()` 遍历，可实现跨账号转发但不是 agent 委派。
- **插件生态**：官方维护 https://nonebot.dev/store/plugins（页面因 JS 动态渲染显示 0，但 registry.nonebot.dev/plugins.json 实证 895 个插件，2026-06 实测）。

## 9. Provider 抽象（是否 BYOK 多模型）

NoneBot2 框架本身**不涉及 LLM provider**，没有 BYOK 机制，也没有模型切换抽象。它的 provider 抽象在**聊天平台**层面（Adapter），不在 AI 模型层面。

若接入 LLM 能力，完全由插件开发者自行选型（OpenAI SDK、Anthropic SDK、本地 Ollama 等），框架不提供任何辅助。这与 LangChain / LlamaIndex 等框架形成鲜明对比——NoneBot2 的设计目标是「聊天平台接入层」，而非「LLM 编排层」。

## 10. 亮点设计（值得 yo-agent 借鉴）/ 短板 / 坑

### 亮点

1. **Driver + Adapter 二层解耦**：传输实现（HTTP/WS/ASGI）与平台协议彻底分离，新增平台只需实现 Adapter 4 个基类，不碰传输层；新增传输方式只需实现 Driver Mixin，不碰业务逻辑。这是目前开源 bot 框架中最干净的接入层架构之一，已有 10+ 官方 adapter 和 895 个社区插件验证。

2. **依赖注入（DI）驱动的 Handler**：Handler 函数参数全靠类型注解自动注入（Bot、Event、State、Matcher、Depends(…)），支持类型重载（`PrivateMessageEvent` vs `GroupMessageEvent`），高优先级参数（Bot/Event/Matcher 类型不匹配时整个 handler 跳过）实现了隐式路由。无需显式传参，代码极简。

3. **协程续体式多轮对话**：`pause()` / `got()` / `receive()` 抛异常（`PausedException` / `RejectedException`）→ 框架保存 continuation（`remain_handlers` + state）→ 下条消息到达时恢复。这比传统的 FSM 状态机更灵活，代码仍是线性书写，无需显式状态枚举。

4. **Permission 持久性 vs Rule 无状态**：Permission 在会话中自动锁定发起人（USER 条件），Rule 每次重新计算，两者职责清晰。这避免了「会话被劫持」（其他用户插入消息）的问题。

5. **NB-CLI 脚手架**：`nb create` / `nb plugin create` / `nb run` 一套 CLI 统一项目生命周期，`nb plugin publish` 对接商店——开发者工具链完整。

### 短板

- **Python 专属**：整个生态绑定 Python AnyIO/asyncio，对 TypeScript/Node.js 栈的 yo-agent 直接复用代码不可能，只能借鉴设计范式。
- **无 LLM 原生支持**：不是 agent 引擎，接入 LLM 全靠社区插件，质量参差不齐，无统一的 context 窗口管理/摘要/工具调用抽象。
- **无 MCP 支持**：在 MCP 成为 AI 工具标准的 2025-2026 年，NoneBot2 官方尚无 MCP host/client 实现，官方路线图中也未提及。
- **会话状态非持久化**：State 在内存中，进程重启后多轮对话状态丢失，需自行实现持久化（datastore 插件）。
- **单进程多 Bot 模型**：扩展性依赖 Python 进程级别，无原生分布式/微服务架构，高并发场景需要额外设计。
- **插件隔离弱**：插件共享同一 Python 进程，插件崩溃可能影响整体稳定性，无沙箱隔离。

## 11. 对 yo-agent 的具体启示

1. **接入层二层架构直接可用**：yo-agent 应参照 NoneBot2 的 `Driver`（传输） + `Adapter`（平台协议）分层，用 TypeScript interface 定义：`Transport`（管理 HTTP/WS 连接生命周期）和 `PlatformAdapter`（将平台消息转换为内部 `AgentEvent`，将内部 API 调用转换为平台 API 请求）。一个 yo-agent 实例可以同时 `register(new TelegramAdapter())` 和 `register(new DiscordAdapter())`，传输层不感知平台差异。

2. **Handler 依赖注入模式**：NoneBot2 用类型注解做参数自动注入极大降低了 handler 编写复杂度。yo-agent 可在 TypeScript 中用装饰器（`@inject`）或参数名约定实现类似机制——handler 函数声明 `(ctx: AgentContext, event: MessageEvent, state: State)` 时框架自动按类型填充，不同 event 子类型路由到不同 handler。

3. **协程续体式多轮对话**：yo-agent 的对话状态机应参考 `pause/got/receive` 模型——用 AsyncGenerator 或 Promise continuation 保存「当前 handler 链的剩余步骤 + 会话 state」，而不是用显式 FSM 枚举所有状态。TypeScript 中可以用 `async function*` 或基于 `AbortController` 的挂起机制实现。

4. **Permission 与 Rule 职责分离**：yo-agent 的权限系统应区分「谁能触发」（Permission，会话级持久，锁定发起用户）和「消息内容匹配」（Rule，每次无状态重算），两者独立声明、组合使用。避免把用户鉴权和内容路由混在同一个 if 条件里。

5. **`require()` 跨插件依赖声明**：yo-agent 的插件系统应设计显式依赖声明机制（如 `plugin.requires(['storage', 'llm-provider'])`），框架在加载时拓扑排序，确保依赖插件先于当前插件初始化，避免循环依赖和加载顺序问题。

6. **完整生命周期钩子集**：NoneBot2 提供 8 类钩子（startup/shutdown/bot_connect/bot_disconnect/event_pre/event_post/run_pre/run_post + API 拦截），覆盖了监控、限流、Mock 测试等所有横切关注点。yo-agent 应设计同等粒度的钩子系统，尤其是 `beforeToolCall` / `afterToolCall` 钩子对于 LLM agent 的 observability 至关重要。

## 参考来源（均经过实证访问）

- https://github.com/nonebot/nonebot2 — 官方仓库（v2.5.0，2026-04-01，GitHub API 实证；7,581 stars；MIT）
- https://nonebot.dev/ — 官方文档首页（无 MCP 提及，实证）
- https://nonebot.dev/docs/tutorial/matcher — Matcher 系统（事件响应器）
- https://nonebot.dev/docs/appendices/overload — 依赖注入与类型重载
- https://nonebot.dev/docs/advanced/plugin-info — 插件元信息与嵌套插件
- https://nonebot.dev/docs/advanced/dependency — 依赖注入系统
- https://nonebot.dev/docs/next/advanced/runtime-hook — 生命周期与运行时钩子
- https://nonebot.dev/docs/developer/adapter-writing — 自定义适配器编写指南
- https://github.com/nonebot/adapter-onebot — OneBot v11/v12 适配器
- https://github.com/nonebot/adapter-telegram — Telegram 适配器
- https://github.com/nonebot/adapter-feishu — 飞书适配器
- https://github.com/nonebot/plugin-alconna — UniMessage 跨平台消息扩展
- https://github.com/nonebot/nonebot2/releases — 发布历史（最新 v2.5.0，2026-04-01，API 实证）
- https://registry.nonebot.dev/plugins.json — 插件注册表（895 插件，2026-06 实测）
- https://raw.githubusercontent.com/nonebot/nonebot2/master/pyproject.toml — 版本/依赖实证来源
