# Phase 5 — WebSurface：浏览器内嵌 agent（客户端智能客服底座）

> **状态：✅ 已交付（2026-07-04，五切片 5A-5E + 对抗式审查收口）。**
> 路线图变更：客户端 agent 战略插队为 Phase 5；原 Phase 5（聊天平台 QQ/Telegram）顺延为 Phase 6，原 Phase 6 顺延为 Phase 7（`DESIGN.md` 已同步）。

---

## 0. 动机与定位

战略方向：把 yo-agent 内核做成**客户端 agent**，嵌进任意 app/网页（首个场景：智能客服）。后端只需要两样东西：

1. **LLM 代理网关**——把 provider 请求透传给上游模型（key 留在服务端），配上宿主自己的鉴权/配额；
2. **业务 API 按公开 API 标准暴露为工具**——每个工具接口独立做服务端鉴权与校验（agent loop 在客户端跑、完全可被用户篡改，所以任何工具请求对后端都等价于用户直接调用）。

鉴权全部复用**宿主 app 自己的机制**（header 令牌 / cookie / JWT），yo-agent 不引入自己的鉴权（`@yo-agent/auth` 不参与）。对标 CopilotKit / assistant-ui / Vercel AI SDK 的「客户端跑 loop」形态——差异化在内核厚度（审批链 / 熔断 / 压缩 / resume 协议 / 事件溯源）。

### 双连接模式（同一套配置结构的不同取值，无模式开关字段）

| 模式 | baseUrl | apiKey | 鉴权 | 工具 |
|---|---|---|---|---|
| **A 自建后端** | 自建 LLM 代理 | 可空（代理侧注入） | `headers` 宿主令牌 / 同域 cookie | 指向后端业务 API |
| **B 中转站直连** | 用户自己的 OpenAI 兼容 / Anthropic 端点 | 用户自己的 key | key 即鉴权 | **可选**——零工具纯对话或自定义 |

### 可行性依据（5A 前探索确认，交付后依然成立）

- `AgentKernel` 纯依赖注入（`kernel.ts` 构造单参数 deps，必填仅 `store/provider/tools/loopBreaker/condenser` 五接口），构造期零 I/O；
- 零 Node 依赖可直接进浏览器：`MemoryEventStore`、`ResumeBuffer`、`InMemoryToolRegistry`、provider 全家（手写 fetch + WHATWG SSE，无官方 SDK）、kernel 纯逻辑外围（condenser/loop-breaker/tokens/risk/policy/hooks/fallback）、protocol；
- 三个真实障碍（即本期工作量）：barrel `export *` 把 Node 模块拉进模块图（kernel.ts 还从 tools/store barrel 值导入）、kernel/provider 的 `node:crypto`/`process` 触点、anthropic/gemini 缺 headers 注入。

## 1. 退出标准 → 达成情况

| # | 标准 | 结果 |
|---|---|---|
| ① | `check:browser` 硬门（esbuild platform=browser，node: 触点解析期即红）进 check 链与 CI | ✅ 双入口（fixture + surface-web）打包干净，461.7 KB 未压缩观测 |
| ② | 真机模式 A：浏览器侧装配 → 代理流式回答 → LLM 调工具 → 后端校验令牌返回 → 数据进答案 | ✅ gpt-5.5（中转站上游）：调 `order_query` → 「订单 42 已发货，预计明天 18:00 前送达」；`scripts/e2e-web-mode-a.ts` 留作真机冒烟 |
| ③ | 真机模式 B：中转站直连零工具纯对话 | ✅ 直连 OPENAI_BASE_URL 中转站跑通 |
| ④ | 全量 check 零回归 | ✅ typecheck（双 project）+ lint + gen:schema + check:browser + **685 测试**全绿；审查证实 Node CLI 路径零回归 |

## 2. 切片交付摘要

### 5A 浏览器安全入口 + check:browser 冒烟门（护栏先行）

- **`/core` 子路径入口 ×3**：`kernel/src/core.ts`（接口类型 type-only 转发——打包期整体擦除不牵 barrel 运行时模块图 + kernel/loop-breaker/condenser/tokens/risk/policy/hooks/fallback 值转发）、`store/src/core.ts`（memory/resume）、`tools/src/core.ts`（registry/mcp/parallel-tool）；包 `exports` 加 `"./core"`，根 `tsconfig.base.json` paths 加别名。
- **kernel.ts 跨包值导入切子路径**（`@yo-agent/tools/core`、`@yo-agent/store/core`）——否则浏览器打包解析期即死于 barrel 里的 `node:fs`。
- **环境防御**（行为等价）：`node:crypto` randomUUID → 全局 `crypto.randomUUID()`（Node ≥20 全局可用）；`process.cwd()` / provider 构造的 `process.env.*` → `globalThis.process?.…` 可选链。
- **provider 补强**：anthropic/gemini 加 `headers` 注入（openai 系已有）；四家统一「自定义 baseUrl 时空 key 不早退、鉴权头仅在有 key 时携带」——模式 A（代理注 key）与 Ollama 类无鉴权端点由此可用。审查实测官方端点+key 老路径 headers 逐字节等价。
- **`scripts/check-browser.mjs`**：esbuild JS API + 自建 tsconfig-paths 插件（与 tsx/vitest/tsc 同一事实源），`platform:'browser'` bundle，node: 内建解析失败即退出非零；进 `pnpm run check` 与 CI；顺带打印 bundle 体积（观测项）。

