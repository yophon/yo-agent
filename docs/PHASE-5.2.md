# Phase 5.2 — 抄 pi 精华：Env 能力接口 + 进程内可信扩展档（交付报告）

> **状态：已交付（2026-07-04）。** 三切片 5.2a/b/c 全部完成；`pnpm run check` 全绿（typecheck 三 project + lint +
> gen:schema + check:browser + 743 测试）。提交：f57a6dc（5.2a）、24d8fe8（5.2b）、本提交（5.2c 收口 + 审查修复）。

## Context（规划时拍板，交付未变）

对 pi（github.com/earendil-works/pi，MIT）的源码研究确认了两个值得抄的设计。**不做 pi ExtensionAPI 兼容层**——其 UI 面绑定 pi-tui（官方 68 个示例扩展中 21 个 import pi-tui、11 个用 setWidget 等 UI 面）、API 未冻结（0.80.x，240+ releases），兼容是移动目标；**只把精华抄进自有架构**（否决记录与源码实测已沉淀进 [`research/pi.md`](research/pi.md) §12）：

1. **ExecutionEnv 能力接口** → 5.2a EnvAdapter：pi 把「内核自身的 I/O 需求」接口化（`packages/agent/src/harness/types.ts:332`：`ExecutionEnv = FileSystem + Shell`；node 实现只在一个文件；skills/AGENTS.md/模板加载全走接口）。yo-agent 的 `context-files.ts`/`skills.ts`/`recipes.ts` 曾直接 import node:fs，5A 时被排除出 `/core`——浏览器场景因此没有 skills/约定文件能力。接口化后它们变纯逻辑、进 core，Web 面解锁 skills。
2. **进程内可信扩展档** → 5.2b `@yo-agent/extension-host`：pi 的扩展（jiti 加载用户 TS + 30 个生命周期事件 + 富注册面）是其生态引擎。yo-agent 既有 plugin-host 是**跨进程不可信档**（Worker+IPC、仅 .mjs、贫 API），缺一个低摩擦**可信档**。做**自有 API**（`defineExtension`），能力面对齐 pi 但不背其 API 包袱。

pi 的第三样精华——**会话 DAG 兑现**（每条 entry `parentId` 真实挂树，fork/tree/分支摘要全链路；yo-agent 的 `EventEnvelope.parentId` 在 kernel doEmit 恒填 null、fork 未实现）——**不在本期**，列为 Phase 5.3 候选（已记入 DESIGN 路线图）。

## 交付内容

### 5.2a EnvAdapter：内核 I/O 需求接口化（f57a6dc）

- **`packages/kernel/src/env.ts`（core）**：窄 `FileSystem` 接口——按三文件真实 fs 调用裁剪定稿（非照抄 pi 15 方法）：`readTextFile / writeTextFile / listDir / stat(size/isFile/isDirectory) / exists / realpath`（realpath 承载 @import 防逃逸语义；缺失路径抛错，调用方 try/catch 走跳过/fail-closed 分支）。附 `MemoryFileSystem`（虚拟 POSIX 树：目录由文件路径隐式派生、`'/'` 恒存在、realpath=规范化+存在性校验）。
- **`packages/kernel/src/env-node.ts`（不进 core）**：`NodeFileSystem` 原样搬入三文件既有 node:fs 语义；仅主入口 index.ts 导出。
- **`packages/kernel/src/paths.ts`（core，新）**：纯 POSIX 路径助手（normalizePath/joinPath/dirnamePath/resolvePath/isWithinPath）——core 模块禁 node:path（check:browser 硬门），语义对齐 node:path.posix。`Buffer.byteLength` → `TextEncoder`（`utf8ByteLength`，含孤立代理项等价）。
- **行为等价重构**：context-files/skills/recipes 注入 `fs` 首参、删全部 node: 导入、进 `core.ts` 导出；`findWorkspaceRoot` async 化（existsSync→fs.exists）。既有 3E（@import 防逃逸）/4D（skills）测试喂 `NodeFileSystem` 原样全绿 = 等价回归门。
- **顺手修正**：@import 逃逸检查的 `workspaceRoot='/'` 边界——原 `real.startsWith(wsReal + sep)` 在根 workspace 产生 `'//'` 前缀全量误拒（Node 场景 wsRoot 从不为 `/` 故未暴露；MemoryFileSystem 场景 `/` 是常态），`isWithinPath` 收口。
- **surface-web**：`WebAgentConfig.contextFs?: FileSystem`——惰性一次加载（首个 startSession await）：`'/'` 起约定链 + MEMORY.md/@import（同 CLI 语义）+ `/.yo-agent/skills` 摘要进 system、注册 `skill_activate`（tools/core 补收 skill-tool）、失败降级出声。
- **ExecBackend 单例提升**：`makeBuiltinTools(execBackend)`（缺省自建保兼容）；main.ts 构造共享 `LocalSubprocessExecBackend` 喂 bash 并经 buildKernel 返回——bash 工具与扩展档 exec 面同一沙箱档/secret 剥离策略。

