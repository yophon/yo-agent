# Phase 4 —— 子 agent + 沙箱加固 + 插件 + 健壮性（开放渠道前的安全底座）

> 对应 [`DESIGN.md`](DESIGN.md) §13 Phase 4 / §2.5（子 agent）/ §3.2-3.4（工具与沙箱）/ §4.4（fallback/rotation）/ §8（扩展机制）/ §11（hooks）。延续 Phase 0-3 的「离线可验证 / 风险优先 / 护栏底座先行」分片：每片用进程内/内存对驱 + worker_threads/child_process 本机隔离单测验证，**不依赖外部网络或第三方 server**；唯一真机冒烟（4B 子进程跑命令）无网络依赖、CI 可跑。
>
> **Phase 3 收口基线**：307 测试（37 文件，1 真机冒烟门控跳过）全绿。本阶段在此之上增量交付，每片末跑全量回归不退化。
>
> **本计划已经过代码级现状勘察（7 子系统）+ 风险优先切片设计 + 用户范围拍板**。勘察核实并修正了若干「DESIGN 以为 Phase 1 已建、实则现状缺失」的关键误判，见 [§现状已核实修正](#现状已核实修正避免重复造轮)——**最重要的一条：编程 agent 的命脉工具 `bash/execute` 至今不存在**，Phase 4 的沙箱必须连这把工具一起从零建，而非「给已有工具加隔离」。范围决策见 [§已定范围决策](#已定范围决策用户已拍板)。

---

## 范围与排序原则

Phase 4 是**聊天平台开放渠道（Phase 5）的前置安全/健壮性底座**。三条退出标准（DESIGN §13 Phase 4）：

1. **安全审查通过**（exec 沙箱 + 危险命令/注入防护 + 权限模式落地经对抗式审查）。
2. **子 agent 崩溃不拖垮主循环**（Worker 隔离 + 崩溃围栏）。
3. **插件隔离生效**（不可信插件代码经 Worker IPC 隔离运行，崩溃不波及主进程）。

外加一组健壮性打磨：用量计费串接（costUsd）、provider fallback 链 / auth rotation、recipes/skills 懒加载。

**排序原则（风险优先 / 护栏底座先行，与 Phase 3 一致）**：Phase 4 引入两个 yo-agent 至今没有的**最高危能力**——**执行任意 shell 命令**（bash 工具）与**运行不可信插件代码**（plugin）。所有最危险的失败模式（命令逃出 workspace、读到 yo-agent 自身 secret、危险命令毁盘、注入式工具输出污染上下文、插件崩溃拖垮主进程、子 agent 无限递归 spawn）都在这两个能力落地那一刻触发。因此：
- **先做纯内核、纯单测可验的横切护栏底座（4A：Hook 矩阵 + permissionMode 落地 + ExecBackend 抽象）**，再让危险能力落到这套护栏上。
- **危险能力随其护栏同片交付**（bash 与 L1 隔离同在 4B；插件与 Worker 隔离同在 4E），绝不「先裸建能力、后补隔离」。
- 审查节奏（ADR-14，本阶段收紧为统一规则）：**所有切片只做实现 + 针对性单测，"大体无误即过"；大规模对抗式审查统一推迟到 Phase 4 整体收口一次性做**。高危切片（4A 权限门 / 4B exec / 4E 插件）以**更厚的针对性安全单测**兜底（如 4B secret 剥离 / cwd 逃逸、4E 隔离 / 防绕审批），而非逐片 Workflow 审查。

### 退出标准达成口径（写死，否则达成度无法判定）

- **退出标准①（安全审查通过）**：Phase 4 整体收口一次大规模安全向对抗式审查（finder→adversarial verify→completeness critic）覆盖全部切片 + 跨片接缝，确认缺陷全修、回归测试全绿。各片推进期以针对性安全单测兜底，不逐片起 Workflow 审查。
- **退出标准②（子 agent 崩溃不拖垮主循环）**：在 4C 用一个**故意崩溃的子 agent**（Worker 内抛未捕获异常 / 主动退出等价物）离线单测验证——主 turn 收到 `SubagentResult{error 摘要}` 并继续，主循环不挂死、不静默吞错。
- **退出标准③（插件隔离生效）**：在 4E 用一个**故意崩溃/越权的插件**离线单测验证——插件 Worker 崩溃 → 主进程存活 + 心跳检测到 + 该插件工具自动降级不可见；插件无法读到主进程 secret env。
- **真机冒烟（无网络依赖、CI 可跑）**：4B 末本机真实子进程跑一条命令（`echo`/`pwd`），验证 L1 隔离与流式输出。

---

## 切片总览

| 片 | 标题 | 服务退出标准 | 依赖 | 新建包 | 状态 |
|---|---|---|---|---|---|
| **4A** | 横切底座：生命周期 Hook 矩阵（进程内）+ permissionMode→PolicyEngine 落地 + ExecBackend 抽象（**无执行/无隔离行为变更**） | ①②③ 前置 | — | — | ✅ 已交付 |
| **4B** | 内置工具集补全（`bash/edit/grep/glob/todo/apply_patch`）+ **L1 子进程隔离**（LocalSubprocessExecBackend）+ 危险命令/注入三阶段审查 | ① | 4A | — | ✅ 已交付（+真机子进程） |
| **4C** | **SubagentManager**（worker_threads 隔离 + 崩溃围栏 + 异步 steering + deriveSubagentPolicy + `subagent_spawn` 工具） | ② | 4A | — | ✅ 已交付（退出标准②达成） |
| **4D** | recipes/skills 懒加载（subagent profile + `skill_activate`） | 赋能②③ | 4C | — | ✅ 已交付 |
| **4E** | **插件 SDK**（Worker IPC 隔离 + 心跳重连）+ Hook 矩阵跨进程兑现 | ③ | 4A | `plugin-host` | ✅ 已交付（退出标准③达成） |
| **4F** | 健壮性：`costUsd` 用量计费串接 + **provider fallback 链 / auth rotation** | 健壮性 | 4A | — | ✅ 已交付 |

> 4A 是 4B/4C/4E 的共享前置（Hook 点、权限门、ExecBackend 接口三者跨 exec/subagent/plugin 复用）。4C/4D（子 agent + recipe）与 4E（插件）都消费 4A 的 Hook 矩阵，可并行。4F（计费/fallback）与上述大体正交，可穿插。**`bash` 工具补全是 4B 的隐含前提**（详见 §现状已核实修正）。**L2 容器隔离 + OTel 全链路按用户拍板顺延 Phase 6**（详见 §已定范围决策）。

---

## 4A — 横切底座：Hook 矩阵 + permissionMode 落地 + ExecBackend 抽象（无执行/无隔离）✅ 已交付

**目标**：把 Phase 4 危险能力（exec / subagent / plugin）共享的三条内核接缝**先以纯本地、纯单测可验的形态固定下来**，且**不改变任何现有运行时行为**（行为变更全部推迟到落能力的切片）。这是 Phase 4 的「3A 式护栏底座」。

**交付物**：
1. **生命周期 Hook 矩阵（进程内先行）**：在 kernel turn 循环的确定性位点暴露 hook：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreCompact`、`Stop`、`SubagentStart`/`SubagentStop`、`OnApproval`（对齐 DESIGN §11 hook 矩阵 + Claude Code 范式）。本片只做**进程内同步 hook 注册表 + 调用点**（不可信插件的跨进程 Worker 隔离留 4E）。`PreToolUse` 可返回「拦截/改写 input/放行」三态——这是「确定性强制」类约束（§8 决策矩阵：commit 前跑测试应走 PreToolUse hook 而非写 yo.md）的落点。
2. **permissionMode → PolicyEngine 落地**：现状 `permissionMode` 有 6 档（`read-only|supervised|accept-edits|autonomous|ci|bypass`，protocol/enums.ts）但**存了不用**（无执行期检查，安全漏洞）。本片实现 `PolicyEngine`：在 `assessRisk` 之后、`requestApproval` 之前按 mode 决策——`read-only` 拦所有 edit/execute/delete；`supervised` 走审批；`accept-edits` 自动放行 edit 类、其余审批；`autonomous` 按 risk 决策；`ci` 非交互按 allowlist；`bypass` 全放行（明示危险）。与既有 `approvalCache`/`assessRisk` 正交叠加（ADR-4：SecurityAnalyzer × ConfirmationPolicy）。
3. **ExecBackend 抽象接口**：定义 `interface ExecBackend { kind; exec(cmd, opts): AsyncIterable<{chunk; exitCode?}> }`（DESIGN §3.4），归属 `packages/tools`（工具执行体所在层）。本片**只定义接口 + 一个 no-op/未注册占位**，不接任何真实执行（bash 工具 + LocalSubprocessExecBackend 在 4B）；`docker`/`ssh-remote` 档接口预留、实现留 Phase 6。

**触及**：`packages/kernel`、`packages/tools`（ExecBackend 接口）、`packages/protocol`（hook 点若需事件化；`PermissionMode` 已存在无需改）。**退出标准**：
- Hook 矩阵：每个 hook 点有注册/触发单测；`PreToolUse` 拦截/改写/放行三态生效（用 stub hook 验证 input 被改写后工具收到新 input、拦截后工具不执行）。
- PolicyEngine：6 档 permissionMode × 各 ToolKind 的决策矩阵全覆盖单测；`read-only` 下 write/execute 被拦且**不触发审批**；`bypass` 全放行；与 `approvalCache` 叠加不冲突。
- ExecBackend 接口存在 + 占位不被误用（无 bash 工具注册时调不到）。
- **行为不变量**：现有 307 测试全绿、无一改写期望值（本片不改运行时行为）。
- **审查节奏（ADR-14）**：本片是权限门/审批面核心改动，以**针对性安全单测**兜底——验「permissionMode 决策不可被绕过」「PreToolUse 拦截后工具确实不执行」「hook 异常不吞掉/不拖垮 turn」；大规模对抗式审查随 Phase 4 整体收口统一做。

**交付状态**：`packages/tools/src/exec.ts`（ExecBackend 接口 + `UnconfiguredExecBackend` 占位）+ `packages/kernel/src/policy.ts`（`DefaultPolicyEngine` 6 档闸门）+ `packages/kernel/src/hooks.ts`（`HookBus` + 9 个 hook 点，PreToolUse 三态 + fail-closed，观测型 onError 不吞不拖垮）；内核接线：`startSession`→SessionStart、`launchTurn`→UserPromptSubmit、工具循环→PreToolUse(审批前可改写/拒) + PolicyEngine 闸门 + OnApproval、tool 后→PostToolUse、`maybeCompact`→PreCompact、统一 `completeTurn`→Stop；`AgentKernel.registerHook` 暴露注册。**关键不变量守住**：缺省注入 `DefaultPolicyEngine`（supervised 对非 never 工具恒 `ask`）+ 空 `HookBus`（无 hook = no-op），**307 既有测试零改写期望全绿**。验证门 **+28 测试**（exec 2 + policy 8 + hooks 9 + 内核集成 9），收口基线 **335 测试**（41 文件，1 真机冒烟门控跳过）。

---

## 4B — 内置工具集补全 + L1 子进程隔离 + 危险命令/注入三阶段审查 ✅ 已交付

**目标**：补齐编程 agent 至今缺失的命脉工具集（现状只有 `read/write/ls`，见 §现状已核实修正），其中**最高危的 `bash` 与其唯一安全护栏 L1 子进程隔离同片交付**——这是 Phase 4 安全的核心。用户已拍板「一并补齐」，故本片把缺失的内置工具一次补全。

**交付物**：
1. **【高危核心】`bash`/`execute` 工具 + `LocalSubprocessExecBackend`（L1，默认生产）**：
   - `bash` 工具：`kind:'execute'`、`approval:'risk-based'`（**绝不 `'never'`**）、流式输出、可后台（`BackgroundProcess` 事件已定义）、大输出写盘只回路径（DESIGN §2.2 `truncatedToPath`，nanobot 50KiB 阈值）。
   - L1 隔离：独立 `child_process` 跑，**受限 env（剥离 yo-agent 自身 secret：API key / 设备私钥 / OAuth token，白名单透传）+ workspace 内受限 cwd（复用 builtins 的 `confine`）+ per-call 超时 + abort 信号（接 turn/interrupt）+ 可选独立低权 OS 用户**（DESIGN §3.4 L1）。
   - 危险命令防护：复用并扩展 `risk.ts` 的 `DANGEROUS_CMD_RE`（已覆盖 `rm -rf`/`mkfs`/`dd`/fork bomb/`shutdown`），bash input 必经风险评估升 high → 走审批。
   - 注入防护：bash stdout / web_fetch 输出注入上下文前净化标注为不可信数据段（降低 prompt injection 经工具输出回灌）。
   - 三阶段审查接线：经 4A 的 `PreToolUse`（命令静态/策略检查）→ 执行 → `PostToolUse`（输出审查）（DESIGN §3.4 + §11）。
2. **【低危补全】内置工具集补全**：`edit`（精确字符串替换）、`grep`（ripgrep 内容搜索）、`glob`（文件名匹配）、`todo_write`（turn 内任务清单）、`apply_patch`（多文件补丁），均 confine cwd、edit 类成功后接既有 `ShadowGitCheckpointer` 快照（DESIGN §3.2）。**这批为低危 builtin，只做单测 + confine，不进对抗式审查焦点**。

**触及**：`packages/tools`、`packages/kernel`、`packages/protocol`（如需补 exec 相关事件字段）。**退出标准**：
- bash 经 `LocalSubprocessExecBackend` 真实跑通本机命令（`echo`/`pwd`，**无网络依赖、CI 可跑非门控**）；流式输出 + exitCode 正确；大输出写盘回路径。
- 隔离：子进程 env **不含** yo-agent secret（注入哨兵 env 后断言子进程读不到）；cwd 越界命令被 confine + 风险升级拦；超时与 turn/interrupt 能杀子进程不留孤儿。
- 危险命令（`rm -rf /` 等）→ risk high → 审批（`read-only`/无审批环境下直接拒）。
- 补全工具：edit/grep/glob/todo_write/apply_patch 各有单测 + confine 越界拒；edit 类触发 checkpoint。
- **审查节奏（ADR-14）**：以**更厚的针对性安全单测**兜底（焦点 = bash + ExecBackend + L1 的 exec 安全面）——验「secret 不泄漏给子进程」「cwd 逃逸」「危险命令绕过」「abort 不留孤儿进程」「注入输出不被当指令」；大规模对抗式审查随 Phase 4 整体收口统一做。补全工具只做基础单测。

**交付状态**：`packages/tools/src/exec-local.ts`（`LocalSubprocessExecBackend`：`spawn /bin/sh -c` + env 白名单剥离 secret + workspace cwd + detached 进程组 abort 杀组不留孤儿 + 队列抽干流式）+ `packages/tools/src/bash.ts`（`makeBashTool(backend)` + `bashTool` 默认 L1；`approval:'risk-based'` 绝不 never；50KiB 输出截断写盘只回路径；不可信数据标注；退出码）+ `builtins.ts` 补全 `edit`（字面精确替换 + 唯一性校验）/`grep`（递归正则 + 跳过 .git/node_modules）/`glob`（`**`/`*`/`?`）/`todo_write`/`apply_patch`（Add/Update/Delete 信封），均 confine cwd，全部入 `builtinTools`（app 自动注册）。**危险命令→风险升级→审批**复用 4A PolicyEngine + risk.ts `DANGEROUS_CMD_RE`；**三阶段审查**经 4A `PreToolUse`→exec→`PostToolUse` 自动接线（execute 类工具通吃）。**真机子进程冒烟**由 exec-local/bash 测试在 CI 跑真实 `/bin/sh`（`printf`/`exit N`/`sleep` abort/env 剥离/`ls`/`head`）达成，**非门控**。验证门 **+24 测试**（exec-local 7 + bash 6 + 补全工具 11），收口基线 **359 测试**（44 文件，1 真机冒烟门控跳过）。
- **真机冒烟**：本机子进程跑一条真实命令（已含在单测，非门控）。

---

## 4C — SubagentManager（Worker 隔离 + 崩溃围栏 + 异步 steering）✅ 已交付

**目标**：实现 `SubagentManager`（接口已冻结于 kernel/index.ts，含 `isolation` 字段，但零实现），让探索型任务派生独立上下文子 agent，**只回 `SubagentResult{summary}` 防主上下文污染**，且**子 agent 崩溃不拖垮主循环（退出标准②）**。

**交付物**：
1. **`SubagentManager` 实现**：`spawn(opts)` 在 `worker_threads`（默认）跑子 agent（独立上下文、独立工具集、可换便宜模型）；`child_process` 档留接缝（需独立 OS 权限时）。
2. **崩溃围栏**：子 agent Worker 内任何未捕获异常 / 崩溃 → 主 turn 收到 `SubagentResult{error 摘要}` 并继续，**主循环存活**（退出标准②的离线判据）。
3. **内核 emit `SubagentStarted`/`SubagentResult`**：事件已定义、resume 白名单已含（resume.ts），本片接上 emit + 持久化。
4. **异步 steering 注入**：background 子 agent 完成 → 结果进 steering queue，parent 下一 step 自然注入，不阻塞主 turn（DESIGN §2.5）。
5. **`deriveSubagentPolicy`（只收紧不放宽）**：子 session policy 从 parent 派生只能缩紧（opencode 范式）；**防无限递归 spawn**（子 agent 默认不带 `subagent_spawn` 工具或限深度）。
6. **`subagent_spawn` 工具** + 子 agent 上下文隔离（独立 EventLog 子树 childSessionId，主 session 不被子任务工具历史污染，DESIGN §5.4）。

**触及**：`packages/kernel`、`packages/store`（子树持久化）、`packages/tools`（subagent_spawn）。**退出标准**：
- 故意崩溃子 agent → 主 turn 拿到 error 摘要并继续、主循环不挂死（**退出标准② 离线达成**）。
- foreground/background 两模式；background 结果经 steering queue 注入 parent 下一 step。
- `deriveSubagentPolicy` 只缩紧（子 agent 不能拿到 parent 没有的工具/权限）；递归 spawn 被深度/工具白名单拦。
- 主 session EventLog 不含子 agent 工具调用细节，只含 `SubagentStarted`/`SubagentResult`。
- **审查节奏（ADR-14）**：实现 + 针对性单测（崩溃围栏、policy 收紧、递归防护有专测）；随 Phase 4 整体收口统一审查。

**交付状态**：`packages/kernel/src/subagent.ts`——三层职责分离：
- **`SubagentRunner` 执行/隔离档抽象**（仿 ExecBackend/ADR-19，可换档透明）：① **`WorkerSubagentRunner`**（worker_threads，ADR-17 默认隔离）——worker `'error'`（未捕获异常）/ `'exit'` 非0（主动退出）/ `terminate`（取消）全转 rejected promise；worker env 默认按白名单剥离 secret（子 agent 读不到主进程 API key/设备私钥/OAuth）；② **`createInProcessRunner`/`runChildAgent`**（同线程默认档）——跑独立 `childSessionId` 子内核（独立上下文 + `AllowlistToolRegistry` 收紧工具集 + 派生权限模式 + 独立 EventLog 子树，主 session 不被污染），非交互（无人审批 → ask 档默认拒，派生权限不被放大）。
- **`DefaultSubagentManager`**：**崩溃围栏**（`runWithContainment`：runner 任何抛错/拒绝 → 收敛为 `SubagentResult{[子 agent 失败]…}`，**绝不上抛**，退出标准②）；**递归防护**（`maxDepth` 硬上限 + `deriveSubagentPolicy` 恒剥离 `subagent_spawn` 双保险）；**前/后台**（foreground 阻塞取摘要经 tool_result 回灌；background 发出即返回、结果经 steering 在 parent 下一 step 注入）。
- **`deriveSubagentPolicy`（只收紧）**：权限模式取 requested∩parent 更严者（绝不放宽）；工具集 = requested∩parent 并剥离 spawn。
- **内核接缝**：`AgentKernel implements SubagentHost`——`noteSubagentStarted/Result` 让父会话落 `SubagentStarted`/`SubagentResult`（内核仍是唯一 AgentEvent 写入者）+ 触发 `SubagentStart/Stop` hook；新增**每会话 emit 串行链**（后台离带 emit 与在跑 turn 的 emit 不交错抢 headCursor）+ **steering 队列抽干**（并入末条 user 消息保 user/assistant 严格交替，不连续两条 user）。
- **`subagent_spawn` 工具**（`packages/tools/src/subagent-tool.ts`，`approval:'risk-based'` 绝不 never）+ **`AllowlistToolRegistry`**（只读收紧包装，越界点名工具被「不在可见集」拒、不绕审批）。app 接线：`buildKernel` 装配 manager（host=内核、in-process runner、`parentToolsOf`/`parentModeOf` 取父会话实况收紧基准）并注册工具。
- **退出标准②达成**：`subagent-worker.test.ts` 以真实 worker_threads 跑 `.mjs` fixture——未捕获异常 / `process.exit(7)` 两路崩溃经管理器围栏 → 主循环存活收 error 摘要；secret 剥离专测。验证门 **+19 测试**（policy 4 + manager 6 + worker 6 + 端到端真内核 3），收口基线 **378 测试**（48 文件，1 真机冒烟门控跳过）。
- **已知限制（明示）**：worker 隔离档基础设施 + 崩溃围栏已建并真机验证；**默认接线用 in-process 档**（上下文隔离 + 异常围栏齐备）。把 worker 档提升为「跑完整子内核」的生产默认需 tsx-worker loader 路径 + provider 配置重建，留作接缝（与 ExecBackend L2 同等推迟态）。子 agent 非交互：supervised 父派生的子 agent 实质只读（ask 档无人应答即拒），需更强能力时父跑 accept-edits/autonomous。

---

## 4D — recipes/skills 懒加载（subagent profile + skill_activate）✅ 已交付

**目标**：补齐 DESIGN §5/§8 的声明式扩展——skill 懒加载 + 子 agent recipe（profile），喂给 4C 的子 agent。

**交付物**：
1. **`skill_activate` 工具 + skills 懒加载**：skill 摘要进上下文、激活时才加载全文（复用 context-files.ts 的 `@import` resolver——勘察确认该 resolver 已为 skill @-reference 预留共用）；skills 内容压缩时受保护不被截断（DESIGN §5.4，opencode `PRUNE_PROTECTED_TOOLS`）。
2. **subagent recipe/profile 加载**：YAML/MD 定义子 agent（工具白名单 + 独立 prompt + 绑定 model），喂给 4C 的 `profile` 参数（Roo mode / Goose Recipes 范式）；project 级 `.yo-agent/skills/` 与 `.yo-agent/agents/` 提交 git 即全队共享。

**触及**：`packages/tools`、`packages/kernel`（context 装配 + 压缩保护）、`apps/yo-agent`。**退出标准**：
- skill 摘要注入 + 激活加载全文 + 压缩不被截断（专测）；recipe 加载 → 4C spawn 用其工具白名单（与 deriveSubagentPolicy 叠加）。
- **审查节奏（ADR-14）**：纯本地，实现 + 针对性单测，随收口统一审查。

**交付状态**：
- **skills 懒加载**（`packages/kernel/src/skills.ts`）：`loadSkills` 从 `~/.yo-agent/skills` + `<workspace>/.yo-agent/skills`（global 在前 / project 同名覆盖）加载单文件 `<name>.md` 或目录式 `<name>/SKILL.md`（YAML-ish frontmatter，无第三方依赖）；`renderSkillSummaries` 把**摘要**（name+description）注入 system，**全文按需经 `skill_activate` 加载**。`skill_activate` 工具（`packages/tools/src/skill-tool.ts`，`approval:'never'`、kind=read）。
- **压缩保护**（`condenser.ts` 新增 `protectedToolNames`，opencode PRUNE_PROTECTED_TOOLS）：中段含受保护工具（`skill_activate`）的 `tool_use`/`tool_result` **消息对逐字保留不进摘要**（配对完整性：tool_use 连带其 tool_result、反之亦然），其余中段照常摘要；空保护集 → 行为同既有（既有压缩测试零改写）。
- **跨 surface 统一注入**：内核新增 `systemSuffix` dep —— `startSession` 把技能摘要拼进 system 消息（CLI/RPC/ACP/MCP 各 surface 的会话一致拿到），不靠各 surface 单独装配。
- **subagent recipes**（`packages/kernel/src/recipes.ts`）：`loadRecipes` 从 `~/.yo-agent/agents` + `<workspace>/.yo-agent/agents` 加载 `<name>.md`（frontmatter：tools/model/permissionMode + 正文=prompt）；喂 4C 管理器 `recipeFor` → 提供 `requestedTools`/`requestedMode`/`model`/`systemPrompt`。**安全不变量**：recipe 只能**请求**，仍经 `deriveSubagentPolicy` 与 parent 取交集（工具）/更严者（权限），**绝不放大子 agent 权限**（recipe `[read,net]` ∩ parent `[read,write]` = `[read]`；recipe `read-only` 在 `autonomous` parent 下 → `read-only`）。
- **app 接线**：`buildKernel` 异步化——加载 skills/recipes、注册 `skill_activate`（有技能时）、`systemSuffix=renderSkillSummaries`、manager `recipeFor`；`buildCondenser` 传 `protectedToolNames={skill_activate}`。真机冒烟：workspace 放一个 skill → CLi `SessionStarted.tools` 含 `skill_activate`。
- 验证门 **+19 测试**（skills 9 含 systemSuffix 注入 + recipes 4 + 压缩保护 2 + skill_activate 工具 4），收口基线 **397 测试**（52 文件，1 真机冒烟门控跳过）。

---

## 4E — 插件 SDK（Worker IPC 隔离 + 心跳重连）+ Hook 矩阵跨进程兑现 ✅ 已交付

**目标**：让第三方插件（不可信代码）注册工具/消费 hook，但**在 Worker 进程内 IPC 隔离运行，崩溃不拖垮主进程（退出标准③）**。用户已拍板：**独立成包 `plugin-host`**（隔离 Worker/IPC 依赖）。

**交付物**：
1. **Plugin SDK**：插件声明可注册 `ToolDescriptor{owner:'plugin'}`（registry 已支持 owner 概念 + 稳定排序）+ 订阅 4A 的 hook 点。
2. **Worker IPC 隔离**：插件跑在独立 Worker，经结构化 IPC 与主进程通信（多种 IPC + 心跳重连，LangBot 范式）；**插件 env 不含主进程 secret**；插件工具执行仍走主内核审批流（**不可 `approval:'never'` 绕过**）。
3. **崩溃围栏 + 心跳**：插件 Worker 崩溃 → 主进程存活、心跳检测、该插件工具自动降级不可见（接 4A availability/flag 机制）；重连恢复。
4. **Hook 矩阵跨进程兑现**：4A 的进程内 hook 升级为可被 out-of-process 插件消费（hook 调用经 IPC，超时/崩溃不阻塞主 turn）。

**触及**：`packages/plugin-host`（新）、`packages/kernel`、`packages/tools`、`apps/yo-agent`。**退出标准**：
- 故意崩溃/越权插件 → 主进程存活 + 心跳检测 + 工具降级（**退出标准③ 离线达成**）；插件读不到主进程 secret env。
- 插件工具经主内核审批流（不能绕审批）；插件 hook 异常/超时不拖垮主 turn。
- prompt-cache 稳定性：插件工具按 owner 排序进上下文不漂移（复用 registry 既有稳定排序）。
- **审查节奏（ADR-14）**：以**更厚的针对性安全单测**兜底——验「插件无法读 secret」「崩溃不波及主进程」「不能绕审批」「IPC 反序列化安全」；大规模对抗式审查随 Phase 4 整体收口统一做。

**交付状态**：独立成包 **`packages/plugin-host`**（隔离 Worker/IPC 依赖，与 surface-acp 同理）——四层职责：
- **`protocol.ts`**：主↔Worker 结构化 IPC 契约（`HostToWorker`/`WorkerToHost`，全 JSON 可结构化克隆）+ 心跳/超时常量 + `pluginHealthFlag('plugin:<id>')`（复用 3C availability configFlag 范式）+ `PluginToolDecl`（approval 至多 'always'|'risk-based'）。
- **`transport.ts`** —— **传输档抽象**（仿 ExecBackend/SubagentRunner，ADR-19/17）：① **`WorkerPluginTransport`**（生产默认，真 worker_threads）——worker `'error'`（未捕获异常）/ 非 0 `'exit'`（越权被杀/主动退出）/ `terminate`（看门狗判死）全转 `onCrash`；worker env 默认按白名单剥离 secret（插件读不到主进程 API key/设备私钥/OAuth）；② 测试用内存假传输确定性驱动崩溃/心跳丢失（不碰 worker loader 脆弱性，4C 教训）。
- **`host.ts`（`DefaultPluginHost`）**：三条安全不变量——① **崩溃围栏 + 心跳降级**（onCrash / 看门狗超时 → 主进程存活 + 撤健康标志即工具从 `resolveAvailable` 消失 + 拒在飞调用 + 指数退避重连）；② **不绕审批**（插件工具以 `owner:'plugin'`、approval 恒钳制非 'never' 注册进主 registry，经 kernel `PreToolUse→PolicyEngine→approval` 把关**之后**才下发 invoke）；③ **secret 隔离**（env 白名单由 transport 剥离）。**Hook 跨进程兑现**：聚合 `Hooks` 注册进 kernel HookBus 一次，按订阅 fan-out 经 IPC——**关键不变量**：插件不可用/超时/崩溃时 PreToolUse **绝不抛错**（返回 void = 放行），否则 HookBus 的 fail-closed 会因一个挂掉的插件拒掉主循环所有工具（违背退出标准③）。
- **`worker-entry.mjs`（纯 ESM 通用运行时）**：`new Worker()` 无需 tsx loader 即可加载（绕开 4C worker+tsx 脆弱性）；据 `workerData.modulePath` 动态 import 插件模块（.mjs/.js）跑 IPC：ready 握手 + 心跳 + invoke/hook 应答。`sdk.ts` 的 `definePlugin` 给作者类型推断（运行时即默认导出形状）；`loader.ts` 从 `~/.yo-agent/plugins` + `<ws>/.yo-agent/plugins` 发现插件（目录式 `plugin.mjs` / 单文件 `<name>.mjs`，best-effort 不抛）。
- **app 接线**：`buildKernel` 建 `DefaultPluginHost`、注册聚合 hooks、`await start(specs)`（best-effort）；**mcp + plugin 健康标志合并**喂 `kernel.toolFlags` 与子 agent `parentToolsOf`（任一源熔断/崩溃 → 其工具消失）；`installShutdown`/headless finally 回收插件 Worker。
- **退出标准③达成**：`worker-isolation.test.ts` 以真 worker_threads + 纯 .mjs fixture 验——故意崩溃插件（未捕获异常）/ 越权插件（`process.exit(7)`）→ 主进程存活 + 心跳/崩溃检测 + 工具降级不可见；secret 探针插件证 `YO_SECRET_SENTINEL` 读不到、`PATH` 可见。验证门 **+19 测试**（host 假传输 15：注册/approval 钳制/稳定排序/代理 invoke/崩溃围栏/心跳降级/重连/hook 放行不抛 + 真 worker 4），收口基线 **416 测试**（54 文件，1 真机冒烟门控跳过）。**真机冒烟**：临时 workspace 放 `.yo-agent/plugins/hello.mjs` → CLI `SessionStarted.tools` 含 `hello_echo`（经真 Worker 加载）。
- **已知限制（明示）**：worker-entry.mjs 通用运行时加载 **.mjs/.js 插件**（无构建产物，与本仓源码态 ethos 一致）；作者写 TS 插件需自行编译为 JS 后投放（同 ExecBackend L2 / 子 agent worker 生产默认的「需构建/loader 路径」推迟态）。重连跨次握手的工具集差异不做热调和（首次 ready 注册、重连仅恢复健康标志）。

---

## 4F — 健壮性：用量计费串接 + provider fallback 链 / auth rotation ✅ 已交付

**目标**：补齐用量计费落地与多 provider 韧性（OTel 全链路按用户拍板顺延 Phase 6）。

**交付物**：
1. **`costUsd` 串接**：现状 `catalog.estimateCost` 已实现但**从不被调用**（勘察确认）。本片在 `UsageUpdate`/`TurnCompleted` emit 前调 `estimateCost(model, usage)` 填 `costUsd`；用量落盘 `usage` 表（DESIGN §4.4）。
2. **provider fallback 链 / auth rotation**：在 `ProviderEvent.Error` 补 `category`（`rate_limit|billing|auth|context_overflow|network`，现仅有 `retryable` 布尔）；内核据此决策——`rate_limit`→换 key/换 provider，`context_overflow`→触发 compaction，`billing/auth`→换 provider（DESIGN §4.4，LangBot/OpenClaw 范式）；**工具调用循环内 commit 首个成功模型**避免跨模型 tool_result 解读不一致（LangBot 教训）。

**触及**：`packages/provider`、`packages/kernel`、`packages/store`（usage 表）、`packages/protocol`（Error.category）。**退出标准**：
- `TurnCompleted.costUsd` 经 estimateCost 正确填充（含 cache 读写分价）；usage 落盘可查。
- fallback：注入各类错误 → 决策正确（rate_limit 换 key、context_overflow 触发压缩、billing 换 provider）；循环内不跨模型漂移。
- **审查节奏（ADR-14）**：实现 + 单测；auth rotation 涉及 secret，secret 不入日志（沿用 Phase 3 约束）随收口审查。

**交付状态**：
- **costUsd 串接**：内核新增 `costEstimator?(model, usage)` dep —— `UsageUpdate` 与 `TurnCompleted` emit 前经 `withCost(model, usage)` 填 `costUsd`（含 cache 读/写分价，按**当前生效路由模型** `activeModel(s)` 估）；已含 costUsd 则尊重原值；无 estimator/未知模型 → 不填（向后兼容，既有测试零改写）。app 接线 `costEstimator: (m,u)=>catalog.estimateCost(m,u)`（catalog 已实现，4F 前从不被调用——勘察 §4）。
- **错误归类**：protocol `ErrorInfoSchema` + provider `ProviderEvent.Error` 增 `category`（`rate_limit|billing|auth|context_overflow|network|unknown`）；provider `classifyError(status, message)`（纯函数）按 HTTP status + 文本归类，接入 anthropic/openai/responses/gemini 四 adapter 的 HTTP 错误 + 网络异常产出点。
- **provider fallback 链 / auth rotation**（`packages/kernel/src/fallback.ts`）：`ProviderRoute = {provider, model, label?}`；内核 `deps.fallbacks?: ProviderRoute[]` 构成链 `[主, 备…]`（「换 key」= 同 provider 不同 key 的另一路由，「换 provider」= 不同 provider 路由）。`decideFallback(category, {hasNext, committed})` 纯决策——**context_overflow → compact**（同模型 `forceCompact` 跳过阈值/min-rounds 立即压一次后重试，**不换模型**）；**rate_limit/network/billing/auth → switch**（换路由，仅未 commit & 有下家）；**其余 → fail**（不盲目重试）。turn 内 `routeIdx` **粘滞**（跨 turn 不回探死掉的主路由）。
- **不跨模型漂移**（LangBot 教训）：**commit 首个成功模型**——一旦某 turn 已产出（流式发出 text/thinking/tool），后续 step 的错误一律 fail、不换模型；且本次尝试**已流式发出内容的错误不重试**（无法干净回退，避免重复 emit）。attempt 上界 = 链长 + 3 次压缩，防病态循环。
- 验证门 **+14 测试**（classifyError 3 + decideFallback 3 + 内核集成 8：rate_limit 换路由 / billing 粘滞 / context_overflow 压缩重试 / commit 后不漂移 / unknown 不重试 / 无链向后兼容 + costUsd 串接 2），收口基线 **430 测试**（57 文件，1 真机冒烟门控跳过）。
- **app 接线（明示边界）**：内核已支持 `deps.fallbacks`，但 **CLI 单 provider 默认不构链**（`selectProvider` 选单家）；多 key/多 provider fallback 链由部署侧按需注入（机制 + 决策已就绪并单测）。**OTel 全链路 + metrics 看板按用户拍板顺延 Phase 6**（本期只做 costUsd 串接 + provider fallback/rotation）。

---

## 现状已核实修正（避免重复造轮）

代码级勘察（7 子系统）核实，DESIGN/README 与实际交付存在以下差异，**直接影响 Phase 4 切片定义**：

1. **【最重要】`bash`/`execute`/`edit`/`grep`/`glob`/`todo` 工具至今不存在**——实际内置工具只有 `read/write/ls`（builtins.ts:81，PHASE-1.md:20 亲口承认、真机仅验 `ls`）。DESIGN §3.2 / §13 Phase 1 列的完整工具集是**计划而非现状**。**后果**：Phase 4「L1 子进程隔离」不是「给已有 bash 加隔离」，而是**连 bash 工具一起从零建**（4B）；其余缺失工具一并补全（用户拍板）。
2. **`SubagentManager` 接口已冻结但零实现**：kernel/index.ts:107-122 有完整 `SubagentSpawnOpts`（含 `isolation:'none'|'worktree'|'container'`、`mode`、`profile`）+ `spawn()` 签名；`SubagentStarted`/`SubagentResult` 事件已定义（events.ts:161-170）、resume 白名单已含（resume.ts）；但**内核从不 emit、无任何实现类、无 worker_threads/child_process**。→ 4C 接上实现即可，接口不动。
3. **`permissionMode` 存了不用**：6 档枚举（enums.ts:44-51）+ SessionState 存储 + RPC 参数，但**无执行期权限检查**（安全漏洞）。→ 4A 落地 PolicyEngine。
4. **`costUsd` 有算法不调用**：catalog.ts:76-88 `estimateCost`（含 cache 分价）已实现，但 kernel emit UsageUpdate 时**直接透传 provider usage、从不算 costUsd**。→ 4F 串接（低工作量）。
5. **审批 / 风险 / checkpoint 三大护栏已完备可复用**：`requestApproval`/`approvalCache`/超时 deny（kernel.ts:544-588）、`assessRisk`/`isProtectedPath`/`DANGEROUS_CMD_RE`（risk.ts）、`ShadowGitCheckpointer` 快照/回滚/列表（checkpoint.ts:33-114）——Phase 4 直接复用，不重造。
6. **Hook 系统仅 MCP 专用**：`McpCallHooks`（mcp-host.ts:93-100）只服务 MCP 调用，**无通用 PreToolUse/PostToolUse 矩阵**。→ 4A 新建通用 hook 矩阵（可借 McpCallHooks 的形态）。
7. **provider 无 fallback/rotation**：三 adapter 独立、`ProviderEvent.Error.retryable` 存在但无 `category`、无链式切换、auth 包仅设备鉴权（非 API key 管理）。→ 4F 补。
8. **skills/recipes 完全没有**：无 `skill_activate`、无懒加载、无 recipe；但 context-files.ts 的 `@import` resolver 已为 skill @-reference 预留共用（注释明示）。→ 4D 复用 resolver。

---

## 已定范围决策（用户已拍板）

| # | 决策点 | 拍板结果 | 落点 |
|---|---|---|---|
| 1 | 工具补全范围 | **一并补齐**：`bash`（4B 高危核心）+ `edit/grep/glob/todo/apply_patch`（4B 低危补全），不留 Phase 6 | 4B |
| 2 | L2 容器隔离 | **顺延 Phase 6**：ExecBackend 接口预留 `docker` 档，本期只实现 L1；退出标准①不依赖容器档 | Phase 6 |
| 3 | OTel 全链路 | **顺延 Phase 6**：本期只做 costUsd 串接 + provider fallback；埋点/exporter/看板留 Phase 6 | Phase 6 |
| 4 | 插件包归属 | **独立成包 `plugin-host`**（隔离 Worker/IPC 依赖，与 surface-acp 独立成包同理） | 4E |
| 5 | ExecBackend 接口归属 | 放 `packages/tools`（工具执行体所在层，默认未再询） | 4A |

---

## 关键决策（ADR 增补，承接 Phase 3 ADR-10~14）

- **ADR-15（护栏底座先行 + 危险能力随护栏同片）**：Phase 4 两大高危能力（exec / plugin）绝不裸建——bash 与 L1 隔离同在 4B，插件与 Worker 隔离同在 4E；共享横切护栏（Hook/权限门/ExecBackend 接口）先在 4A 以纯单测形态固定且不改运行时行为。延续 Phase 3「3A 护栏底座先行」。
- **ADR-16（permissionMode = PolicyEngine，与 assessRisk/approvalCache 正交叠加）**：6 档 permissionMode 在 `assessRisk` 后、`requestApproval` 前做闸门决策，不改既有审批/风险代码（ADR-4 SecurityAnalyzer × ConfirmationPolicy 的兑现）。
- **ADR-17（子 agent = worker_threads 默认 + 崩溃围栏 + 只回摘要）**：默认 `worker_threads`（轻量、崩溃可隔离），`child_process` 留独立 OS 权限接缝；子 agent 独立 EventLog 子树，主 session 只收 `SubagentResult{summary|error}`；policy 只收紧、递归 spawn 防护。
- **ADR-18（插件 = Worker IPC 隔离，独立 `plugin-host` 包）**：插件跑独立 Worker、IPC 通信、env 无 secret、工具走主审批流、心跳重连 + 崩溃降级；独立 `plugin-host` 包隔离依赖（与 surface-acp 独立成包同理）。
- **ADR-19（exec 沙箱 = 同 API 多档 ExecBackend，对工具代码透明）**：`ExecBackend{local-subprocess|docker|ssh-remote}` 同一接口，**本期只实现 L1（local-subprocess）**；L2（docker）+ ssh-remote 接口预留、实现顺延 Phase 6（DESIGN §3.4 / ADR-5 的分档兑现）；切档对 bash 工具代码透明。
- **ADR-14 续用（审查节奏，本阶段收紧为统一规则）**：**所有切片只做实现 + 针对性单测，"大体无误即过"；大规模 Workflow 对抗式审查只在 Phase 4 整体收口一次性做**（覆盖全部切片 + 跨片接缝 = 退出标准①）。**不再对任何单片起 Workflow 审查**——高危切片（4A/4B/4E）改以更厚的针对性安全单测兜底。此为用户明确偏好，覆盖 Phase 3 ADR-14 的"高危逐片审查"例外条款与 ultracode 默认。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| **bash 任意命令执行（Phase 4 最大新增攻击面）** | L0 危险命令 denylist + L1 子进程 secret 剥离 + cwd confine + 风险升级审批 + L3 checkpoint 兜底；4B 厚针对性安全单测 + 收口审查 |
| **secret 泄漏给子进程/插件/子 agent** | env 白名单透传（默认剥离 API key/设备私钥/OAuth token）；注入哨兵 env 断言读不到；secret 永不入日志（沿用 Phase 3 约束） |
| **不可信插件代码拖垮主进程** | Worker IPC 隔离 + 心跳重连 + 崩溃降级；插件走主审批流不可绕；4E 厚针对性安全单测 + 收口审查 |
| **子 agent 无限递归 spawn 烧 token** | deriveSubagentPolicy 默认不下放 subagent_spawn / 限深度；复用 LoopBreaker 多重硬上限 |
| **prompt-cache 漂移（插件/子 agent 工具集动态）** | 复用 registry 既有稳定排序（owner 分组 + 字典序）；工具变更显式重建不热换（Phase 3 ADR 续用） |
| **注入经工具输出回灌上下文** | bash/web_fetch 输出净化标注为不可信数据段；PostToolUse hook 审查 |

---

## 整体收口对抗式安全审查（退出标准①达成）

Phase 4 六片全交付后，跑一次**大规模对抗式安全审查**（Workflow：7 维安全 finder 并发读真实代码 → 每发现 2 棱镜对抗式复核「可利用性 + 可达性」，默认证伪 → 完整性批判），覆盖全部切片 + 跨片接缝。**52 agents、22 候选 → confirmed 12 / likely 4 / rejected 6 + critic 8 gaps**。批判页确认核心不变量多数成立（三处 env 白名单一致剥离 secret、emit 串行链单调 cursor、registry 两段稳定排序、deriveSubagentPolicy 只收紧、clampMcpApproval 非 never、PreToolUse→risk→policy→approval 次序正确）。

**已修（14 项，+13 回归测试锁定）**：
- **【HIGH】confine 符号链接逃逸**（`builtins.ts`）：词法 resolve+relative 不跟随软链 → cwd 内指向外部的软链使 `read`（approval:'never'）外泄 `~/.aws/credentials` 等。改用 realpath 解析后再做前缀校验（与 surface-acp/fs-guard 同一硬化）。
- **【HIGH】accept-edits 无视风险放行 Protected Path 写入**（`policy.ts`）：accept-edits 对编辑类**仅低/中风险**放行，high/unknown（写 `.git/hooks`/`.env`）仍走审批。
- **【HIGH】apply_patch 的 patch 信封路径漏探**（`risk.ts`）：patch 内 `*** Add/Update/Delete File:` 目标路径纳入风险探测，Protected Path 写入正确升 high（堵 autonomous/ci 自动放行）。
- **【MED】approval:'always' 形同 risk-based**（`policy.ts`）：非 bypass 档恒 ask（必经审批契约不被自动放行软化）。
- **【MED】classifyError 漏判 Anthropic/Gemini context-overflow 文案**（`errors.ts`）：补「prompt is too long / exceeds the maximum number of tokens / input token count」+ 400+token 兜底 → 压缩重试安全网不失效。
- **【MED】Anthropic SSE error 事件丢 category**（`anthropic.ts`）：流内 error（overloaded 等）经 classifyError 带归类 → fallback 对早期瞬时错误能触发。
- **【MED】插件工具名冒用 MCP 保留前缀**（`plugin-host/host.ts`）：拒绝 `mcp__` 前缀（防 confused deputy + 撞名 DoS 合法 MCP 工具）。
- **【MED】插件 degrade 重连守卫缺陷**（`plugin-host/host.ts`）：旧 `attempt>0` 启发式在首次重连后截断重连链且漏 terminate；改用显式 `reconnecting` 标志 + 始终 terminate。
- **【MED】routeIdx 跨 turn 粘滞永久弃用主路由**（`kernel.ts`）：每 turn 起点回探主路由（瞬时错误不致永久降级）。
- **【MED】steer() 破坏 user/assistant 交替**（`kernel.ts`）：与 drainSteering 共用 `appendUserText`（并入末条 user）。
- **【MED】endSession 不回收背景子 agent / 不 abort 在跑 turn**（`kernel.ts`+`subagent.ts`）：endSession abort `turnAbort` + 经 `sessionReaper` 调 `abortInflight(sid)`；`abortInflight` 改为**按父会话作用域**（不误杀他会话）。
- **【LOW】DANGEROUS_CMD_RE 漏网**（`risk.ts`）：补 `dd of=`、NVMe/mmcblk/vd/disk 设备重定向、`find … -delete`（不误伤 /dev/null）。
- **【LOW】bash 溢出写盘默认权限**（`bash.ts`）：tmp 文件 mode `0o600`（防同主机他用户读命令输出）。
- **【LOW】skills/recipes 无大小上限 OOM**（`skills.ts`/`recipes.ts`）：单文件 >1 MiB 跳过。

**记入已知限制（设计边界 / 越界 3G 反向通道 / 已声明顺延，见下）**：插件订阅 hook 的工具 I/O 数据面可见性、MCP sampling/OAuth 治理（Phase 3G）、resume 路径 cursor、loop-breaker 仅 exact-repeat、exec-local extra env 覆盖（非 live）、read 读 cwd 内本地 Protected 文件（symlink 逃逸已堵）。

## 已知限制（明示，不在 Phase 4 收口）

- **插件 hook 数据面可见性**（收口 gap#1）：插件订阅 PreToolUse/PostToolUse/UserPromptSubmit 会收到对应工具 I/O（命令/输入/输出/用户 prompt）。这是 hook 模型固有语义（同 Claude Code hooks 见工具 I/O），插件为**用户自装**扩展（信任边界同 MCP server）；Phase 4 强制的「secret 绝不入插件」不变量针对**进程 env secret**（已白名单剥离），工具 I/O 数据面机密性留作后续可选脱敏/作用域过滤。
- **MCP 反向通道治理**（收口 gap#4/#5，Phase 3G 既有面）：外部 MCP server 的 sampling 反向请求是否经 4F cost/loop-breaker/approval、OAuth token 存储/日志路径——属 3G surface，留 Phase 5/6 专项核查。
- **loop-breaker 仅 exact-repeat**（收口 gap#7）：仅熔断 name+input 完全相同的重复；变形/不同名刷屏的 cost/DoS 防护依赖另三种 loop 模式（DESIGN 已声明顺延）。技能/recipe 大小上限已堵单文件 OOM，缩小爆炸半径。
- **exec-local extra env 覆盖**（收口 gap#8，非 live）：调用方 `extra` env 在白名单之后合并可覆盖 PATH；当前无面向模型的调用方传 env（bash 不传），属防御纵深，留注记。
- **L2 容器隔离（Docker/Podman）**：用户拍板顺延 Phase 6；ExecBackend `docker` 档接口预留，本期只实现 L1。
- **OTel 全链路 + metrics 看板**：用户拍板顺延 Phase 6；本期只做 costUsd 串接 + provider fallback/rotation。
- **不追求 OS 级强沙箱完备性**（DESIGN §0.2）：L1 子进程是务实折中，非内核级隔离；明示残余风险。
- **`ssh-remote` ExecBackend 档**：接口预留，实现留 Phase 6。
- **向量 RAG 长期记忆 / 多用户授权矩阵**：留 Phase 6。

---

## 退出标准 —— Phase 4 达成判据

1. **退出标准①（安全审查通过）✅**：整体收口大规模对抗式安全审查已跑（52 agents，覆盖全部切片 + 跨片接缝）；confirmed 12 项缺陷**全修**（含 3 HIGH）+ 13 回归测试锁定，余项记入已知限制；回归全绿（443 测试）。
2. **退出标准②（子 agent 崩溃不拖垮主循环）✅**：4C 故意崩溃子 agent 离线单测——主 turn 收 `SubagentResult{error}` 并继续、主循环存活。
3. **退出标准③（插件隔离生效）✅**：4E 故意崩溃/越权插件离线单测——主进程存活 + 心跳降级 + 插件读不到 secret。

**验证门**：`pnpm run check` —— typecheck 0 错误 + JSON Schema 全量 gen + 测试在 Phase 3 的 **307 基线**上**只增不减**全绿；每片末跑全量回归。**对抗式审查节奏（ADR-14 收紧）**：所有切片只做实现 + 针对性单测，"大体无误即过"；大规模对抗式审查统一在 Phase 4 整体收口一次性做（覆盖全部切片 + 跨片接缝）。**真机冒烟**：4B 子进程跑命令（无网络依赖、CI 可跑）。

---

## 后续（Phase 5/6 接力）

- **Phase 5（聊天平台开放渠道）**：ChatSurface（Transport+Adapter 二层 + OneBot v11 优先）+ DM pairing + 聊天态 ConfirmationPolicy（AlwaysConfirm + 配对码）+ 群/频道级 yo.md——**依赖 Phase 4 安全底座**。
- **Phase 6**：**L2 容器隔离（Docker/Podman ExecBackend）** + **OTel 全链路 + metrics 看板** + `ssh-remote` ExecBackend；repo map（tree-sitter）；向量 RAG（Memory MCP）；多用户/团队授权矩阵；skills evals + CI 评测门。
