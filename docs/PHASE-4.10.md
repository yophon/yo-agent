# Phase 4.10 —— 真机反馈闭环:熔断降敏与子代理并行可观测(已立项)

> 起因:4.9 期中真机反馈 [`feedback/4.9.md`](feedback/4.9.md) 两条硬伤——
> ① LLM 并行意图的多次 `subagent_spawn` 被「检测到死循环」熔断(用户明确"先关掉/降敏,
> 现在的 ai 也一般不会那么笨了,反而是个阻碍");② 模型一次响应多个 tool_use 时 kernel
> 串行执行,"并行包装器"实际串行,且子代理运行中无法单独查看(对标 Claude Code 任务面板)。
>
> **基线**:4.9 收口(2026-07-02)617 测试全绿(75 文件,616 passed + 1 skipped),
> `pnpm check` 门(typecheck + lint + schema 漂移 + test)通过。
>
> **范围拍板**:大规模对抗式审查(4.5–4.9 TUI 全量 + 4.9 审批上浮/注入面/memory_write
> 写入面)**移出本阶段,以后再说**,见 §2 非目标。其余候选池条目未立项的保留在 §3。

---

## 0. 现状核对(立项时实测,2026-07-02)

熔断误伤不是"键没含入参"——键早就含了。三个叠加根因:

1. **生产跑的是测试阈值**:`main.ts:210/237` `new HistoryLoopBreaker()` 无参构造,
   落到 `loop-breaker.ts:21-23` 的默认 break=3 / warn=2 / window=30——模块头注释自认
   「默认阈值偏小便于测试,生产可配(DESIGN 用 10/30)」,但生产从未配过。
2. **批内并行调用互相计重**:键 = `name|stableStringify(input)`(`loop-breaker.ts:27`),
   真机场景是一批 3 个「回 hi」的 spawn **入参完全相同**→ 3 次撞键即熔断。并行语义天然
   不是死循环,但计数器不区分"同一 assistant 响应批内"与"跨 turn 重复"。
3. **warn 档是死码**:`check()` 会返回 `'warn'`,但 kernel 对该返回值 **0 处理**
   (全文无 `'warn'` 分支);DESIGN §2.3 约定 WARN_THRESHOLD=10 时**注入提醒**,未兑现。

串行根因:`kernel.ts:579` tool 循环 `for (const tc of toolCalls)` 逐个 await,
loop-breaker 检查、PreToolUse hook、权限闸门、审批、`exec.execute`(`kernel.ts:694`
for-await 流式消费)全在循环体内——多 tool_use 批次没有任何并发路径。

可观测现状:子代理事件走独立 childSessionId 子树 EventLog(已隔离可读),但 TUI 无
任务列表/进入查看入口,背景 spawn 只能等结果。

## 1. 切片规划

顺序 a→c:a 修误伤(最小改动先解阻碍),b 做并发(依赖 a 的"批内不计重",否则并发批
必撞熔断),c 是 b 的体验收口(并行跑起来才有"多任务可看"的需求)。

### 4.10a loop-breaker 降敏与档位可配 ⚠️ 高优先级

- **批内豁免**:同一 assistant 响应批次内的多个 tool_use 不互相计重(计数以"批"为粒度
  或对批内调用只记 1 次)——直接修真机误伤的根,且是 4.10b 并发执行的前置。
- **工具豁免清单**:spawn / read 类天然可重复调用的工具不参与计重(kernel opts 传豁免
  名单,或 ToolDescriptor 标注;倾向前者,不动协议)。
- **生产阈值对齐 DESIGN §2.3**:break 抬到 10(窗口 30 不变);warn 档从死码变现役——
  接 4.9d 的 turn 起点状态提醒接缝,注入「你在重复调用 X(第 N 次),若非刻意请换路」,
  给 LLM 自纠机会而非直接熔断。
- **档位可配**:`YO_LOOP_BREAKER=off|loose|strict`(对齐 `YO_CHECKPOINT`/`YO_COMPACT`
  的既有 env 风格),默认 `loose`(=上述放宽后行为);`off` 全放行(用户"先关掉"诉求);
  `strict` 保留现行为供回归。**关键约束:真死循环护栏不拆**——跨 turn 的同参重复(真
  poll 死循环)在 loose 档仍要熔断。
- 验收:同批 3 个同参 spawn 不熔断;跨 turn 连续 10 次同参调用仍熔断;warn 注入提醒
  单测(去重,同状态不重复);三档行为矩阵单测;子内核工厂(`main.ts:237`)同步配档。

### 4.10b 子代理并行派生(tool 循环批内并发)⚠️ 高优先级

- `kernel.ts:579` tool 循环改**两段式**:先对整批做串行的"准入判定"(loop-breaker、
  PreToolUse hook、权限闸门、审批——审批本就逐个弹面板,保持串行语义不变),准入通过的
  调用按类别分组执行:
  - **spawn / 只读类**(readOnlyHint 或 kind 判定)并发执行(`Promise.allSettled`);
  - 有副作用的写类保持串行(顺序语义、shadow-git checkpoint 依赖执行序)。
- **不变量守住**:EventLog 单写者不变——并发执行的事件经 emit 队列仍串行落盘;
  `tool_result` 回填顺序按原批次顺序(与 assistantBlocks 的 tool_use 顺序对齐,§15.1
  合并单条 user 消息的约定不变);`s.interrupted` 中断要能取消在飞的并发调用
  (AbortSignal 已在 `call.signal` 通路上)。
- 与 4.10a 联动:批内并发调用不计 loop(a 已铺好)。
- 验收:一次响应 3 个 spawn 真并发(FakeProvider + 并发计数器/时序断言);混入需审批
  工具的批次行为正确(审批串行、其余并发);中断取消在飞调用;617 基线不退化。

### 4.10c 子代理可观测(TUI 任务面板)— 中优先级

- TUI 增**任务视图**:列出运行中/已结束的子代理(id、profile、model、状态、耗时),
  可进入查看某个子代理的事件流(子树 EventLog 已隔离可读,数据侧零改动,纯 surface 活);
  快捷键进出,背景 spawn 完成时列表侧提示。
- 体量约束:model.ts 已 490 行、app.ts 434 行(候选池 §A 的二次收敛目标还欠着),
  本片新增 UI 拆独立文件,别再往两个大文件里堆。
- 验收:model 层单测(任务列表状态机、进入/退出)+ tui-smoke 兜底;真机复验
  feedback/4.9 场景(并行 spawn 后逐个查看)。

### 机动位(开工后视余量,不承诺)

§3.C 的 **todo 跨轮持久 + 未完成提醒**与**成本查询**:两者的挂点(4.9d turn 起点
状态提醒接缝)已现成,单片体量小,若 a–c 顺利可顺手收编;否则留池。

## 2. 非目标(显式排除)

- **大规模对抗式审查**:移出,以后再说(不设时间点)。原范围=4.5–4.9 TUI 全量 +
  4.9 新增审批上浮越权面/注入面/memory_write 写入面;何时重启由用户拍板。
- 候选池 §A 的 kernel.ts/TUI 拆解(4.10b 会动 tool 循环,拆分等本阶段落定后再评)、
  §D 的 React 19/ink 6 升级与 Biome formatter、§E 的 profileHasTool 收口(Phase 5
  开聊天渠道前的硬前置,不是现在)。

## 3. 候选池剩余(backlog,未立项,开工时重估)

> 来源标注沿用:〔盘点〕= 4.8 前三路全仓盘点;〔审计〕= 4.9 前三路自知审计;
> 〔既定〕= 此前 phase 文档声明的顺延。行数/行号已按 2026-07-02 实测更新。

### A. 代码结构〔盘点〕

- **拆解 `kernel.ts`(实测 1189 行,较盘点时 1076 又涨,全仓最大)**:turn 循环 +
  fallback/rotation + 审批 + steer/interrupt + 压缩 + 子 agent 回收 + hook 分发一锅烩。
  4.10b 还要动 tool 循环,拆分宜在其后。候选切法:审批域、事件发射域、fallback 域各自成文件。
- **TUI 体量二次收敛**:`model.ts` 490、`app.ts` 434(4.7d 目标 ≤300 未达成)。
  与下次 TUI 功能阶段并做;4.10c 先守住"不再涨"。
- **`surface-mcp/mcp-host.ts`(755)/`plugin-host/host.ts`(503)**:次大文件,动时顺评。

### B. 测试补口〔盘点〕

- TUI 渲染/交互层无直接单测的模块(仅 tui-smoke 兜底):`tui/app.ts`、`tui/commands.ts`、
  `tui/execute.ts`、`tui/hooks.ts`、`tui/input/history.ts`(持久化)、`tui/input/paste.ts`、
  `render/approval.ts`(审批面板,安全相关)、`render/blocks.ts`、`render/footer.ts`、
  `render/input-box.ts`、`render/picker.ts`。4.10c 落任务面板单测可顺带撕开口子。
- plugin-host 仅 2 个测试文件(Worker 隔离/崩溃围栏是安全关键)、auth 仅 1 个(ed25519)。
- `apps/main.ts` 主流程:4.8c 只测 parseArgs,buildKernel/引导流零覆盖。
- coverage 阈值设线〔既定〕:首测基线 85.5% 行覆盖,观察后在 vitest.config 设门槛进 CI。

### C. Agent 自知中级项〔审计,4.9 顺延〕

- **checkpoint 对 LLM 暴露**:shadow-git 快照(`kernel.ts:819-840`)只落 EventStore,
  无 AgentEvent、无回滚工具,且 `YO_CHECKPOINT=1` 才开启(默认关)——LLM 与用户都不知道
  能回滚。补:快照后轻量事件 + `checkpoint_rollback` 工具或 prompt 说明。
- **todo 跨轮持久 + 未完成提醒**:`todo_write` 是无状态回显(`builtins.ts:247-270`),
  不进 SessionState,压缩后即丢。补:SessionState 存 todo + 4.9d 接缝注入提醒。→ 见 §1 机动位。
- **成本查询**:costUsd 只进事件/状态栏(`kernel.ts:815`),LLM 答不出"花了多少钱"。
  补:会话累计用量查询工具,或经 4.9d 接缝按 turn 注入。→ 见 §1 机动位。
- **MCP prompts 的 CLI slash 注册**:`promptSlashName` 已备(`surface-mcp/mcp-host.ts:569`),
  给用户侧接 `/mcp__server__prompt`;4.9f 只接了 resources,prompts 留此。

### D. 工程与依赖〔盘点/既定〕

- **React 19 / ink 6 升级**:落后一个 major;4.7b 已把 ink 私有行为依赖收拢进
  `input/decoder.ts`,升级成本已压低,宜专项做 + 真机回归。
- **Biome formatter 评估**:现仅 linter;formatter 全仓 churn 是否接受、是否分包渐进,单独评估。
- **`engines.node >=20` vs node:sqlite 需 ≥22.5**:CI 按 22 跑;要么升 engines 下限,
  要么文档化"20 可跑但 SQLite 持久化自动降级内存"。

### E. 安全收口与遗留限制

- **`tools/registry.ts:94` profile 工具过滤谓词**〔既定〕:`profileHasTool` 默认放行。
  Phase 5 开聊天渠道前必须收口。
- **PHASE-4.md 已知限制表**:插件 hook 数据面脱敏、MCP 反向通道治理(sampling/OAuth 是否
  经 cost/loop-breaker/approval)、loop-breaker 另三模式(unknown_tool / poll_no_progress /
  ping_pong,4.10a 只调 generic_repeat 的敏感度)、exec-local extra env 覆盖——Phase 5/6
  专项,清单见 [`PHASE-4.md`](PHASE-4.md) 末尾。
- **大规模对抗式审查**:见 §2,移出不设时间点。

### F. 4.9 真机反馈处置纪要

- §F.1 三条(loop-breaker 误伤 / 并行派生 / 可观测)→ 已转正为本阶段 4.10a/b/c。
- 已解决:「空 model 报 model is required」「gpt-5 裸猜不可用」根因即 4.9 反馈①,
  4.9a/4.9b 已闭合(模型目录注入 + 空串归一化 + 未知模型早失败)。

## 交接备注(给新窗口)

- 4.9 已收口(2026-07-02,六切片全交付):[`PHASE-4.9.md`](PHASE-4.9.md)。真机反馈原件:
  [`feedback/4.8.md`](feedback/4.8.md)(4.9 起因)、[`feedback/4.9.md`](feedback/4.9.md)
  (本阶段起因)。
- 4.9e 已拍板:**MEMORY.md 单一事实源、砍 MemoryStore 双写**;DB 轨(automemory.ts)留
  Phase 6 向量检索再启用(模块头注释有决策记录)。**已定决策勿重开。**
- 对抗式审查决策链:4.9 收口时按 ADR-14 曾评估"并入 Phase 4 终收口"→ 本次立项**反转为
  移出、以后再说**(用户拍板,不设时间点)。
- 工作约定:每切片独立提交、只补该片测试、全量回归不退化;`pnpm run check` =
  typecheck + lint + gen:schema + test;CI 已含 schema 漂移校验(生成物改了要一起提交)。