### 5.2b `@yo-agent/extension-host`：进程内可信扩展档（24d8fe8）

新包，与 plugin-host **分层并列**：plugin-host = 跨进程不可信（Worker/IPC/仅 .mjs/贫 API），extension-host = 进程内可信（主进程/富 API/TS 直载/零 IPC 开销）。共享同一 ToolRegistry/HookBus。

- **`sdk.ts` 作者面**：`defineExtension(setup)`（default export；`isExtensionModule` 校验标记防任意对象误当扩展）。`ExtensionApi`：
  - `registerTool`——钳制照 plugin-host 范式：owner 强制 `'plugin'`、approval 绝不 `'never'`（never→risk-based，always 保留）、availability 绑 `ext:<name>` 健康 flag、拒 `mcp__` 保留前缀；撞名注册失败告警不抛。
  - `registerCommand`——归一 `/` 前缀；扩展间撞名先到先得 + 告警。
  - `addSystemSection`——静态串或 `(SessionSelfInfo)=>string`；startSession 时经 composeSystemSections 拼入（host.renderSystemSections 逐段独立求值围栏，单段抛错不毁其余自知注入）。
  - `on(hooks)`——直通内核 HookBus 九点（PreToolUse fail-closed 可拦/改 input、观测型 fail-open，不另立语义）。
  - `onEvent(cb)`——22 变体 AgentEvent 全量订阅；host 内部 SessionStart hook 自动接新会话订阅（幂等）；单回调抛错告警不断流。
  - `exec(cmd, {cwd?, signal?, timeoutMs?})`——走共享 ExecBackend，AsyncIterable 收敛整段 `{output, exitCode}`；timeoutMs 与外部 signal 组合成单 AbortSignal。
  - `steer` 直通；`followUp` 自建每会话队列——**仅 `TurnCompleted{stopReason:'end_turn'}` 出队一条**（判据与 TUI app.ts 队列一致，两队列相互独立互不可见）；resume 会话无 SessionStart hook，followUp 调用时兜底订阅。
