# Phase 5.2 — 抄 pi 精华：Env 能力接口 + 进程内可信扩展档

> **状态：规划完成，待实施（2026-07-04）。** 本文档自包含（含全部挂点勘察事实与 pi 参照点），可在全新会话直接按切片实施。交付后按惯例更新为交付报告。

## Context

对 pi（github.com/earendil-works/pi，MIT）的源码研究确认了两个值得抄的设计。已拍板：**不做 pi ExtensionAPI 兼容层**——其 UI 面绑定 pi-tui（官方 68 个示例扩展中 21 个 import pi-tui、11 个用 setWidget 等 UI 面）、API 未冻结（0.80.x，240+ releases），兼容是移动目标；**只把精华抄进自有架构**：

1. **ExecutionEnv 能力接口**：pi 把「内核自身的 I/O 需求」接口化（`packages/agent/src/harness/types.ts:332`：`ExecutionEnv = FileSystem + Shell`；node 实现只在 `harness/env/nodejs.ts` 一个文件；skills/AGENTS.md/模板加载全走接口）。yo-agent 的 `context-files.ts`/`skills.ts`/`recipes.ts` 直接 import node:fs，5A 时被排除出 `/core`——**浏览器场景因此没有 skills/约定文件能力**。接口化后它们变纯逻辑、进 core，Web 控制台的 agent 解锁 skills。
2. **进程内可信扩展档**：pi 的扩展（jiti 加载用户 TS + 30 个生命周期事件 + registerTool/Command/Shortcut/Flag 等富注册面）是其生态引擎。yo-agent 现有 plugin-host 是**跨进程不可信档**（Worker+IPC、仅 .mjs、贫 API——`plugin-host/src/worker-entry.mjs:2` 注明是绕开 worker+tsx 脆弱性），缺一个低摩擦**可信档**。做**自有 API**（`defineExtension`），能力面对齐 pi 但不背其 API 包袱。

pi 的第三样精华——**会话 DAG 兑现**（每条 entry `parentId: getLeafId()` 真实挂树，fork/tree/分支摘要全链路；yo-agent 的 `EventEnvelope.parentId` 在 `kernel.ts` doEmit 恒填 null、fork 未实现）——**不进本期**，列为 Phase 5.3 候选。

## 挂点勘察事实（实施依据，已逐一真实核查）