### 5B `@yo-agent/surface-web`

- `config.ts`：`WebAgentConfig` 双模式统一配置 + 纯函数解析校验（错误全可行动：缺 model / 未知 provider / 无 baseUrl 且无 key）；`providerOverride` 注入口（测试 FakeProvider / 自定义协议）。
- `agent.ts`：`createWebAgent` 组合根——全走 core 面装配（MemoryEventStore + InMemoryToolRegistry + makeLoopBreaker + Noop/SummarizingCondenser + 模型目录 usableContextTokens/costEstimator）；缺省 `approval:'auto'`（autoApproveGate——防线在后端工具 API 的服务端鉴权，客户端审批 UI 不是防线）；宿主要审批 UI 传自定义 `ApprovalGate`；auto + `approval:'always'` 工具并存时 console.warn 出声（审查 S3）。
- `http-tool.ts`：`defineHttpTool` 把后端业务 API 降到一个声明——POST JSON / GET query 平铺（嵌套值 JSON 序列化，审查 C3）/ headers 函数式令牌轮换 / credentials / `request` 自定义式 / `mapResponse`；`ctx.signal` 透传 fetch（中断/超时可取消）；`!ok` 抛错 → 内核转 isError tool_result。

### 5C `ChatController`

headless 事件流→聊天状态归约：`ChatState`（user/assistant 消息 + text/tool part、流式增量合并、工具 running→ok/error 态与 output 累积、TurnFailed 落 error 文案、usage/costUsd 跨 turn 累计），`onChange` 订阅制零 DOM——任意宿主 UI 可接；`send`（resolve 于 turn 结束，turn 内失败经事件落状态不抛）/ `steer` / `interrupt` / `newSession` / `dispose`。turn 收尾收敛**所有**残留 streaming 态（steer 插话交错场景，审查 C2）。

### 5D 端到端 demo

- `apps/demo-backend`（零框架 node:http）：`POST /v1/*` 流式透传上游（key 只在服务端 env；逐 chunk flush + `x-accel-buffering: no` 示范；客户端断开 `reader.cancel()`，审查 S5；已发头后出错 destroy 防进程崩，审查 C1）+ `/api/tools/order_query`、`/api/tools/ticket_create`（**每端点独立令牌校验**——「工具=公开 API」职责边界示范）+ CORS/preflight。
- `apps/web-demo`（Vite + 原生 TS）：`<yo-chat>` shadow DOM 自定义元素（样式不外溢可嵌任意宿主页）消费 ChatController——流式气泡/工具折叠视图/中断/新对话/用量条；设置面板双模式切换；模式 B key 默认只留内存，「记住」显式勾选才落 localStorage（明文警示）。web-demo 用独立 tsconfig（DOM lib）串进根 typecheck。
- **vite build：129.7 KB / gzip 36 KB**——整个 agent 内核（loop/审批链/熔断/压缩/双轨 tool-calling/模型目录）进浏览器的体积。

### 5E 收口

DESIGN.md 路线图顺延 + README（定位句/状态段/结构图/快速开始）+ 本文档 + **对抗式审查**（全量 diff，含实测探针）：**3 个 CONFIRMED 缺陷全修**（C1 demo-backend 流中断进程崩溃 / C2 steer 幽灵 streaming 态 / C3 GET 嵌套参数静默 `[object Object]`，前两者补回归测试），4 项低成本加固随手落（S3 auto+always 警告 / S4 core 注释纠偏 / S5 断开取消上游 / S8 JSON 注释约束），Node 侧回归三大担忧全部证伪（provider 老路径逐字节等价 / core 导出无漏 / 三链路解析全通）。

## 3. 遗留与非目标（原样成立）

- **IndexedDB EventStore** 未做：MemoryEventStore 刷新即失；客服会话短、持久化本该宿主后端承担；协议 cursor/resume 已预留接续。真实需求出现再立切片。
- MCP host / subagent / skills / plugin-host 不进浏览器；挂件视觉打磨不做（demo 级，全量 innerHTML 重渲染的 details 展开态丢失等已知，ChatController 增量归约未锁死宿主自行 diff 渲染）。
- 已知边界（审查记录在案）：`crypto.randomUUID` 需 secure context（http 非 localhost 宿主页不可用）；模式 B 依赖中转站 CORS；官方 Anthropic 直连自动带 `anthropic-dangerous-direct-browser-access` 头；生产网关必须补配额/滥用防护（demo 头注已声明）。
- 服务端跑内核 + 浏览器瘦客户端（高敏场景形态）：RpcSurface 既有能力，另立产品线。

## 4. 验证门

- `pnpm run check` = typecheck（根 + web-demo DOM 工程）+ lint + gen:schema 漂移校验 + **check:browser** + **685 测试（84 文件，1 真机冒烟门控跳过）** 全绿；CI 同构。
- 真机：`pnpm --filter @yo-agent/demo-backend start`（配 UPSTREAM_BASE/UPSTREAM_KEY）+ `pnpm --filter @yo-agent/web-demo dev` → 浏览器 http://localhost:5177 双模式可视验收；无头冒烟 `TSX_TSCONFIG_PATH=tsconfig.json pnpm exec tsx scripts/e2e-web-mode-a.ts`。