- **`loader.ts`**：双目录发现（`~/.yo-agent/extensions` global 前 + `<wsRoot>/.yo-agent/extensions` project 后，同名 project 覆盖；ENTRY `<name>.ts|.mts|.mjs` 或 `<name>/extension.*`）+ 项目信任门（`~/.yo-agent/extension-trust.json`，`{"<projectDir>": ["name"]}` 同 mcp-trust 形制；损坏清单 load 抛错→调用方 fail-closed 空集，save 重建）。
- **`host.ts`**：崩溃围栏——单扩展 import（语法错/依赖缺）/setup 抛错 → log + 跳过；其间已注册的工具因 `ext:<name>` 不在 `flags()`（仅成功加载者有）自动从 resolveAvailable 消失，免回滚反注册（复用 3C 熔断显隐）。
- **装配（main.ts buildKernel）**：new ExtensionHost（共享 execBackend）→ new AgentKernel（systemSuffix 闭包追加 `...extHost.renderSystemSections(info)`，晚求值时扩展已加载）→ `extHost.bindKernel(kernel)` → 发现 → 信任门（**TUI+TTY**：Ink render 前 readline y/N 确认落 trust.json；rpc/acp/mcp-server 的 stdin 是协议通道 + headless：跳过 + 告警）→ `extHost.load(specs)`；`allFlags` 并入 `extHost.flags()`。
- **TUI extraCommands 接缝（surface-cli）**：`buildCommands(extra, onClash)`——与内置撞名（含别名双向）内置优先 + 告警不静默覆盖；/help 闭包引用合并后数组 = 帮助与补全同源自动带上；`CliAppProps.extraCommands` 透传，app.ts 挂载时报撞名 notice；main.ts 把 `ExtensionCommand` 适配成 `SlashCommand`（ctx 收敛为 `{sessionId, notice}`，extension-host 与 surface-cli 互不依赖）。
- **主进程直载 TS 依据**：CLI 经 `--import tsx/dist/loader.mjs` 全局注册 ESM loader（bin/yoagent.mjs，含 TSX_TSCONFIG_PATH → `@yo-agent/*` 别名解析）；plugin-host 的「仅 .mjs」是 Worker 线程不继承 loader 所致，不适用进程内档。真机已证实（见验收实录）。

### 5.2c 示例 + 测试 + 文档收口（本提交）

- **`examples/extensions/`**（仓库内示例，不自动加载，兼作集成测试 fixture——示例坏了测试红）：
  - `dirty-repo-guard.ts`——pi 官方示例等价物：onPreToolUse 拦 bash 的破坏性 git 命令（checkout/switch/reset/stash/rebase/merge/clean），`exec('git status --porcelain', {cwd: ctx.cwd})` 工作区脏 → deny。
  - `word-count.ts`——注册面三件套：自定义工具（LLM 可调）+ `/exthello` 命令 + system 段。
  - `queue-and-nudge.ts`——行动面：`/queue`（followUp 排队）+ `/nudge`（steer 插话）+ onEvent 观测。
- **测试（+31，合计 743/94 文件）**：env/paths/MemoryFileSystem + MemoryFileSystem 喂三纯逻辑模块（10，kernel/test/env.test.ts）；surface-web contextFs 最小演示（2，含 skill_activate 激活全文进第二轮消息窗）；loader 发现/信任门/遮蔽回落（5）；host API 各面/围栏全注册面回滚/钳制/exec 超时/followUp 双判据/onEvent fan-out/订阅换挂/信任回落（12）；示例集成（3）；TUI extraCommands 撞名 + /help 同源（1）；既有 3E/4D/4B 全部喂 NodeFileSystem 零回归。
- **文档**：本文件转交付报告；[`research/pi.md`](research/pi.md) 新增 §12 实测更正（四包→五包实测行数：agent 8,098 / ai 36,133 / coding-agent 51,545 / orchestrator 1,987 / tui 12,118；扩展事件实测 30 个；ExecutionEnv 三层机制；兼容层否决记录）；README（状态段/结构图/快速开始扩展用法）+ DESIGN 路线图（Phase 5.2 段 + Phase 5.3 DAG 候选）。

## 真机验收实录（2026-07-04）

headless 真机（临时 HOME + 临时 git workspace，FakeProvider 演示态）：

