# Phase 4.7 —— TUI 架构收敛(已完成)

> **收口状态**:a–f 六切片全部交付(2026-07-02,commit fdac006…88a669b),126 测试全绿。
> app.ts 853 → 430 行;大规模对抗式审查按决策跳过,后续大阶段收口时统一补。

> 对应 [`DESIGN.md`](DESIGN.md) §7.2(CliSurface)。Phase 4.6 交付了完整的 TUI 重设计(渲染语言/输入编辑器/
> 命令系统/内核接缝),但 `app.ts` 在增量交付中重新长成 853 行的「上帝组件」,输入解码散在 useInput 内联特判里,
> 渲染层无 memo 化。本阶段**不加新视觉、不换架构**:收敛状态管理、固化脆弱区、补齐 4.6 遗留的功能缺口。
>
> **基线**:4.6 收口 112 测试全绿(surface-cli 11 个测试文件);`app.ts` 853 行。
> 总原则沿用 4.6 的「不重写、只重构」:纯 reducer + `<Static>` + StyledLine 三块基石不动摇,
> 每片行为等价可回归。

---

## 0. 现状诊断(4.6 收口后代码审读)

| # | 维度 | 问题 | 现状代码根源 |
|---|---|---|---|
| Q1 | 架构 | **app.ts 上帝组件**:15+ 份状态,每份手写「useState + ref 镜像」样板重复约 10 次,忘双写即 stale-closure bug | `setEditor`/`setMenuSelBoth`/`setPicker`/`setQueue`/`setPendingGuide`/`exitArmed`/`rejectArmed`… |
| Q2 | 架构 | **双状态体系割裂**:approval/activity 在 reducer,picker/pendingGuide/queue/menuSel 是组件本地态;`guide-cancel` 直接手改 `stateRef.current` 绕过 reducer | `app.ts` execute() `guide-cancel` 分支 |
| Q3 | 架构 | `execute()` 巨型 switch ~200 行,编辑/审批/选择器/菜单/队列/历史全混;footer(审批面板/输入框/提示行)内联在 app.ts,与 picker 归宿不一致 | `app.ts` execute() / footer 段 |
| Q4 | 性能 | spinner 80ms tick 重渲整个 live 区,assistant 区块**全文重跑 renderMarkdown**;流式长输出每秒 12 次 O(n) 正则解析 | `renderBlock` 无 memo;`setSpin` 在顶层组件 |
| Q5 | 性能 | `computeMenu` 一次按键最多算 4 次(useInput ctx 两次 + render + execute),每次对 5000 文件 fuzzyFilter | `app.ts` useInput/execute/render 各自调用 |
| Q6 | 脆弱区 | 输入解码依赖 ink 5 `parse-keypress` 私有行为(剥首 ESC、`[200~` 残缺形态、Alt+Enter=`\r` 无 return 标志),paste 拦截/pty 切段/键位归一三段特判内联在 useInput,ink 升版即崩风险集中 | `app.ts` useInput ⓪①' 段 + `input/paste.ts` |
| Q7 | 功能 | **/resume 不回放历史**:内核 `subscribe` 忽略 `fromCursor`(签名 `_fromCursor`),TUI 切会话后空屏到下一轮 | `kernel.ts` subscribe;TUI 未走 `events.read()` 重放 |
| Q8 | 功能 | 并发 `ApprovalRequested` 互相覆盖(reducer 直接替换 `state.approval`);审批面板打开时 Ctrl+C 被吞,既不能退出也不能中断 | `model.ts` reduceEvent;`keymap.ts` ① 层 |
| Q9 | 卫生 | `tui-format.ts` 遗留 4.5 死代码(`SLASH_COMMANDS`/`parseSlash`/`SLASH_HELP`/`previewOutput`/`toolIcon`),`SlashCommand` 类型撞名迫使 index.ts 导出 `SlashCommandDef` 别名 | grep 确认 src 内零引用 |

**保留资产**(重构不许动摇):纯 reducer + `<Static>` scrollback;StyledLine 中间表示;keymap 层级吞键模型
(审批 > 引导 > 选择器 > 补全菜单 > 编辑器);TuiKernel 可选接缝 + 缺省降级。

---

## 1. 切片规划

每切片独立提交、只补该片测试、全量回归不退化。顺序 a→f:先清地基,再固化最脆弱的输入层,状态与拆解是主体,
性能与功能收尾。

