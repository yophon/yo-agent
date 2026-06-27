# Phase 4 —— 子 agent + 沙箱加固 + 可观测 + 插件（开放渠道前的安全/健壮性底座）

> 对应 [`DESIGN.md`](DESIGN.md) §13 Phase 4 / §2.5（子 agent）/ §3.2-3.4（工具与沙箱）/ §4.4（fallback/rotation）/ §8（扩展机制）/ §11（hooks）。延续 Phase 0-3 的「离线可验证 / 风险优先 / 护栏底座先行」分片：每片用进程内/内存对驱 + worker_threads/child_process 本机隔离单测验证，**不依赖外部网络或第三方 server**；需真机子进程/容器/OTLP 的能力仅在指定切片末做一次门控冒烟（对齐 Phase 1/2/3 范式）。
>
> **Phase 3 收口基线**：307 测试（37 文件，1 真机冒烟门控跳过）全绿。本阶段在此之上增量交付，每片末跑全量回归不退化。
>
> **本计划已经过代码级现状勘察（7 子系统）+ 风险优先切片设计**。勘察核实并修正了若干「DESIGN 以为 Phase 1 已建、实则现状缺失」的关键误判，见 [§现状已核实修正](#现状已核实修正避免重复造轮)——**最重要的一条：编程 agent 的命脉工具 `bash/execute` 至今不存在**，Phase 4 的沙箱必须连这把工具一起从零建，而非「给已有工具加隔离」。

---

## 范围与排序原则

Phase 4 是**聊天平台开放渠道（Phase 5）的前置安全/健壮性底座**。三条退出标准（DESIGN §13 Phase 4）：

1. **安全审查通过**（exec 沙箱 + 危险命令/注入防护 + 权限模式落地经对抗式审查）。
2. **子 agent 崩溃不拖垮主循环**（Worker 隔离 + 崩溃围栏）。
3. **插件隔离生效**（不可信插件代码经 Worker IPC 隔离运行，崩溃不波及主进程）。

外加一组健壮性打磨：可观测（OTel + 用量计费串接）、provider fallback 链 / auth rotation、recipes/skills 懒加载。

**排序原则（风险优先 / 护栏底座先行，与 Phase 3 一致）**：Phase 4 引入两个 yo-agent 至今没有的**最高危能力**——**执行任意 shell 命令**（bash 工具）与**运行不可信插件代码**（plugin）。所有最危险的失败模式（命令逃出 workspace、读到 yo-agent 自身 secret、危险命令毁盘、注入式工具输出污染上下文、插件崩溃拖垮主进程、子 agent 无限递归 spawn）都在这两个能力落地那一刻触发。因此：
- **先做纯内核、纯单测可验的横切护栏底座（4A：Hook 矩阵 + permissionMode 落地 + ExecBackend 抽象）**，再让危险能力落到这套护栏上。
- **危险能力随其护栏同片交付**（bash 与 L1 隔离同在 4B；插件与 Worker 隔离同在 4F），绝不「先裸建能力、后补隔离」。
- 高危切片（4B exec / 4C 容器 / 4F 插件 / 4A 权限门）触及不可信输入/代码执行/审批面，按 ADR-14 例外**逐片对抗式审查**；4D/4E/4G 走「实现 + 单测，大体无误即过」，随 Phase 4 整体收口统一审查。

### 退出标准达成口径（写死，否则达成度无法判定）

- **退出标准①（安全审查通过）**：4B/4C/4F 逐片对抗式审查 + Phase 4 整体收口一次大规模安全向对抗式审查（finder→adversarial verify→completeness critic），确认缺陷全修、回归测试全绿。
- **退出标准②（子 agent 崩溃不拖垮主循环）**：在 4D 用一个**故意崩溃的子 agent**（Worker 内抛未捕获异常 / 主动 `process.exit` 等价物）离线单测验证——主 turn 收到 `SubagentResult{error 摘要}` 并继续，主循环不挂死、不静默吞错。
- **退出标准③（插件隔离生效）**：在 4F 用一个**故意崩溃/越权的插件**离线单测验证——插件 Worker 崩溃 → 主进程存活 + 心跳检测到 + 该插件工具自动降级不可见；插件无法读到主进程 secret env。
- **真机冒烟（门控，非 CI 必跑）**：4B 末本机真实子进程跑一条命令（无网络依赖，CI 可跑）；4C 末 `YO_DOCKER_SMOKE=1` 真实 Docker exec 一条命令；4G 末 `YO_OTEL_SMOKE=1` 导出 span 到本地 OTLP collector。

---

## 切片总览

| 片 | 标题 | 服务退出标准 | 依赖 | 新建包 | 离线可验证 |
|---|---|---|---|---|---|
| **4A** | 横切底座：生命周期 Hook 矩阵（进程内）+ permissionMode→PolicyEngine 落地 + ExecBackend 抽象（**无执行/无隔离行为变更**） | ①②③ 前置 | — | — | 📋 计划 |
| **4B** | `bash/execute` 工具 + **L1 子进程隔离**（LocalSubprocessExecBackend）+ 危险命令/注入三阶段审查 | ① | 4A | — | 📋 计划（+真机子进程） |
| **4C** | **L2 容器隔离**（opt-in Docker/Podman ExecBackend，同 API 三档） | ① | 4B | — | 📋 计划（+门控 docker 冒烟） |
| **4D** | **SubagentManager**（worker_threads 隔离 + 崩溃围栏 + 异步 steering + deriveSubagentPolicy + `subagent_spawn` 工具） | ② | 4A | — | 📋 计划 |
| **4E** | recipes/skills 懒加载（subagent profile + `skill_activate` + 探索工具补全 grep/glob） | 赋能②③ | 4D | — | 📋 计划 |
| **4F** | **插件 SDK**（Worker IPC 隔离 + 心跳重连）+ Hook 矩阵跨进程兑现 | ③ | 4A | `plugin-host` | 📋 计划 |
| **4G** | 可观测：`costUsd` 串接 + OTel 全链路 + **provider fallback 链 / auth rotation** | 健壮性 | 4A | — | 📋 计划（+门控 OTLP 冒烟） |

> 4A 是 4B/4D/4F 的共享前置（Hook 点、权限门、ExecBackend 接口三者跨 exec/subagent/plugin 复用）。4B→4C 是 ExecBackend 抽象→第二档实现的自然递进。4D/4E（子 agent + recipe）与 4F（插件）都消费 4A 的 Hook 矩阵，可并行。4G（可观测/fallback）与上述大体正交，可穿插。**`bash` 工具补全是 4B 的隐含前提**（详见 §现状已核实修正）。

---

## 4A — 横切底座：Hook 矩阵 + permissionMode 落地 + ExecBackend 抽象（无执行/无隔离）📋 计划

**目标**：把 Phase 4 三大危险能力（exec / subagent / plugin）共享的三条内核接缝**先以纯本地、纯单测可验的形态固定下来**，且**不改变任何现有运行时行为**（行为变更全部推迟到落能力的切片）。这是 Phase 4 的「3A 式护栏底座」。

**交付物**：
1. **生命周期 Hook 矩阵（进程内先行）**：在 kernel turn 循环的确定性位点暴露 hook：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreCompact`、`Stop`、`SubagentStart`/`SubagentStop`、`OnApproval`（对齐 DESIGN §11 hook 矩阵 + Claude Code 范式）。本片只做**进程内同步 hook 注册表 + 调用点**（不可信插件的跨进程 Worker 隔离留 4F）。`PreToolUse` 可返回「拦截/改写 input/放行」三态——这是「确定性强制」类约束（§8 决策矩阵：commit 前跑测试应走 PreToolUse hook 而非写 yo.md）的落点。
2. **permissionMode → PolicyEngine 落地**：现状 `permissionMode` 有 6 档（`read-only|supervised|accept-edits|autonomous|ci|bypass`，protocol/enums.ts）但**存了不用**（无执行期检查，安全漏洞）。本片实现 `PolicyEngine`：在 `assessRisk` 之后、`requestApproval` 之前按 mode 决策——`read-only` 拦所有 edit/execute/delete；`supervised` 走审批；`accept-edits` 自动放行 edit 类、其余审批；`autonomous` 按 risk 决策；`ci` 非交互按 allowlist；`bypass` 全放行（明示危险）。与既有 `approvalCache`/`assessRisk` 正交叠加（ADR-4：SecurityAnalyzer × ConfirmationPolicy）。
3. **ExecBackend 抽象接口**：定义 `interface ExecBackend { kind; exec(cmd, opts): AsyncIterable<{chunk; exitCode?}> }`（DESIGN §3.4），本片**只定义接口 + 一个 no-op/未注册占位**，不接任何真实执行（bash 工具 + 真实 backend 在 4B）。

**触及**：`packages/kernel`、`packages/protocol`（hook 点若需事件化 / `PermissionMode` 已存在无需改）、`packages/tools`（ExecBackend 接口归属 tools 还是 kernel——见待决）。**退出标准**：
- Hook 矩阵：每个 hook 点有注册/触发单测；`PreToolUse` 拦截/改写/放行三态生效（用 stub hook 验证 input 被改写后工具收到新 input、拦截后工具不执行）。
- PolicyEngine：6 档 permissionMode × 各 ToolKind 的决策矩阵全覆盖单测；`read-only` 下 write/execute 被拦且**不触发审批**；`bypass` 全放行；与 `approvalCache` 叠加不冲突。
- ExecBackend 接口存在 + 占位不被误用（无 bash 工具注册时调不到）。
- **行为不变量**：现有 307 测试全绿、无一改写期望值（本片不改运行时行为）。
- **审查节奏（ADR-14）**：本片是权限门/审批面的核心改动（高危例外），**逐片对抗式审查**——重点验「permissionMode 决策不可被绕过」「PreToolUse 拦截后工具确实不执行」「hook 异常不吞掉/不拖垮 turn」。

---

## 4B — `bash/execute` 工具 + L1 子进程隔离 + 危险命令/注入三阶段审查 📋 计划

**目标**：从零建编程 agent 的命脉工具 `bash`（现状不存在，见 §现状已核实修正），且**与其唯一安全护栏 L1 子进程隔离同片交付**——这是 Phase 4 安全的核心。

**交付物**：
1. **`bash`/`execute` 工具**：`kind:'execute'`、`approval:'risk-based'`（绝不 `'never'`）、流式输出、可后台（`BackgroundProcess` 事件已定义）、大输出写盘只回路径（DESIGN §2.2 `truncatedToPath`，nanobot 50KiB 阈值）。
2. **`LocalSubprocessExecBackend`（L1，默认生产）**：在独立 `child_process` 跑，**受限 env（剥离 yo-agent 自身 secret：API key / 设备私钥 / OAuth token，白名单透传）+ workspace 内受限 cwd（confine，复用 builtins 的 `confine`）+ per-call 超时 + abort 信号（接 turn/interrupt）+ 可选独立低权 OS 用户**（DESIGN §3.4 L1）。
3. **危险命令防护强化**：复用并扩展 `risk.ts` 的 `DANGEROUS_CMD_RE`（已覆盖 `rm -rf`/`mkfs`/`dd`/fork bomb/`shutdown` 等），bash input 必经风险评估升 high → 走审批。
4. **注入防护**：工具输出（尤其 bash stdout / 后续 web_fetch）注入上下文前做净化标注（标记为不可信数据段，降低 prompt injection 经工具输出回灌的风险）。
5. **三阶段审查接线**：bash 执行经 4A 的 `PreToolUse`（命令静态/策略检查）→ 执行 → `PostToolUse`（输出审查）三阶段（DESIGN §3.4 + §11）。

**触及**：`packages/tools`、`packages/kernel`、`packages/protocol`（如需补 exec 相关事件字段）。**退出标准**：
- bash 工具经 `LocalSubprocessExecBackend` 真实跑通本机命令（`echo`/`pwd`，**无网络依赖、CI 可跑非门控**）；流式输出 + exitCode 正确；大输出写盘回路径。
- 隔离：子进程 env **不含** yo-agent secret（注入哨兵 env 后断言子进程读不到）；cwd 越界命令（`cd /etc && cat passwd` 类）被 confine + 风险升级拦；超时与 turn/interrupt 能杀子进程。
- 危险命令（`rm -rf /` 等）→ risk high → 审批（`read-only`/无审批环境下直接拒）。
- **审查节奏（ADR-14）**：**高危例外，逐片对抗式审查**——这是 Phase 4 最危险的一片，重点验「secret 不泄漏给子进程」「cwd 逃逸」「危险命令绕过」「abort 不留孤儿进程」「注入输出不被当指令」。
- **真机冒烟**：本机子进程跑一条真实命令（已含在单测，非门控）。

---

## 4C — L2 容器隔离（opt-in Docker/Podman ExecBackend）📋 计划

**目标**：为开放渠道 / 不可信任务提供更强隔离档——`bash`/`apply_patch` 在容器内执行，workspace 以 volume 挂载（DESIGN §3.4 L2，"同一 API 三档 Workspace"）。

**交付物**：`DockerExecBackend implements ExecBackend`（与 4A 接口对称）：`docker/podman exec` 委派、workspace volume 挂载、容器内受限网络/能力、镜像可配。opt-in（默认仍 L1），不可信场景强制 L2（接 4A PolicyEngine：某 permissionMode/profile → 强制容器档）。

**触及**：`packages/tools`（或 exec backend 所在包）、`apps/yo-agent`（配置）。**退出标准**：
- 离线：用 stub/mock 的容器 exec 验证 ExecBackend 契约一致（同 API 切档对工具代码透明）；volume 路径映射 + 越界拒的逻辑单测。
- **门控真机冒烟**：`YO_DOCKER_SMOKE=1` 起真实容器跑一条命令、读回 workspace 挂载文件（无 Docker 环境自动跳过，对齐 3C MCP 冒烟门控范式）。
- **审查节奏（ADR-14）**：高危（容器逃逸/挂载越权）——逐片或随 4B 一并审查（视实现耦合度，收口前定）。

---

## 4D — SubagentManager（Worker 隔离 + 崩溃围栏 + 异步 steering）📋 计划

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

---

## 4E — recipes/skills 懒加载（subagent profile + skill_activate + 探索工具补全）📋 计划

**目标**：补齐 DESIGN §5/§8 的声明式扩展——skill 懒加载 + 子 agent recipe（profile），并补全子 agent 探索所需的 grep/glob 工具。

**交付物**：
1. **`skill_activate` 工具 + skills 懒加载**：skill 摘要进上下文、激活时才加载全文（复用 context-files.ts 的 `@import` resolver——勘察确认该 resolver 已为 skill @-reference 预留共用）；skills 内容压缩时受保护不被截断（DESIGN §5.4，opencode `PRUNE_PROTECTED_TOOLS`）。
2. **subagent recipe/profile 加载**：YAML/MD 定义子 agent（工具白名单 + 独立 prompt + 绑定 model），喂给 4D 的 `profile` 参数（Roo mode / Goose Recipes 范式）；project 级 `.yo-agent/skills/` 与 `.yo-agent/agents/` 提交 git 即全队共享。
3. **探索工具补全 `grep`/`glob`**（`kind:'search'`，DESIGN §3.2）：子 agent explore 场景刚需；ripgrep 内容搜索 + 文件名 glob，confine cwd。

**触及**：`packages/tools`、`packages/kernel`（context 装配 + 压缩保护）、`apps/yo-agent`。**退出标准**：
- skill 摘要注入 + 激活加载全文 + 压缩不被截断（专测）；recipe 加载 → 4D spawn 用其工具白名单（与 deriveSubagentPolicy 叠加）。
- grep/glob 跑通 + confine 越界拒。
- **审查节奏（ADR-14）**：纯本地，实现 + 针对性单测，随收口统一审查。

---

## 4F — 插件 SDK（Worker IPC 隔离 + 心跳重连）+ Hook 矩阵跨进程兑现 📋 计划

**目标**：让第三方插件（不可信代码）注册工具/消费 hook，但**在 Worker 进程内 IPC 隔离运行，崩溃不拖垮主进程（退出标准③）**。

**交付物**：
1. **Plugin SDK**：插件声明可注册 `ToolDescriptor{owner:'plugin'}`（registry 已支持 owner 概念 + 稳定排序）+ 订阅 4A 的 hook 点。
2. **Worker IPC 隔离**：插件跑在独立 Worker，经结构化 IPC 与主进程通信（3 种 IPC + 心跳重连，LangBot 范式）；**插件 env 不含主进程 secret**；插件工具执行仍走主内核审批流（不可 `approval:'never'` 绕过）。
3. **崩溃围栏 + 心跳**：插件 Worker 崩溃 → 主进程存活、心跳检测、该插件工具自动降级不可见（接 4A availability/flag 机制）；重连恢复。
4. **Hook 矩阵跨进程兑现**：4A 的进程内 hook 升级为可被 out-of-process 插件消费（hook 调用经 IPC，超时/崩溃不阻塞主 turn）。

**触及**：`packages/plugin-host`（新）、`packages/kernel`、`packages/tools`、`apps/yo-agent`。**退出标准**：
- 故意崩溃/越权插件 → 主进程存活 + 心跳检测 + 工具降级（**退出标准③ 离线达成**）；插件读不到主进程 secret env。
- 插件工具经主内核审批流（不能绕审批）；插件 hook 异常/超时不拖垮主 turn。
- prompt-cache 稳定性：插件工具按 owner 排序进上下文不漂移（复用 registry 既有稳定排序）。
- **审查节奏（ADR-14）**：**高危例外（不可信代码执行），逐片对抗式审查**——重点验「插件无法读 secret」「崩溃不波及主进程」「不能绕审批」「IPC 反序列化安全」。

---

## 4G — 可观测：costUsd 串接 + OTel 全链路 + provider fallback/rotation 📋 计划

**目标**：补齐健壮性可观测面与多 provider 韧性。

**交付物**：
1. **`costUsd` 串接**：现状 `catalog.estimateCost` 已实现但**从不被调用**（勘察确认）。本片在 `UsageUpdate`/`TurnCompleted` emit 前调 `estimateCost(model, usage)` 填 `costUsd`；用量落盘 `usage` 表（DESIGN §4.4）。
2. **OTel 全链路**：kernel/provider/tools 关键位点埋 span/metrics（turn/step/tool/provider 调用）；exporter opt-in（默认 no-op，避免强依赖）。
3. **provider fallback 链 / auth rotation**：在 ProviderEvent.Error 补 `category`（`rate_limit|billing|auth|context_overflow|network`，现仅有 `retryable` 布尔）；内核据此决策——`rate_limit`→换 key/换 provider，`context_overflow`→触发 compaction，`billing/auth`→换 provider（DESIGN §4.4，LangBot/OpenClaw 范式）；**工具调用循环内 commit 首个成功模型**避免跨模型 tool_result 解读不一致（LangBot 教训）。

**触及**：`packages/provider`、`packages/kernel`、`packages/store`（usage 表）、`packages/protocol`（Error.category）。**退出标准**：
- `TurnCompleted.costUsd` 经 estimateCost 正确填充（含 cache 读写分价）；usage 落盘可查。
- OTel：内存 span exporter 验证 turn/tool/provider span 链完整；`YO_OTEL_SMOKE=1` 门控真实 OTLP 导出。
- fallback：注入各类错误 → 决策正确（rate_limit 换 key、context_overflow 触发压缩、billing 换 provider）；循环内不跨模型漂移。
- **审查节奏（ADR-14）**：实现 + 单测；auth rotation 涉及 secret，secret 不入日志（沿用 Phase 3 约束）随收口审查。

---

## 现状已核实修正（避免重复造轮）

代码级勘察（7 子系统）核实，DESIGN/README 与实际交付存在以下差异，**直接影响 Phase 4 切片定义**：

1. **【最重要】`bash`/`execute`/`edit`/`grep`/`glob`/`todo` 工具至今不存在**——实际内置工具只有 `read/write/ls`（builtins.ts:81，PHASE-1.md:20 亲口承认、真机仅验 `ls`）。DESIGN §3.2 / §13 Phase 1 列的完整工具集是**计划而非现状**。**后果**：Phase 4「L1 子进程隔离」不是「给已有 bash 加隔离」，而是**连 bash 工具一起从零建**（4B）；探索工具 grep/glob 也需补（4E）。
2. **`SubagentManager` 接口已冻结但零实现**：kernel/index.ts:107-122 有完整 `SubagentSpawnOpts`（含 `isolation:'none'|'worktree'|'container'`、`mode`、`profile`）+ `spawn()` 签名；`SubagentStarted`/`SubagentResult` 事件已定义（events.ts:161-170）、resume 白名单已含（resume.ts）；但**内核从不 emit、无任何实现类、无 worker_threads/child_process**。→ 4D 接上实现即可，接口不动。
3. **`permissionMode` 存了不用**：6 档枚举（enums.ts:44-51）+ SessionState 存储 + RPC 参数，但**无执行期权限检查**（安全漏洞）。→ 4A 落地 PolicyEngine。
4. **`costUsd` 有算法不调用**：catalog.ts:76-88 `estimateCost`（含 cache 分价）已实现，但 kernel emit UsageUpdate 时**直接透传 provider usage、从不算 costUsd**。→ 4G 串接（低工作量）。
5. **审批 / 风险 / checkpoint 三大护栏已完备可复用**：`requestApproval`/`approvalCache`/超时 deny（kernel.ts:544-588）、`assessRisk`/`isProtectedPath`/`DANGEROUS_CMD_RE`（risk.ts）、`ShadowGitCheckpointer` 快照/回滚/列表（checkpoint.ts:33-114）——Phase 4 直接复用，不重造。
6. **Hook 系统仅 MCP 专用**：`McpCallHooks`（mcp-host.ts:93-100）只服务 MCP 调用，**无通用 PreToolUse/PostToolUse 矩阵**。→ 4A 新建通用 hook 矩阵（可借 McpCallHooks 的形态）。
7. **provider 无 fallback/rotation**：三 adapter 独立、`ProviderEvent.Error.retryable` 存在但无 `category`、无链式切换、auth 包仅设备鉴权（非 API key 管理）。→ 4G 补。
8. **skills/recipes 完全没有**：无 `skill_activate`、无懒加载、无 recipe；但 context-files.ts 的 `@import` resolver 已为 skill @-reference 预留共用（注释明示）。→ 4E 复用 resolver。

---

## 关键决策（ADR 增补，承接 Phase 3 ADR-10~14）

- **ADR-15（护栏底座先行 + 危险能力随护栏同片）**：Phase 4 两大高危能力（exec / plugin）绝不裸建——bash 与 L1 隔离同在 4B，插件与 Worker 隔离同在 4F；共享横切护栏（Hook/权限门/ExecBackend 接口）先在 4A 以纯单测形态固定且不改运行时行为。延续 Phase 3「3A 护栏底座先行」。
- **ADR-16（permissionMode = PolicyEngine，与 assessRisk/approvalCache 正交叠加）**：6 档 permissionMode 在 `assessRisk` 后、`requestApproval` 前做闸门决策，不改既有审批/风险代码（ADR-4 SecurityAnalyzer × ConfirmationPolicy 的兑现）。
- **ADR-17（子 agent = worker_threads 默认 + 崩溃围栏 + 只回摘要）**：默认 `worker_threads`（轻量、崩溃可隔离），`child_process` 留独立 OS 权限接缝；子 agent 独立 EventLog 子树，主 session 只收 `SubagentResult{summary|error}`；policy 只收紧、递归 spawn 防护。
- **ADR-18（插件 = Worker IPC 隔离，不可信代码默认隔离）**：插件跑独立 Worker、IPC 通信、env 无 secret、工具走主审批流、心跳重连 + 崩溃降级；独立 `plugin-host` 包隔离依赖（与 surface-acp 独立成包同理）。
- **ADR-19（exec 沙箱 = 同 API 三档 ExecBackend，对工具代码透明）**：`ExecBackend{local-subprocess|docker|ssh-remote}` 同一接口，L1 默认 / L2 容器 opt-in / 不可信场景强制 L2（DESIGN §3.4 / ADR-5 的兑现）；切档对 bash 工具代码透明。
- **ADR-14 续用（审查节奏）**：Phase 4 高危面更广——**4A（权限门）/4B（任意命令执行）/4C（容器）/4F（不可信插件）逐片对抗式审查**（ADR-14 例外条款）；4D/4E/4G 走「实现 + 单测，大体无误即过」，随 Phase 4 整体收口统一大规模安全向审查（= 退出标准①）。

---

## 待决问题（实现前需拍板）

1. **bash 工具补全归属与范围确认**：确认 Phase 4 应连 `bash` 一起从零建（DESIGN 误以为 Phase 1 已有）。`edit`（精确替换）/`apply_patch`（多文件）/`todo_write` 是否一并补，还是只补 exec 安全相关的 `bash` + 探索用 `grep/glob`？（建议：4B 只补 `bash`，4E 补 `grep/glob`；`edit/apply_patch/todo` 列「工具集补全」可穿插或留 Phase 6 打磨。）
2. **ExecBackend 接口归属**：放 `packages/tools`（与工具同包）还是 `packages/kernel`（与 sandbox policy 同层）？（倾向 tools，工具执行体归属。）
3. **OTel 深度**：Phase 4 做「埋点 + 内存/OTLP exporter opt-in」即可，还是要完整 metrics 看板？（建议：埋点 + opt-in exporter，看板留 Phase 6。）
4. **插件包是否独立成包 `plugin-host`**：倾向独立（隔离 Worker/IPC 依赖），与 ADR-18 一致；待确认。
5. **L2 容器是否进 Phase 4**：DESIGN 列入 Phase 4，但容器依赖最重、最难离线。是否像 3G 隔离 OAuth 那样把 4C 设为「不阻塞退出标准、可顺延」的隔离片？（建议：4C 离线只验契约，真机门控；若工期紧可顺延 Phase 6，退出标准①不依赖容器档。）

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| **bash 任意命令执行（Phase 4 最大新增攻击面）** | L0 危险命令 denylist + L1 子进程 secret 剥离 + cwd confine + 风险升级审批 + L3 checkpoint 兜底；4B 逐片对抗式审查 |
| **secret 泄漏给子进程/插件/子 agent** | env 白名单透传（默认剥离 API key/设备私钥/OAuth token）；注入哨兵 env 断言读不到；secret 永不入日志（沿用 Phase 3 约束） |
| **不可信插件代码拖垮主进程** | Worker IPC 隔离 + 心跳重连 + 崩溃降级；插件走主审批流不可绕；4F 逐片审查 |
| **子 agent 无限递归 spawn 烧 token** | deriveSubagentPolicy 默认不下放 subagent_spawn / 限深度；复用 LoopBreaker 多重硬上限 |
| **prompt-cache 漂移（插件/子 agent 工具集动态）** | 复用 registry 既有稳定排序（owner 分组 + 字典序）；工具变更显式重建不热换（Phase 3 ADR 续用） |
| **注入经工具输出回灌上下文** | bash/web_fetch 输出净化标注为不可信数据段；PostToolUse hook 审查 |
| **OTel/容器引入重依赖** | 全 opt-in（默认 no-op exporter / 默认 L1）；离线只验契约，真机门控冒烟 |

---

## 已知限制（明示，不在 Phase 4 收口）

- **不追求 OS 级强沙箱完备性**（DESIGN §0.2）：L1 子进程 + L2 容器是务实折中，非内核级隔离；明示残余风险。
- **`ssh-remote` ExecBackend 档**：接口预留，实现留 Phase 6。
- **向量 RAG 长期记忆**：留 Phase 6（Memory MCP）。
- **多用户/团队授权矩阵**：留 Phase 6。
- **完整 metrics 看板 / 多 exporter**：Phase 4 只做埋点 + opt-in exporter。

---

## 退出标准 —— Phase 4 达成判据

1. **退出标准①（安全审查通过）**：4A/4B/4C/4F 逐片对抗式审查 + Phase 4 整体收口一次大规模安全向对抗式审查，确认缺陷全修、回归全绿。
2. **退出标准②（子 agent 崩溃不拖垮主循环）**：4D 故意崩溃子 agent 离线单测——主 turn 收 `SubagentResult{error}` 并继续、主循环存活。
3. **退出标准③（插件隔离生效）**：4F 故意崩溃/越权插件离线单测——主进程存活 + 心跳降级 + 插件读不到 secret。

**验证门**：`pnpm run check` —— typecheck 0 错误 + JSON Schema 全量 gen + 测试在 Phase 3 的 **307 基线**上**只增不减**全绿；每片末跑全量回归。**对抗式审查节奏（ADR-14 + ADR-15~19）**：4A/4B/4C/4F（高危：权限门/任意命令/容器/不可信插件）逐片审查；4D/4E/4G 随 Phase 4 整体收口统一审查。**真机冒烟（门控）**：4B 子进程（CI 可跑）/ 4C `YO_DOCKER_SMOKE=1` / 4G `YO_OTEL_SMOKE=1`。

---

## 后续（Phase 5/6 接力）

- **Phase 5（聊天平台开放渠道）**：ChatSurface（Transport+Adapter 二层 + OneBot v11 优先）+ DM pairing + 聊天态 ConfirmationPolicy（AlwaysConfirm + 配对码）+ 群/频道级 yo.md——**依赖 Phase 4 安全底座**。
- **Phase 6**：repo map（tree-sitter）；向量 RAG（Memory MCP）；`ssh-remote` ExecBackend；多用户/团队授权矩阵；skills evals + CI 评测门；OTel metrics 看板；`edit/apply_patch/todo` 等工具集打磨补全。
