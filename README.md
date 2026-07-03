# yo-agent

一个自研的**通用 agent 引擎**（TypeScript / Node 单栈）。

一句话定位：一个 agent 内核（agent loop + 工具调用 + 上下文管理 + MCP），
**既能当编程 agent**（读写代码、跑命令、diff 审批，对标 Claude Code / Codex / opencode / pi），
**又能挂接聊天平台**（QQ / Telegram / Discord 等，对标 AstrBot / nanobot / openclaw）。

> 可被**任意远端客户端 / IDE（ACP）/ 编排器（MCP）** 用 cursor-可恢复的 JSON-RPC 驱动或集成，也可独立运行。
> （早期曾以「被 yo-aichat 的 Go bridge 驱动」为命脉目标；yo-aichat 已废弃，该耦合移除，可恢复协议保留并泛化为**通用远端驱动协议**，鉴权改为 yo-agent 自带——见 [`DESIGN.md`](docs/DESIGN.md) §0/§6。）

---

## 当前状态

✅ **Phase 0-2 全部交付** ｜ ✅ **Phase 3 七片（3A-3G）全部交付 + 整体收口对抗式审查**：MCP host 连接/三层信任/韧性 + 真机冒烟①、结构化 Handoff/标识符保真、动态 auto-memory、**AcpSurface（被 Zed/JetBrains 经 ACP 接管，退出标准②离线对驱达成）**、MCP 进阶通道（resources/prompts/sampling/progress + Streamable HTTP/OAuth）；收口审查 85 agents、23 确认缺陷全修 —— 见 [`docs/PHASE-3.md`](docs/PHASE-3.md)。
｜ ✅ **Phase 4 交付**（bash 工具集补全 + L1 子进程沙箱 + 子 agent + 插件隔离 —— 开放渠道前的安全底座，6 片 4A-4F；L2 容器/OTel 顺延 Phase 6）：**4A 横切底座**（Hook 矩阵 + permissionMode→PolicyEngine 闸门 + ExecBackend 抽象，无运行时行为变更）+ **4B 工具集补全 + L1 子进程隔离**（bash/edit/grep/glob/todo/apply_patch + 受限 env 剥离 secret + abort 杀进程组 + 大输出截断写盘 + 注入标注）+ **4C SubagentManager**（worker_threads 隔离 + 崩溃围栏 + deriveSubagentPolicy 只收紧 + 递归防护 + 前/后台 steering + `subagent_spawn` 工具，**退出标准②子 agent 崩溃不拖垮主循环达成**）+ **4D recipes/skills 懒加载**（skill 摘要常驻 + `skill_activate` 取全文 + 压缩保护 + subagent recipe profile 经 deriveSubagentPolicy 只收紧）+ **4E 插件 SDK**（独立包 `plugin-host`：第三方插件跑独立 Worker 经 IPC 隔离 + 心跳重连 + 崩溃围栏降级 + secret 剥离 + 工具走主审批流不可绕 + Hook 矩阵跨进程兑现，**退出标准③插件隔离生效达成**）+ **4F 健壮性**（`costUsd` 用量计费串接含 cache 分价 + provider fallback 链/auth rotation：错误归类 `category` 驱动 rate_limit 换 key/billing·auth 换 provider/context_overflow 压缩重试 + 工具循环内 commit 首个成功模型不漂移）已交付 → **六片 4A-4F 全交付 + 整体收口对抗式安全审查（52 agents，confirmed 12 缺陷全修含 3 HIGH），退出标准①②③全达成** → **443 测试**（58 文件）—— 见 [`docs/PHASE-4.md`](docs/PHASE-4.md)。
｜ ✅ **Phase 4.5 交付**（安装分发 + 完整交互式 TUI）：全局命令 `yoagent`（源码态软链分发 + tsx 启动器）+ 私密运行配置 `~/.config/yo-agent/config.env` 自动加载（key 不进 git）+ **TUI 升级为交互式多轮 REPL**（结构化区块渲染 + ink `<Static>` 滚动区 + 状态栏 model/token/成本/cwd + 工具调用分组渲染 + 行内光标编辑 + 输入历史 + `/help /clear /model /cwd /exit` slash 命令 + Esc/Ctrl+C 中断当前轮 + 运行中 steer + 审批面板增强）；内核零改动，复用既有 interrupt/steer 接缝 → **460 测试**（59 文件）—— 见 [`docs/PHASE-4.5.md`](docs/PHASE-4.5.md)。
｜ ✅ **Phase 4.6 交付**（TUI 重设计，五切片 4.6a-e）：surface-cli 分层重构（纯 reducer + keymap 路由 + `tui/` 分层，行为等价）+ 多行输入编辑器（字素簇/括号粘贴/持久历史/退出保护）+ 渲染语言（markdown/diff/工具专属视图 + 去噪 + 活动行）+ 命令系统与补全（slash 注册表 + 补全菜单 + @文件 + 通用选择器）+ 内核接缝 K1-K5（会话/模式/审批升级 + 排队 follow-up）—— 见 [`docs/PHASE-4.6.md`](docs/PHASE-4.6.md)。
｜ ✅ **Phase 4.7 交付**（TUI 架构收敛，六切片 4.7a-f）：输入解码固化为纯状态机 `input/decoder.ts`（ink 私有行为依赖收拢单文件）+ 交互态统一进 reducer + 拆解 app.ts（853→430 行，执行器/契约/footer 各归其位）+ 渲染性能（BlockView memo + spinner tick 隔离 + computeMenu 缓存）+ 功能补口（/resume 历史回放 + 审批队列化 + 审批面板放行 Ctrl+C）—— 见 [`docs/PHASE-4.7.md`](docs/PHASE-4.7.md)。
｜ ✅ **Phase 4.8 交付**（工程卫生与基建补课，五切片 4.8a-e）：README 对齐 + **Biome lint 落地**（linter-only，recommended + react domain，失效 eslint-disable 清零）+ **coverage 度量**（v8，首测全仓行覆盖 85.5%）/apps 纳入测试收集（parseArgs 抽纯函数补测）+ **GitHub Actions CI**（frozen install → typecheck → lint → schema 生成+漂移校验 → test）+ zod 统一单约束/TUI 静默降级出 notice —— 见 [`docs/PHASE-4.8.md`](docs/PHASE-4.8.md)。
｜ 📋 **Phase 4.9 已立项待开工**（Agent 自知与失败可交互，六切片 4.9a-f）：起因真机反馈 [`docs/feedback/4.8.md`](docs/feedback/4.8.md)（LLM 裸猜模型名 404 / 子代理审批静默失败），三路审计定三病根（自知信息只给人不给 LLM / 失败静默化 / 建好未接线）——计划见 [`docs/PHASE-4.9.md`](docs/PHASE-4.9.md)；顺延事项候选池见 [`docs/PHASE-4.10.md`](docs/PHASE-4.10.md)。
验证门全绿：`pnpm run check` = typecheck + lint + gen:schema + **572 测试（68 文件，1 真机冒烟门控跳过）**。