1. **global 直载**：`word-count.ts` + `queue-and-nudge.ts` 放 `~/.yo-agent/extensions` → 启动 stderr `[ext] 已加载 2/3 扩展：queue-and-nudge, word-count`——主进程 tsx 直载 .ts + `@yo-agent/extension-host` 别名解析成立。
2. **信任门（headless 分支）**：`dirty-repo-guard.ts` 放 `<ws>/.yo-agent/extensions` → `[ext] project 扩展「dirty-repo-guard」未 opt-in 信任，已跳过（…；信任后启用）`。
3. **信任 opt-in**：`extension-trust.json` 记入后重启 → `[ext] 已加载 3/3 扩展`。
4. **onEvent 桥接**：turn 结束 stderr `[ext:queue-and-nudge] turn 完成（end_turn）`——SessionStart hook 自动订阅 → TurnCompleted fan-out 全链路真实生效。
5. **遮蔽回落（审查 MED-3 修复后复跑）**：global 与 project 同名 `dirty-repo-guard` 且 project 未信任 → `[ext] 回落加载被其遮蔽的 global 版「dirty-repo-guard」` + `已加载 3/3`。

TUI 交互信任确认（readline y/N）与「LLM 真实调用扩展工具 / PreToolUse 真实阻断 bash」两项因本机无 TTY、无 API key 未做真机（单元/集成已覆盖同路径：examples.test 的 deny 链、host.test 的 PreToolUse 直通）；留待下次真机会话顺手验证。

## 对抗式审查（1 HIGH + 3 MED + 3 LOW，确认项全修 / 取舍项已记录）

按规划的四个重点（主进程跑用户 TS 的信任门与围栏 / EnvAdapter 路径语义等价尤其 realpath / extraCommands 撞名 / followUp 双队列）+ contextFs/MemoryFileSystem，独立审查 agent 对 f57a6dc、24d8fe8 与工作区改动全量复查。

**已修复：**

- **HIGH-1 围栏只罩工具，setup 抛错后 hook/system 段/命令/onEvent 残留生效**：扩展 setup 先 `yo.on({onPreToolUse})` 再抛错 → 半初始化闭包留在 HookBus，若其抛错则 PreToolUse fail-closed **deny 全部工具（坏扩展打死 agent）**，与「跳过不拖垮」承诺相反。修复：setup 期注册物走 **staging 两段提交**（hooks 收 disposer、sections/cmds/listeners 暂存），成功才提交、抛错整体回滚；工具维持健康 flag 显隐免回滚。bad-throw fixture 扩到全注册面 + 回滚断言。
- **MED-3 未信任 project 同名扩展零确认拆掉 global 守卫**：恶意仓库放与用户 global 守卫扩展同名的空壳到 `.yo-agent/extensions/`，发现层覆盖使 global 版消失。修复：loader 覆盖时把被遮蔽 global spec 挂 `shadowedGlobal`，host 信任门拒绝 project 版后回落加载 global 版（真机复跑证实）。反向伪装（project 冒充 global）不可行——source 按发现目录赋值。
- **MED-4 resume 会话订阅永远接不上 + subscribed set 永不失效**：resumeSession 不 fire SessionStart → onEvent/followUp 桥接断；endSession 后同 id resume 重建 SessionState，旧 handler 挂在已弃 subscribers 上、set 命中直接 return → 订阅永久死亡。修复：桥接点扩为 SessionStart + **UserPromptSubmit**（每次提交都 fire，kernel.ts:328——resume 会话首条续聊即接上），且改为 **resubscribe 换挂**（先摘旧再订新，handler 恒落在当前活 SessionState）。
- **LOW-6 wsRoot=$HOME（dotfiles 仓库）时 global 目录被二次扫描降级 project 源**：全部 global 扩展莫名要信任确认（headless 全跳过）。修复：main.ts 装配处两目录相同只扫一遍。
- **LOW-7 `useRef(buildCommands(...))` 实参每帧重求值**：撞名数组每帧重复 push（无界小泄漏）。修复：`??=` 惰性一次构建（historyRef 同款先例）。

**评估后接受（记录取舍）：**

