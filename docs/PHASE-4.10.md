# Phase 4.10 —— 候选池(未立项,开工时再裁剪)

> 本文档不是承诺计划,而是 **backlog**:收拢 4.8 全仓盘点与 4.9 审计中发现、但被显式排除出
> 4.8/4.9 范围的事项,防止只活在对话里丢失。开 4.10(或并入 Phase 5)时从此池挑选、
> 重估优先级后再写正式切片。来源标注:〔盘点〕= 4.8 前的三路全仓盘点;〔审计〕= 4.9 前的
> 三路自知审计;〔既定〕= 此前 phase 文档已声明的顺延。

## A. 代码结构(盘点遗留)

- **拆解 `kernel.ts`(1076 行,全仓最大)**〔盘点〕:turn 循环 + fallback/rotation + 审批 +
  steer/interrupt + 压缩触发 + 子 agent 回收 + hook 分发全在一个文件。4.9c/4.9d 还会往里加
  接缝,拆分宜在其后。候选切法:审批域(`pendingApprovals`/`requestApproval`)、事件发射域、
  fallback 域各自成文件。
- **TUI 体量二次收敛**〔盘点〕:`model.ts` 490 行(现 TUI 最大)、`app.ts` 430 行
  (4.7d 目标 ≤300 未达成,commit 口径"853→394"与实测 430 不符)。非紧急,与下次 TUI 功能阶段并做。
- **`mcp-host.ts`(738)/`plugin-host/host.ts`(502)**〔盘点〕:次大文件,4.9f 动 mcp-host 时顺评。

## B. 测试补口(盘点遗留)

- **TUI 渲染/交互层无直接单测的模块清单**〔盘点〕(仅 tui-smoke 兜底):
  `tui/app.ts`、`tui/commands.ts`、`tui/execute.ts`、`tui/hooks.ts`、`tui/input/history.ts`
  (持久化)、`tui/input/paste.ts`、`render/approval.ts`(审批面板,安全相关)、`render/blocks.ts`、
  `render/footer.ts`、`render/input-box.ts`、`render/picker.ts`。
- **plugin-host 仅 2 个测试文件**(Worker 隔离/崩溃围栏是安全关键)、**auth 仅 1 个**
  (ed25519 设备身份)〔盘点〕。
- **apps/main.ts 主流程**:4.8c 只测了 parseArgs;buildKernel/引导流仍零覆盖〔盘点〕。
- **coverage 阈值设线**〔既定,4.8 非目标〕:首测基线 85.5% 行覆盖,观察一两个阶段后在
  vitest.config 设门槛进 CI。

## C. Agent 自知(4.9 顺延的中级项)〔审计〕

- **checkpoint 对 LLM 暴露**:shadow-git 快照现完全隐形(`kernel.ts:778-790` 静默保存,无事件
  无回滚工具),LLM 不知道能回滚。补:快照后轻量事件 + `checkpoint_rollback` 工具或 prompt 说明。
- **todo 跨轮持久 + 未完成提醒**:`todo_write` 是无状态回显(`builtins.ts:247-270`),不进
  SessionState,压缩后即丢,无"还有未完成项"提醒。补:SessionState 存 todo + turn 起点接缝
  (4.9d 落地后即有现成挂点)注入提醒。
- **成本查询**:costUsd 只进事件/状态栏,LLM 答不出"花了多少钱"。补:会话累计用量查询工具,
  或经 4.9d 接缝按 turn 注入。
- **MCP prompts 的 CLI slash 注册**:`promptSlashName` 已备(`mcp-host.ts`),给用户侧接
  `/mcp__server__prompt`;4.9f 只接 resources,prompts 留此。

## D. 工程与依赖(盘点遗留)

- **React 19 / ink 6 升级**:落后一个 major;4.7b 已把 ink 私有行为依赖收拢进
  `input/decoder.ts`(头注释记录实测事实),升级成本已压低,宜专项做 + 真机回归。
- **Biome formatter 评估**〔既定,4.8 非目标〕:现仅 linter;formatter 全仓 churn 是否接受、
  是否分包渐进,单独评估。
- **`engines.node >=20` vs node:sqlite 需 ≥22.5**:CI 已按 22 跑;要么升 engines 下限,
  要么明确文档化"20 可跑但 SQLite 持久化不可用(自动降级内存)"。

## E. 安全收口(Phase 5 前置,不可跳过)

- **`registry.ts:94` profile 工具过滤谓词**〔既定〕:`profileHasTool` 当前**默认放行**。
  开放聊天渠道(Phase 5)前必须收口——不同渠道/画像的工具面收窄要真正生效。
- **大阶段统一对抗式审查**〔既定,ADR-14 节奏〕:4.5–4.9 的 TUI 全量代码 + 4.9 新增的审批上浮/
  注入面**都未过对抗式审查**(4.7 头部明示"后续大阶段收口时统一补")。4.9 收口或 Phase 4 终收口时
  统一做,重点:审批上浮的越权面、注入内容的 prompt-injection 面、memory_write 的写入面。
- **PHASE-4.md 已知限制表**:插件 hook 数据面机密性脱敏、MCP 反向通道治理(sampling/OAuth 是否
  经 cost/loop-breaker/approval)、loop-breaker 补另三模式、exec-local extra env 覆盖——
  Phase 5/6 专项,清单见 [`PHASE-4.md`](PHASE-4.md) 末尾。

## 交接备注(给新窗口)

- 4.9 计划已立项待开工:[`PHASE-4.9.md`](PHASE-4.9.md),六切片 a→f,含全部根因 file:line。
  真机反馈原件:[`feedback/4.8.md`](feedback/4.8.md)。
- 4.9e 有一处待拍板:记忆双轨收口选"MEMORY.md 单一事实源、砍 DB 写"(文档倾向)还是
  "DB 读回双轨"——开工时确认。
- 工作约定:每切片独立提交、只补该片测试、全量回归不退化;`pnpm run check` =
  typecheck + lint + gen:schema + test;CI 已含 schema 漂移校验(生成物改了要一起提交)。