- **Phase 0**（[`PHASE-0.md`](docs/PHASE-0.md)）协议单一事实源 `@yo-agent/protocol` 冻结：`AgentEvent`（20 变体）+ JSON-RPC 方法表 + cursor/resume，zod 定义、导出 JSON Schema（可 gen 多语言 binding 给任意客户端）；四接口冻结。
- **Phase 1**（[`PHASE-1.md`](docs/PHASE-1.md)）内核 + 编程 CLI MVP：`AgentKernel` turn 循环（infer→tool→observe）+ 事件溯源 + 熔断 + `max_tokens` 续传 + 审批；**5 provider**（Anthropic / OpenAI Responses+Chat / Gemini / 兼容含 DeepSeek/Ollama）+ 双轨 tool-calling + 模型目录；内置工具 + L3 checkpoint（shadow-git）；`SummarizingCondenser`；CLI 三态（TUI / `--mode jsonl` / headless）+ yo.md 加载。**真机已验证**。
- **Phase 2**（[`PHASE-2.md`](docs/PHASE-2.md)）协议化暴露：`RpcSurface`（JSON-RPC over JSONL/WS，通用远端驱动）+ resume/reconnect（cursor 缺口填充 + gap 溢出降级 + 审批跨重连存活）+ `McpServerSurface`（被 Claude Code/Cursor 当节点调用）+ **ed25519 + 配对码 + nonce 设备鉴权**。经 5 维对抗式审查加固。
- **Phase 3**（[`PHASE-3.md`](docs/PHASE-3.md)，**七片全交付**）MCP **host**（挂外部 MCP server 用其工具）+ `AcpSurface`（被 Zed/JetBrains 经 ACP 接管）+ 结构化 Handoff / 标识符保真 / 动态 auto-memory。7 切片「护栏底座先行」：3A 工具集稳定性底座 + 3B/3C MCP host 连接/三层信任/韧性（熔断/TTL/重连/连接状态）+ **真机冒烟①达成**（真实 `server-filesystem`，LLM 调其 `read_file`）+ 3D Condenser 结构化交接/标识符保真机制 + 3E 独立 `MemoryStore`/workspace 隔离/@import 防逃逸 + 3F **AcpSurface**（真实 `ClientSideConnection` 离线对驱跑通含审批+fs 的一轮编程对话，退出标准②）+ 3G MCP 进阶通道（resources/prompts/sampling/progress + Streamable HTTP/OAuth）。审查节奏（ADR-14）：3B/3C（接外部连接，高危）已逐片对抗式审查；3D-3G 随 Phase 3 整体收口统一审查。

