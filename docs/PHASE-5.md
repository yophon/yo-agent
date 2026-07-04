# Phase 5 — WebSurface：浏览器内嵌 agent（客户端智能客服底座）

> **状态：规划中（未实施）。** 本文档是实施计划；交付后按仓库惯例更新为交付报告。
> 路线图变更：原 Phase 5（聊天平台 QQ/Telegram）顺延为 Phase 6，原 Phase 6 内容相应顺延——随 5E 切片同步修订 `DESIGN.md`。

---

## 0. 动机与定位

战略方向：把 yo-agent 内核做成**客户端 agent**，嵌进任意 app/网页（首个场景：智能客服）。后端只需要两样东西：

1. **LLM 代理网关**——把 provider 请求透传给上游模型（key 留在服务端），配上宿主自己的鉴权/配额；
2. **业务 API 按公开 API 标准暴露为工具**——每个工具接口独立做服务端鉴权与校验（agent loop 在客户端跑、完全可被用户篡改，所以任何工具都必须当成用户直接调用来防御）。

鉴权全部复用**宿主 app 自己的机制**（header 令牌 / cookie / JWT），yo-agent 不引入自己的鉴权（`@yo-agent/auth` 不参与本 phase）。

### 双连接模式（同一套配置结构的不同取值）

| 模式 | baseUrl | apiKey | 鉴权 | 工具 |
|---|---|---|---|---|
| **A 自建后端** | 自建 LLM 代理 | 可空 | `headers` 带宿主令牌（或同域 cookie） | 指向后端业务 API |
| **B 中转站直连** | 用户自己的 OpenAI 兼容 / Anthropic 中转站（或官方端点） | 用户自己的 key | key 即鉴权 | **可选**——可零工具纯对话，也可注册自定义工具 |

### 可行性依据（探索已确认）

- `AgentKernel` 纯依赖注入：构造 `kernel.ts:169` 单参数 `AgentKernelDeps`（`kernel.ts:38`），**必填仅 `store / provider / tools / loopBreaker / condenser` 五项且全是接口**；构造期零 I/O。
- 零 Node 依赖可直接进浏览器：`MemoryEventStore`（store/memory.ts）、`ResumeBuffer`（store/resume.ts）、`InMemoryToolRegistry`（tools/registry.ts）、provider 全家（手写 `fetch` + WHATWG `ReadableStream`/`TextDecoder` SSE，无官方 SDK）、kernel 外围纯逻辑（condenser / loop-breaker / tokens / risk / policy / hooks / fallback）、protocol（仅 zod）。
- Node 耦合集中在**可不引入**的外围：kernel 的 subagent(worker_threads) / context-files / skills / recipes / self-knowledge；tools 的 builtins / bash / exec-local；store 的 sqlite / automemory / checkpoint。
- 三个真正的障碍（本 phase 的工作量所在）：
  1. **barrel 陷阱**：各包 `index.ts` `export *` 了 Node-heavy 子模块，且 `kernel.ts` 从 `@yo-agent/tools`、`@yo-agent/store` 的 barrel 值导入（`MAX_PARALLEL_CALLS`/`PARALLEL_TOOL`/`sanitizeMcpServerName`、`ResumeBuffer`）——浏览器打包时 `node:fs`/`node:worker_threads` 在解析期就报错，**不能靠摇树**；
  2. **环境触点**：`kernel.ts` 的 `node:crypto` randomUUID 与 `process.cwd()` 默认值；四个 provider 构造函数里 `opts.apiKey ?? process.env.X`（浏览器 `process` 未定义直接 ReferenceError）；
  3. **provider headers 缺口**：anthropic.ts / gemini.ts 不支持自定义 headers 注入（openai.ts / responses.ts 已支持）——模式 A 的宿主鉴权头、Anthropic 浏览器直连头都靠它。

---

## 1. 退出标准

1. **构建冒烟硬门**：`pnpm run check:browser`——浏览器入口经 esbuild `platform=browser` 打包，**任何 `node:`/Node 内建解析即红**，纳入 `pnpm run check` 与 CI。
2. **真机端到端（模式 A）**：浏览器提问 → demo-backend LLM 代理流式回答 → LLM 调 `order_query` 工具 → 后端校验令牌并返回 mock 数据 → 回答含订单信息；中断（interrupt）与追加引导（steer）可用。
3. **真机（模式 B）**：设置面板填中转站 baseUrl + apiKey + model，零工具纯对话流式跑通。
4. **零回归**：`pnpm run check` 全绿（既有 650 测试 + 本期新增），Node 侧 CLI/TUI/RPC 行为零变化（5A 的补丁全部是行为等价改写或纯加法）。