### 4.7a 清扫与地基(Q9)

- 删 `tui-format.ts` 死代码五件套;`SlashCommand` 类型让位注册表版,去掉 index.ts 的 `SlashCommandDef` 别名绕行。
- 新增 `tui/hooks.ts`:`useSyncedRef<T>`(useState + ref 双写合一,同帧同步可见),本片只落工具不迁调用方。
- 验收:编译 + 全量测试绿;`apps/yo-agent` 无破坏。

### 4.7b 输入解码层固化(Q6)

- 新建 `input/decoder.ts` 纯状态机:raw chunk → 语义输入事件序列(`paste` / `insert` / `enter` / 透传键)。
  收编三段特判:括号粘贴拦截(吸收 `PasteTracker`)、pty 合并 chunk 切段、ink 键位怪癖归一。
- 对 ink 私有行为的依赖收拢到这一个文件,头注释记录实测事实;useInput 瘦身为「喂 decoder → routeKey → execute」。
- 验收:decoder 离线穷举测试(粘贴跨 chunk / 结束标记开头 / pty 合并 / Alt+Enter 各形态);
  现有 tui-input / smoke 测试不改断言全绿。

### 4.7c 状态统一进 reducer(Q1 Q2)

- `picker`、`pendingGuide`、`queue`、`menuSel`(含抑制 token)迁入 UiState,补对应 UiAction。
- 修 `guide-cancel` 越权:改为 `approval-restore` action 走 reducer。
- 必须留组件层的(editor、spinner、armed 计时器)统一换 `useSyncedRef`;
  退出/拒绝两套「双击确认 armed+timer」合并为 `useArmedConfirm`。
- 验收:tui-model 测试扩充覆盖新 action;smoke 全绿行为等价。

### 4.7d 拆解 app.ts(Q3,依赖 c)

- `execute()` 按域拆:`executeEditor` / `executeApproval` / `executePicker` / `executeMenu`,app.ts 只剩分发。
- footer 各段迁 `render/`:审批面板 → `render/approval.ts`(与 approvalBody 合并)、
  输入框 → `render/input-box.ts`、提示行/活动行 → `render/footer.ts`。
- 目标:app.ts ≤ 300 行,只做订阅、副作用、布局摆放。
- 验收:纯迁移不改行为,smoke 全绿;新渲染文件补 StyledLine 级单测。

### 4.7e 渲染性能(Q4 Q5)

- `renderBlock` 包 `React.memo`(区块不可变,天然命中);spinner/活动行抽独立组件,80ms tick 隔离在 footer 内。
- `computeMenu` 每次按键只算一次(useInput 算好传 routeKey ctx 与 execute);文件补全结果按 token 缓存。
- 验收:现有测试绿 + 真机长输出流式验证无卡顿。

### 4.7f 功能补口(Q7 Q8,涉内核小接缝)

- **/resume 历史回放**:内核 `subscribe` 实现 `fromCursor`(或 TUI 侧复用 headless 的 `events.read()`
  先重放再订阅),重放事件折叠进 committed,恢复会话不再空屏。
- **审批队列化**:reducer 把并发 `ApprovalRequested` 排队逐个呈现,不再覆盖。
- **审批面板放行 Ctrl+C**:approvalOpen 层不吞退出/中断键。
- 验收:各补一条 smoke/model 测试;内核接缝改动补 kernel 侧单测。

---

## 2. 非目标

- 不做新视觉(语法高亮、subagent 嵌套缩进等留后续阶段)。
- 不换渲染架构(`<Static>` 固有取舍——verbose 不回改已渲区块、`/clear` 不回收——继续接受)。
- 不做键位自定义、命令扩展机制。

## 3. 里程碑

| 切片 | 预估 | 交付判据 |
|---|---|---|
| a 清扫与地基 | 0.5d | 死代码清零,useSyncedRef 落地 |
| b 输入解码层 | 1d | decoder.ts + 穷举测试,useInput 内联特判清零 |
| c 状态统一 | 1d | app.ts 本地态只剩 editor/spinner/armed,reducer 纯度恢复 |
| d 拆解 app.ts | 1–1.5d | app.ts ≤ 300 行 |
| e 渲染性能 | 0.5d | live 区不随 spinner tick 重渲 |
| f 功能补口 | 1–1.5d | /resume 回放、审批队列、Ctrl+C 可达 |
