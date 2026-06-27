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
验证门全绿：`pnpm run check` = typecheck + gen:schema + **307 测试（37 文件，1 真机冒烟门控跳过）**。
｜ 📋 **Phase 4 计划已列**（bash 工具集补全 + L1 子进程沙箱 + 子 agent + 插件隔离 —— 开放渠道前的安全底座，6 片 4A-4F；L2 容器/OTel 顺延 Phase 6）—— 见 [`docs/PHASE-4.md`](docs/PHASE-4.md)。

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
│  ├─ surface-cli/  # CliSurface：Ink TUI（交互审批）+ headless + --mode jsonl
│  ├─ surface-rpc/  # RpcSurface：JSON-RPC 2.0 over JSONL/WS（通用远端驱动）+ resume/reconnect
│  └─ surface-mcp/  # McpServerSurface：yo-agent 作 MCP server 被编排（Phase 3 将增 MCP host）
├─ apps/yo-agent/   # CLI 入口：headless / rpc / rpc --listen <port>(WS) / mcp-server
├─ docs/{DESIGN,PHASE-0,PHASE-1,PHASE-2,PHASE-3,PHASE-4}.md + research/
└─ (Phase 3：MCP host · surface-acp · 结构化 Handoff · auto-memory)
```

## 快速开始

```bash
pnpm install        # 需 Node ≥ 20、pnpm 10
pnpm run check      # typecheck + 生成 JSON Schema + 跑测试（145 个）

# CLI 三态（FakeProvider 演示，无需 key）
pnpm --filter @yo-agent/cli start -- -p "你的提问"              # headless 文本
pnpm --filter @yo-agent/cli start -- --tui -p "你的提问"        # Ink TUI（交互审批）
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