## 2. 非目标（本期不做，防散架）

- **IndexedDB EventStore**——本期 `MemoryEventStore`，刷新即失。理由：客服会话短；跨设备/持久化本就该由宿主后端承担；协议 cursor/resume 机制已为将来接续预留。真实需求出现再立切片。
- **MCP host / subagent / skills / recipes / plugin-host 进浏览器**——全部不引入。
- **服务端跑内核 + 浏览器瘦客户端**形态——RpcSurface（JSON-RPC + cursor resume）已具备该能力，是高敏场景（资金操作类客服）的正确形态，但属另一条产品线，不在本期。
- **挂件视觉打磨 / 多主题 / 移动端适配**——demo 级样式即可。
- **网关的生产级配额/滥用防护**——demo-backend 只做职责边界示范，文档标注「生产必须补配额与滥用防护」。

---

## 3. 切片（护栏底座先行）

### 5A 浏览器安全入口 + 构建冒烟门

**目标**：不新增任何功能，让「内核 + 纯逻辑外围」能被浏览器 bundler 干净解析，并立起防回归硬门。Node 侧行为零变化。

1. **三个包加 `core` 子路径入口**（命名取「纯逻辑、环境无关核心」，Node 侧同样可用）：
   - `packages/kernel/src/core.ts`：`export type` 转发 `./index` 的全部接口类型（type-only re-export 会被 esbuild 完全擦除，不牵入 barrel 的运行时模块图）+ 值转发 `./kernel` `./loop-breaker` `./condenser` `./tokens` `./risk` `./policy` `./hooks` `./fallback`；**排除** context-files / subagent / self-knowledge / skills / recipes。
   - `packages/store/src/core.ts`：类型转发（`EventStore`/`SessionRow`/`Checkpoint`/`EVENTLOG_SCHEMA_VERSION`）+ 值转发 `./memory` `./resume`；排除 sqlite / automemory / checkpoint。
   - `packages/tools/src/core.ts`：类型转发（`RegisteredTool`/`ToolDescriptor`/`ToolContext`/`ToolEvent`/`ToolRegistry` 等）+ 值转发 `./registry` `./parallel-tool` `./mcp`（sanitizeMcpServerName 在此）；排除 builtins / bash / exec-local / subagent-tool / skill-tool / memory-tool。
   - 各包 `package.json` `exports` 加 `"./core": "./src/core.ts"`；根 `tsconfig.base.json` `paths` 加对应别名（漏了 tsx/vitest/tsc 全解析不到）。
   - provider / protocol 的 barrel 本身就干净，**不加** core 入口。
2. **`kernel.ts` 的跨包值导入切到子路径**：`@yo-agent/tools` → `@yo-agent/tools/core`、`@yo-agent/store` → `@yo-agent/store/core`（Node 侧等价，浏览器侧关键）。
3. **环境防御补丁**（行为等价改写）：
   - `kernel.ts`：删 `node:crypto` import，randomUUID 改用全局 `crypto.randomUUID()`（Node ≥20 全局可用）；`process.cwd()` 默认值改 `globalThis.process?.cwd() ?? '/'`。
   - 四个 provider 构造：`process.env.X` → `globalThis.process?.env?.X`。
   - anthropic.ts / gemini.ts 加 `headers?: Record<string, string>`（照 openai.ts 的 extraHeaders 合并语义）。
4. **构建冒烟门**：
   - `scripts/check-browser.mjs`：esbuild JS API，`platform: 'browser'`、`bundle: true`，自带 resolve 插件读 `tsconfig.base.json` paths；解析到 `node:`/Node 内建即退出非零；顺带打印 bundle 体积（观测项，不设硬门）。
   - 5A 阶段入口先用 fixture（`scripts/browser-smoke-entry.ts`：import kernel/core + store/core + tools/core + provider 并实例化最小内核），5B 落地后追加 `@yo-agent/surface-web` 真入口双 entry。
   - `package.json` 加 `check:browser`，串进 `pnpm run check`；CI 加 step。esbuild 进 devDependencies。