- **MED-2 followUp 双队列同源触发的并发 turn 竞态**：TUI 队列与扩展队列同时非空时，同一 `TurnCompleted{end_turn}` 双路触发 submit，而 kernel 无「同会话 turn 进行中」互斥闸——极端 timing 下两 turn 并发交错消息。根因是**内核层并发闸缺失**（RPC 客户端并发 submitInput 同样命中，非本期引入），收口期不动内核；扩展档判据已与 TUI 完全对齐（仅 end_turn、一次一条）。列为内核已知缺口，随 Phase 5.3/6 内核工作处理。
- **LOW-5 信任按「项目+扩展名」持久**：git pull 换掉已信任扩展的全部内容照常执行（无 hash 校验）——与 mcp-trust 形制一致的既定取舍，已在下方已知限制标注；路径键不做 realpath 归一（`/tmp` vs `/private/tmp` 两键只导致重复确认，fail-safe）。

**查过未发现问题的重点项**：@import 防逃逸/路径语义等价（resolveOne realpath→前缀判定逐行等价、isWithinPath 仅修 `/` 根误拒、TextEncoder 与 Buffer 对孤立代理项同为 3 字节）；extraCommands 撞名（含别名双向、/help 同源）；registerTool 钳制（无 availability 自设逃逸）；host.exec 收敛（timer/listener 清理完整，exec 抛错→fail-closed 语义成立）；contextFs/MemoryFileSystem（无未处理 rejection、listDir 排序差异被调用方 sort 抹平）。

## 已知限制（有意为之）

- **扩展 = 任意代码执行**：定位就是可信档（与 pi 同立场）；防线是项目信任门 + 文档醒目声明，不是沙箱。不可信场景用 plugin-host。信任按「项目 + 扩展名」持久（同 mcp-trust）——已信任扩展的内容变更（如 git pull）不重新确认，无 hash 校验（审查 LOW-5 记录的取舍）。
- **onEvent 对 resume 会话**：经 UserPromptSubmit 换挂接上（审查 MED-4 修复）——resume 后、首条续聊输入前的回放事件收不到（onEvent 语义即「后续事件」）。
- **followUp 与 TUI 队列并发竞态**（审查 MED-2）：两队列同时非空时极端 timing 可能双发 turn——根因是内核无同会话并发 turn 闸（非本期引入），列为内核已知缺口。
- **会话中途动态 system 注入不做**（pushStatusNote 保持 private）；free-text input 面板不做（扩展命令用 args 传参）；浏览器运行时加载扩展不做（动态 import TS 是 Node 能力；web 侧仅保证 sdk 类型面无 node:）。
- **扩展分发**（npm/git 安装）——目录放置即用，分发工具后续。

## 附：pi 参照点（研究时真实核查，重查可 `git clone --depth 1 https://github.com/earendil-works/pi /tmp/pi-src`）

- Env 接口：`packages/agent/src/harness/types.ts:332`（ExecutionEnv）+ FileSystem 接口同文件 + `harness/env/nodejs.ts`（唯一 node 实现，569 行）；核心包双入口 `src/index.ts`（纯）/`src/node.ts`（+NodeExecutionEnv）。
- Harness 装配：`harness/types.ts:798 AgentHarnessOptions`（env/session/models/tools/resources/systemPrompt 可为函数）。
- 扩展系统：`packages/coding-agent/src/core/extensions/{types,loader,runner}.ts`（types 1,638 行；30 事件；loader 用 jiti 并预绑定 pi 包）；官方示例 68 个在 `packages/coding-agent/examples/extensions/`（API 使用分布：registerCommand 30 / registerTool 15 / pi-tui 21 / node: 10）。
- 内置工具的现实妥协：`core/tools/read.ts` 直连 node:fs + `ReadOperations` 按工具覆写接口（SSH 委托用）——工具不写在 ExecutionEnv 上，验证了「产品层工具 Node 直连」与「内核 I/O 接口化」可以并存。
- 设计立场原文：`packages/coding-agent/README.md:491-501`（No MCP / No sub-agents / No permission popups / No plan mode / No to-dos / No background bash——全部指向扩展）。