竞品调研 15 份 + 横向综述见 [`docs/research/`](docs/research/)；全面设计见 [`docs/DESIGN.md`](docs/DESIGN.md)（14 章 + §15 实现补遗 + ADR）。

## 仓库结构（pnpm workspace）

```
yo-agent/
├─ packages/
│  ├─ protocol/     # ★ 单一事实源：AgentEvent + JSON-RPC + cursor/resume（zod → TS + JSON Schema）
│  │  └─ schema/    #   生成的 JSON Schema（给任意远端客户端对接）
│  ├─ provider/     # Provider 抽象 + Fake / Anthropic / OpenAI Responses+Chat / Gemini / 兼容（DeepSeek/Ollama）+ 双轨 tool-calling + 模型目录
│  ├─ tools/        # ToolRegistry + 内置 read/write/ls（声明/执行分离 + availability）
│  ├─ store/        # Memory / Sqlite(node:sqlite) EventLog（append-only）+ ShadowGit checkpoint + ResumeBuffer
│  ├─ kernel/       # AgentKernel turn 循环 + LoopBreaker + SummarizingCondenser + yo.md/记忆加载
│  ├─ auth/         # 设备身份 ed25519 + 配对码 + nonce 握手（Phase 2D）
│  ├─ plugin-host/  # 插件 SDK：第三方插件独立 Worker 经 IPC 隔离 + 心跳重连 + 崩溃围栏降级（Phase 4E）
│  ├─ surface-cli/  # CliSurface：交互式多轮 Ink TUI（纯 reducer + decoder + 审批面板）+ headless + --mode jsonl
│  ├─ surface-rpc/  # RpcSurface：JSON-RPC 2.0 over JSONL/WS（通用远端驱动）+ resume/reconnect
│  ├─ surface-mcp/  # McpServerSurface（yo-agent 作 MCP server 被编排）+ MCP host（挂外部 MCP server 用其工具）
│  └─ surface-acp/  # AcpSurface：被 Zed/JetBrains 经 ACP 接管（Phase 3F）
├─ apps/yo-agent/   # CLI 入口：--tui / headless / rpc / rpc --listen <port>(WS) / mcp-server
└─ docs/{DESIGN,PHASE-0…4,4.5…4.10}.md + feedback/ + research/
```

## 快速开始

```bash
pnpm install        # 需 Node ≥ 20、pnpm 10
pnpm run check      # typecheck + 生成 JSON Schema + 跑测试

# 安装全局命令（Phase 4.5）：软链 yoagent 到 PATH，随 git pull 即时生效
pnpm run install:cli                          # 之后任意目录直接 `yoagent`
# 私密配置（key 不进 git）：~/.config/yo-agent/config.env（权限 600，shell 显式同名变量优先）
#   OPENAI_API_KEY=... / OPENAI_BASE_URL=https://gateway/v1 / YO_MODEL=gpt-5.5
#   （或 ANTHROPIC_API_KEY / GEMINI_API_KEY）

yoagent --tui                    # 交互式多轮 REPL（推荐日常；/help 看命令）
yoagent --tui -p "你的提问"       # 带首问进入，之后多轮
yoagent -p "你的提问"             # headless 单次问答
yoagent --mode jsonl -p "..."    # 结构化 JSONL

# 等价的源码态调用（未装全局命令时，FakeProvider 演示无需 key）
pnpm --filter @yo-agent/cli start -- -p "你的提问"              # headless 文本
pnpm --filter @yo-agent/cli start -- --tui -p "你的提问"        # Ink TUI
pnpm --filter @yo-agent/cli start -- --mode jsonl -p "你的提问"  # 结构化 JSONL

# 接真实 provider（可叠 YO_DB= / YO_COMPACT=1 / YO_CHECKPOINT=1 / YO_MODEL=）
ANTHROPIC_API_KEY=sk-... pnpm --filter @yo-agent/cli start -- -p "用 ts 写个快排"

# 协议化暴露（Phase 2）
pnpm --filter @yo-agent/cli start -- rpc              # JSON-RPC over stdin/stdout（通用远端驱动）
pnpm --filter @yo-agent/cli start -- rpc --listen 8799  # WS server（打印配对码，建议仅经 Tailscale/WireGuard 隧道）
pnpm --filter @yo-agent/cli start -- mcp-server      # 作 MCP server 被 Claude Code/Cursor 调用
```

## 工具链

- **Node ≥ 20 / TypeScript ≥ 5 / pnpm 10**。
- 源码态 workspace（`exports` 指向 `src`，`tsc --noEmit` 类型检查 + vitest），无构建产物；CLI 经 `tsx` 直跑。