**退出标准**：`check:browser` 绿；`pnpm run check` 全量不回归；`git diff` 审计确认既有包改动仅为上述行为等价项。

### 5B `@yo-agent/surface-web`：createWebAgent + 双模式配置 + defineHttpTool

新包 `packages/surface-web`（配置四件套：包 package.json + tsconfig.json + 根 paths 别名 + `pnpm install`；CI/vitest/biome glob 自动覆盖）。依赖：protocol / provider / kernel / tools / store（均走 core 子路径），**不依赖** auth / surface-mcp / plugin-host。

- `src/config.ts` —— 统一配置结构 + 纯函数解析校验：

  ```ts
  export interface WebAgentConfig {
    connection: {
      provider: 'anthropic' | 'openai' | 'openai-responses' | 'gemini';
      model: string;
      baseUrl?: string;                  // 模式A: 自建代理；模式B: 中转站；缺省: 官方端点
      apiKey?: string;                   // 模式B 必填；模式A 可空（走 headers 鉴权）
      headers?: Record<string, string>;  // 宿主令牌 / anthropic-dangerous-direct-browser-access
    };
    system?: string;                     // 宿主可先 HTTP 拿一段再传入；缺省不注入
    tools?: RegisteredTool[];            // 可选——模式B 可零工具纯对话
    approval?: 'auto' | ApprovalGate;    // 默认 'auto'（客服场景由后端逐工具兜底校验）
    compaction?: boolean;                // true → SummarizingCondenser；默认 NoopCondenser
    loopBreaker?: 'off' | 'loose' | 'strict';  // 默认 loose
  }
  ```

- `src/agent.ts` —— `createWebAgent(config)`：装配 `MemoryEventStore` + `InMemoryToolRegistry`（注册 config.tools）+ 按 connection 实例化 provider + `makeLoopBreaker` + condenser + 自带三行 autoApproveGate（不从 surface-mcp 引），返回 `{ kernel, ... }` 供 ChatController 或直接 `subscribe`/`submitInput` 消费。
- `src/http-tool.ts` —— `defineHttpTool(...)` 助手，把「后端业务 API」降到一个声明：

  ```ts
  defineHttpTool({
    name, description, inputSchema,
    kind = 'fetch',                       // read/search/fetch/think 可批内并发
    url,                                  // 或 request: (input) => ({ url, init }) 自定义式
    method = 'POST', headers,
    mapResponse,                          // (res: Response) => string | Promise<string>，缺省取 text
    approval = 'never',
  }): RegisteredTool
  // executor：fetch(url, { ..., signal: ctx.signal })——必须透传 AbortSignal（中断/超时）；
  // !res.ok → throw（内核统一转 isError tool_result）。
  ```

- 可选项（实施期按需）：provider 透传 `fetchInit?: RequestInit`，支持跨域 cookie（`credentials: 'include'`）。本期默认方案是 headers 令牌 + 同域 cookie 天然可用，跨域 cookie 需求出现再加。
- **单测**：config 解析边界（模式 A/B 取值矩阵、缺 apiKey 且缺 headers 的模式 B 报可行动错误）；defineHttpTool（mock fetch：signal 透传、!ok 转抛、mapResponse）；createWebAgent + FakeProvider 跑通一轮含工具调用。

**退出标准**：单测绿；`check:browser` 以 surface-web 为真入口绿。

### 5C ChatController：headless 事件流 → 聊天状态适配器

- `src/chat-controller.ts`：订阅 `kernel.subscribe(sid, null, cb)`，把 `AgentEvent`（20 变体中消费 text 增量 / tool call / tool result / turn 起止 / error / ApprovalRequested）归约为 UI 无关的聊天状态：

  ```ts
  interface ChatState {
    messages: ChatMessage[];    // { role, parts: (TextPart | ToolPart)[], status: 'streaming'|'done'|'error' }
    turnActive: boolean;
    toolRuns: ToolRunView[];    // { name, input, status: 'running'|'ok'|'error', outputPreview }
    error?: string;
  }
  class ChatController {
    constructor(agent: WebAgent, opts?: { onApproval?: ApprovalHandler });
    readonly state: ChatState;
    onChange(cb: (s: ChatState) => void): () => void;
    send(text: string): Promise<void>;    // submitInput
    interrupt(): void;
    steer(text: string): void;
    newSession(): Promise<void>;
  }
  ```