- **PreToolUse hook 已支持拦截/改写**：`packages/kernel/src/hooks.ts:34-35` 返回 `{decision:'allow', input?} | {decision:'deny', reason?}`；多 hook 链式（deny 短路、allow{input} 链传，hooks.ts:105-121）；**fail-closed**（hook 抛错=deny）。其余 8 个观测型 hook（SessionStart/UserPromptSubmit/PostToolUse/PreCompact/Stop/SubagentStart/SubagentStop/OnApproval）fail-open。注册 `kernel.registerHook(h): ()=>void`（kernel.ts:182，装配先例 main.ts:267）。`HookContext` 仅 `{sessionId, cwd, permissionMode}`（hooks.ts:22-26）——扩展要富上下文需闭包旁路持 kernel 句柄。
- **工具运行时增删已闭环**：`registry.register/unregister`（撞名抛错，registry.ts:15/28）；内核每 turn 起点 `resolveAvailable` 拿快照（kernel.ts:449），增删下一 turn 生效；4.9d toolset diff 自动向 LLM 注入 `[系统状态]` 提醒（kernel.ts:1258-1272），无需新接缝。
- **ExecBackend 接口现成**：`packages/tools/src/exec.ts:31`（`exec(cmd, {cwd, env?, signal?, background?}): AsyncIterable<ExecChunk>`，ExecChunk 末帧带 exitCode）；L1 实现 `LocalSubprocessExecBackend`（exec-local.ts:40，进程组/secret 剥离/abort 杀组）。**但被 bashTool 硬编码私藏**（bash.ts:81 `makeBashTool(new LocalSubprocessExecBackend())` 经 builtinTools 注册）——需提为装配层共享单例。
- **主进程动态 import TS 天然可行**：CLI 经 `--import tsx/dist/loader.mjs` 全局注册 ESM loader（apps/yo-agent/bin/yoagent.mjs:42-64，含 TSX_TSCONFIG_PATH）→ 主线程 `await import('/abs/foo.ts')` 直接成立（@yo-agent/* 别名也解析）。vitest 下同样成立（vite-tsconfig-paths，先例 tui-editor.test.ts:104）。注意：plugin-host 的 Worker「仅 .mjs」限制是 Worker 线程不继承 loader 所致，**不适用于进程内档**。
- **TUI slash 命令表硬编码**：`surface-cli/src/tui/commands.ts:73 buildCommands()` 声明式数组（`SlashCommand {name, aliases?, desc, run(deps, args)}`，commands.ts:65-71），`runTui`/`app.ts:102 commandsRef` 无外部注入口——**registerCommand 需新增 extraCommands 接缝**。补全与 /help 同源（commands.ts:319），接缝加对即自动带上。通用选择器已有（`PickerState` model.ts:58-63 + `openPicker` commands.ts:34，/model /mode /resume 都在用）；free-text input 面板没有（本期不做）。
- **followUp 队列只在 TUI 本地**（app.ts:207-221 监听 turn 完成、`lastStop==='end_turn'` 才出队；UiState.queue model.ts:105）——扩展档的 `followUp()` 自建：订阅 `TurnCompleted{stopReason:'end_turn'}`（kernel.subscribe 现成）后 `submitInput`。
- **systemSuffix 在 startSession 求值一次**（kernel.ts:193-199；`AgentKernelDeps.systemSuffix?: string | ((info: SessionSelfInfo)=>string)` kernel.ts:80），装配用 `composeSystemSections`（self-knowledge.ts:128，可变参拼接，main.ts:186-207 先例）——扩展 system 片段静态收集可直接拼；会话中途动态注入不做（`pushStatusNote` 是 private，kernel.ts:1254）。
- **加载目录/信任范式**：skills/recipes/plugins 均为 `~/.yo-agent/<kind>` + `<wsRoot>/.yo-agent/<kind>` 双目录、global 前 project 后（main.ts:112-155；wsRoot=findWorkspaceRoot(cwd)）；目录发现逻辑可抄 `loadPluginSpecs`（plugin-host/src/loader.ts:22-57，ENTRY 名单需加 .ts/.mts）；项目信任门范式照 `~/.yo-agent/mcp-trust.json`（main.ts:294 loadTrustedProjectServers）。plugin-host 的 owner/approval 钳制范式在 host.ts:281-292（owner:'plugin'、approval 钳制非 never、availability 绑健康 flag `plugin:<id>` 复用 3C 熔断显隐）。

## 切片

### 5.2a EnvAdapter：内核 I/O 需求接口化（浏览器解锁 skills）

- `packages/kernel/src/env.ts`（新，纯逻辑）：窄 `FileSystem` 接口——**按 context-files/skills/recipes 的真实 fs 调用裁剪定稿**，不照抄 pi 的 15 方法。预估：`readTextFile / listDir / stat(isFile/isDirectory) / exists / realpath`（@import 防逃逸需要 realpath 语义）。接口 + `MemoryFileSystem`（测试/浏览器注入用）**进 core**。
- `packages/kernel/src/env-node.ts`（新，Node 面）：`NodeFileSystem`（把三文件现有 node:fs 调用语义原样搬入）。**不进 core**，从主入口 index.ts 导出。
- **行为等价重构**：`context-files.ts` / `skills.ts` / `recipes.ts` 注入 `fs: FileSystem`（签名加参或 opts），删文件内 node: 导入 → 变纯逻辑 → **加入 `kernel/src/core.ts` 导出**；`main.ts` 调用点改传 `new NodeFileSystem()`。既有 3E（context-files/@import 防逃逸）/4D（skills）测试改喂 NodeFileSystem 后必须全绿。
- surface-web：`WebAgentConfig` 加 `contextFs?: FileSystem`（可选）——有值时装配层可用 loadSkills/loadConventionFiles 组 system。最小演示 = 一个测试：MemoryFileSystem 装 skill → 浏览器面装配能把技能摘要进 system。
- **ExecBackend 单例提升**（并入本片，小改）：main.ts 构造共享 `LocalSubprocessExecBackend`，喂 `makeBashTool(execBackend)` + 留给 5.2b；以 git diff 最小为准调整 builtins 注册方式。
- `check:browser` 自动守护（core 图扩大后仍须无 node:）。

### 5.2b `@yo-agent/extension-host`：进程内可信扩展档

新包 `packages/extension-host`（配置四件套：包 package.json/tsconfig + 根 tsconfig.base.json paths + pnpm install）。**与 plugin-host 分层并列**：plugin-host = 跨进程不可信（Worker/IPC/仅 .mjs），extension-host = 进程内可信（主进程/富 API/TS 直载）。共享同一 ToolRegistry/HookBus。

- `sdk.ts` 作者面（API 草案，实施可微调）：

  ```ts
  export function defineExtension(setup: (yo: ExtensionApi) => void | Promise<void>): ExtensionModule;
  export interface ExtensionApi {
    // 注册面
    registerTool(tool: RegisteredTool): void;          // owner 钳制 'plugin'、approval 钳制非 never、availability 绑 ext:<name> 健康 flag（照 plugin-host/host.ts:281-292 范式）
    registerCommand(cmd: { name: string; desc: string; run(ctx: CommandCtx, args: string): Promise<void> }): void;  // → TUI extraCommands
    addSystemSection(section: string | ((info: SessionSelfInfo) => string)): void;  // startSession 时经 composeSystemSections 拼入
    // 生命周期（直通 HookBus 9 点，PreToolUse 可拦/改 input）
    on(hooks: Hooks): void;
    // 事件流（22 变体 AgentEvent，比 pi 的事件面更细）
    onEvent(cb: (env: EventEnvelope) => void): void;   // 宿主桥接 kernel.subscribe
    // 行动面
    exec(cmd: string, opts?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<{ output: string; exitCode: number }>;  // → 共享 ExecBackend（AsyncIterable 收敛为整段）
    steer(sessionId: Id, text: string): Promise<void>;
    followUp(sessionId: Id, text: string): void;       // 自建队列：TurnCompleted{end_turn} 后 submitInput；interrupted/failed 不触发
    log(msg: string): void;                            // → onWarn/notice 通道
  }
  ```

- `loader.ts`：发现（抄 loadPluginSpecs 范式；目录 `~/.yo-agent/extensions` + `<wsRoot>/.yo-agent/extensions`；ENTRY `<name>.ts|.mts|.mjs` 或 `<name>/extension.ts|...`）→ **项目信任门**（全局目录默认信任；项目目录扩展首次加载交互确认并落 `~/.yo-agent/extension-trust.json`，headless 未信任则跳过 + onWarn——照 mcp-trust 范式）→ 主进程 `await import` → 调 default export 的 setup(api)。
- `host.ts`：`ExtensionHost`——聚合注册物；**崩溃围栏**（单扩展 import/setup 抛错 → onWarn + 跳过，不拖垮启动）；hook 错误沿用 HookBus 既有语义；健康 flag `ext:<name>` 喂 kernel.toolFlags。
- 装配（main.ts buildKernel 内、new AgentKernel 后）：`kernel.registerHook(extHost.hooks())`；systemSuffix 闭包追加 `...extHost.systemSections()`；`extHost.bindKernel(kernel)`（steer/followUp/onEvent 桥接）。
- **TUI extraCommands 接缝**（surface-cli 小改）：`buildCommands(extra: SlashCommand[] = [])` 合并（撞名内置优先 + onWarn），runTui 增 opts 透传；补全/help 同源自动带上。

### 5.2c 示例扩展 + 收口

- `examples/extensions/`（仓库内示例，不自动加载，兼作集成测试 fixture）：① dirty-repo-guard 等价物（onPreToolUse 拦 bash + exec 查 git status——参照 pi 官方示例 `packages/coding-agent/examples/extensions/dirty-repo-guard.ts`）；② 自定义工具 + slash 命令 + addSystemSection；③ steer/followUp 用法。
- 测试：loader 发现/信任门/坏扩展围栏（fixture .ts 动态 import）；ExtensionApi 各面行为（registerTool 钳制、PreToolUse 拦截链、followUp 仅 end_turn 触发）；EnvAdapter 等价（既有 3E/4D 测试喂 NodeFileSystem 全绿 + MemoryFileSystem 新用例）；check:browser。
- 对抗式审查重点：主进程跑用户 TS 的信任门与围栏、EnvAdapter 迁移的路径语义等价（尤其 @import 防逃逸的 realpath）、extraCommands 撞名、followUp 双队列语义。
- 文档：本文件转交付报告 + **docs/research/pi.md 修订**（四包→五包实测：agent 8,098 行/ai 36,133/coding-agent 51,545/orchestrator 1,987/tui 12,118；ExecutionEnv 三层机制实测；扩展事件实测 30 个；兼容层否决记录及理由）+ README/DESIGN 更新（Phase 5.2 段 + Phase 5.3 DAG 候选）。

## 非目标

- pi ExtensionAPI 兼容（已否决）；pi-tui 类 UI 定制面（setWidget/主题/渲染器）。
- free-text input 通用面板（扩展先用 PickerState 映射的 select/confirm）。
- 会话中途动态 system 注入（pushStatusNote 公开化）——静态 addSystemSection 够用。
- DAG/fork/tree 兑现 → Phase 5.3 候选。
- 浏览器运行时加载扩展（动态 import TS 是 Node 能力）；web 侧仅保证 sdk 类型面无 node: 导入、进 check:browser 图，构建期静态引入理论成立即可，不做 web 演示。
- 扩展包分发（npm/git 安装）——目录放置即用，分发工具后续。

## 风险与应对

| 风险 | 应对 |
|---|---|
| 主进程跑用户 TS = 任意代码执行 | 定位就是「可信档」（与 pi 同立场）+ 项目信任门（首次确认落 trust.json）+ 文档醒目声明；不可信场景继续用 plugin-host |
| EnvAdapter 迁移破坏 @import 防逃逸/路径语义 | realpath 语义进接口；既有 3E 测试原样跑 NodeFileSystem；审查重点项 |
| context-files/skills 进 core 后 barrel 牵入 node: | NodeFileSystem 单独文件不进 core；check:browser 硬门拦截 |
| 扩展 hook 抛错拖垮 turn | HookBus 既有语义（PreToolUse fail-closed / 观测 fail-open）+ 加载围栏 onWarn |
| extraCommands 与内置撞名 | 内置优先 + onWarn，不静默覆盖 |
| followUp 双队列（扩展档 vs TUI queue）语义混淆 | 扩展档只认 `end_turn`（与 TUI app.ts:212 同判据）；文档写明两者独立 |

## 验证

- `pnpm run check` 全绿（typecheck 三 project + lint + gen:schema + check:browser + 全量测试；新增 extension-host/env 测试）。
- 既有测试零回归重点：3E（context-files/@import）、4D（skills）、4B（bash 工具）——EnvAdapter/ExecBackend 提升是行为等价重构。
- 真机验收：示例扩展放 `~/.yo-agent/extensions` → `yoagent --tui` 启动（项目目录扩展应见信任确认）→ 自定义工具被 LLM 调用 + 自定义 /命令 生效（含补全与 /help）+ PreToolUse 拦截真实阻断一次 bash；surface-web 的 MemoryFileSystem skills 测试通过。

## 附：pi 参照点（研究时真实核查，实施如需重查可 `git clone --depth 1 https://github.com/earendil-works/pi /tmp/pi-src`）

- Env 接口：`packages/agent/src/harness/types.ts:332`（ExecutionEnv）+ FileSystem 接口同文件 + `harness/env/nodejs.ts`（唯一 node 实现，569 行）；核心包双入口 `src/index.ts`（纯）/`src/node.ts`（+NodeExecutionEnv）。
- Harness 装配：`harness/types.ts:798 AgentHarnessOptions`（env/session/models/tools/resources/systemPrompt 可为函数）。
- 扩展系统：`packages/coding-agent/src/core/extensions/{types,loader,runner}.ts`（types 1,638 行；30 事件；loader 用 jiti 并预绑定 pi 包）；官方示例 68 个在 `packages/coding-agent/examples/extensions/`（API 使用分布：registerCommand 30 / registerTool 15 / pi-tui 21 / node: 10）。
- 内置工具的现实妥协：`core/tools/read.ts` 直连 node:fs + `ReadOperations` 按工具覆写接口（SSH 委托用）——工具不写在 ExecutionEnv 上，验证了「产品层工具 Node 直连」与「内核 I/O 接口化」可以并存。
- 设计立场原文：`packages/coding-agent/README.md:491-501`（No MCP / No sub-agents / No permission popups / No plan mode / No to-dos / No background bash——全部指向扩展）。