- `approval: 'auto'` 时不会出现审批事件；宿主配了自定义 gate 时经 `onApproval` 回调上抛（`kernel.decideApproval` 回传），挂件可弹确认条。
- **单测**：FakeProvider 脚本化事件序列 → 断言 state 快照序列（流式增量合并、工具态迁移、中断后落 done/error）。零 DOM 依赖，vitest node 环境直接测。

**退出标准**：controller 单测绿。

### 5D demo：演示后端 + 网页挂件（端到端真机）

- `apps/demo-backend`（零框架，node:http 单文件级）：
  - `POST /v1/messages`（Anthropic 格式）流式透传真实上游——**key 从 server env 读，绝不出现在前端**；SSE 逐 chunk flush（不缓冲）。
  - `POST /api/tools/order_query`、`POST /api/tools/ticket_create`：mock 业务数据 + 简易 header 令牌校验——示范「工具 = 公开 API 标准鉴权」的职责边界。
  - CORS：dev origin 白名单 + preflight。
- `apps/web-demo`（Vite + 原生 TS，不进 CI 运行门，typecheck/lint 覆盖）：
  - `<yo-chat>` 自定义元素（shadow DOM，样式不外溢，可嵌任意宿主页面）消费 ChatController：消息流式渲染、工具调用折叠视图、中断按钮、输入框。
  - 设置面板：模式 A（默认指 demo-backend + 演示令牌）↔ 模式 B（填中转站 baseUrl / apiKey / model，工具开关）；apiKey 默认只留内存，「记住」需显式勾选（localStorage + 明文风险提示）。
- README 快速开始加两条启动命令（backend + demo）。

**退出标准**：即总退出标准 ②③ 的真机验收。

### 5E 文档与路线图收口

- 本文件更新为交付报告；`DESIGN.md` 路线图：Phase 5 → WebSurface（本期），聊天平台顺延 Phase 6，原 Phase 6（L2 容器 / OTel）顺延；README 状态段 + 仓库结构图加 `surface-web` / `web-demo` / `demo-backend`。
- 惯例**对抗式审查**收口，重点面：apiKey 流经路径（内存/存储/日志）、CORS 配置、工具 signal 透传、SSE 在代理链路的边界条件、core 入口是否漏排 Node 模块。

---

## 4. 风险清单

| # | 风险 | 应对 |
|---|---|---|
| 1 | 模式 B 中转站没开 CORS 直连失败 | 文档写清依赖中转站 CORS；官方 Anthropic 需 `anthropic-dangerous-direct-browser-access: true`（headers 可传）；官方 OpenAI 禁浏览器直连——模式 B 主打中转站 |
| 2 | SSE 经反向代理被缓冲成一次性返回 | demo-backend 逐 chunk flush；文档注明生产代理需关缓冲（如 nginx `X-Accel-Buffering: no`） |
| 3 | apiKey 暴露面 | 模式 B 是用户自己的 key，默认只留内存；模式 A 上游 key 只存在于 demo-backend env——结构性示范 |
| 4 | 将来有人往 core 入口依赖里加 `node:` import 回归 | `check:browser` CI 硬门在解析期拦截 |
| 5 | bundle 体积（zod + catalog.json 全进包） | 冒烟脚本打印体积做观测；预估 gzip 数十 KB 量级，超预期再立优化切片 |
| 6 | 中转站不透传 usage / cache_control | provider 已按可选字段处理；ChatController 容忍 usage 缺省，成本显示降级为不显示 |
| 7 | 跨域 cookie 鉴权 provider 未支持 | 本期方案 = headers 令牌（跨域）+ 同域 cookie（天然可用）；强需求再加 `fetchInit` 透传小补丁 |
| 8 | 浏览器流兼容性 | sse.ts 已是 `getReader()` 手动迭代（非 for-await ReadableStream），现代浏览器全兼容——实施时冒烟脚本真机核验 |

## 5. 验证门

- `pnpm run check` = typecheck + lint + gen:schema 漂移校验 + test + **check:browser**（新增）全绿，CI 同步。
- 真机人工验收清单：模式 A 端到端（含工具、中断、steer）+ 模式 B 中转站直连纯对话 + `<yo-chat>` 嵌入一个非 demo 的空白宿主页验证样式隔离。
