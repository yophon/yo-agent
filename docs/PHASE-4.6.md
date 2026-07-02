# Phase 4.6 —— TUI 重设计(计划)

> 对应 [`DESIGN.md`](DESIGN.md) §7.2(CliSurface)。Phase 4.5 交付了「能用」的多轮 REPL,但真机日常使用体验不达标。
> 本阶段对 TUI 做**完整重设计**:渲染语言、输入编辑器、运行态交互、审批体验、命令系统、会话管理六个维度全部升级,
> 并把 surface-cli 从单文件 500 行重构为可测的分层架构。参考对象:Claude Code / Codex / pi / Gemini CLI(调研见 [`research/`](research/))。
>
> **基线**:Phase 4.5 收口 460 测试全绿(`app.ts` 499 行 + `tui-format.ts` 106 行)。本阶段增量交付,全量回归不退化。

---

## 0. 4.5 问题诊断(真机使用 + 代码审读)

| # | 维度 | 问题 | 现状代码根源 |
|---|---|---|---|
| P1 | 输入 | **单行输入**:无多行编辑;粘贴含换行的文本被 ink 逐段解析、换行触发提交,长 prompt 无法粘贴 | `useInput` 里 `key.return` 直接 `onEnter()`,无 bracketed paste 识别 |
| P2 | 输入 | **CJK 光标错位**:按 code unit 切串 + inverse 单字符,中文/emoji 下光标渲染宽度错、代理对被劈开 | `input.slice(0, cursor)` / `after.slice(0, 1)` |
| P3 | 输入 | 输入历史**不持久**(仅进程内);无 Ctrl+W/K、词级移动、Home/End | `historyRef` 内存数组 |
| P4 | 渲染 | 助手输出**纯文本**:无 markdown(标题/加粗/代码块/列表全是原始符号),代码无高亮 | `renderBlock` 直接 `Text` |
| P5 | 渲染 | **无 diff 渲染**:edit/write 类工具的变更只能看 JSON 入参和原始输出,审批时更是只有 100 字符 JSON 摘要——看不到改了什么就要批 | `summarizeInput` = `JSON.stringify` 截断 |
| P6 | 渲染 | 工具输出一律「末 8 行暗色缩进」,不分工具类型;无展开/折叠;`Todo`/`Plan`/`BackgroundProcess`/`TurnStarted` 事件根本不渲染 | 单一 `previewOutput`;switch 缺分支 |
| P7 | 噪音 | 每轮打一条「完成 · end_turn」notice;子 agent/MCP/文件变更全是同质 dim 行,轮与轮之间无视觉分隔 | `commitNotice('success', …)` 无条件 |
| P8 | 运行态 | spinner 行只有「运行中…」:无耗时、无当前动作(在读哪个文件/跑什么命令)、无本轮 token | `SPINNER_FRAMES[spin]` + 固定文案 |
| P9 | 运行态 | 运行中 Enter 只能**立即 steer**,无「排队到轮后」投递;steer 无撤回 | `kernel.steer` 直发 |
| P10 | 命令 | slash 无补全菜单:输错只有事后 warn;仅 6 个命令;无 @文件引用 | `parseSlash` 精确匹配 |
| P11 | 会话 | 无 `/resume`(内核 `resumeSession` 接缝闲置)、无 `/new`、无 `/compact`;`/model` 只读不能切;权限模式启动后不可变 | 内核缺 4 个小接缝 + UI 未接 |
| P12 | 状态 | 状态栏无 **context 用量**(离自动压缩还有多远不可知)、无 git 分支;Fake 演示态无醒目提示 | 内核未暴露 context 估算 |
| P13 | 安全感 | 空闲 Ctrl+C **一击即退**,长会话易误杀;审批面板 Esc=拒绝 与 全局 Esc=中断 语义打架 | `exit()` 无二次确认 |
| P14 | 架构 | 事件处理/按键路由/渲染全部内联在 `app.ts` 一个组件里:事件折叠逻辑不可离线单测,加任何功能都在 useInput 的 if 链上叠 | 单文件 500 行 |

---

## 1. 设计原则(从竞品提炼)

1. **安静的默认,一键的深入**(Claude Code):正常轮次只展示「动作头 + 结果摘要」,细节折叠;`Ctrl+O` 切详细。完成不庆祝、失败才发声。
2. **事件流是唯一输入**(Codex):UI 是 `AgentEvent` 的纯消费者。事件 → 区块的折叠逻辑做成**纯 reducer**,ink 只做薄渲染壳——这也是可测性的根。
3. **计量常显、可解释**(pi footer):token ↑↓/cache/成本/context 剩余实时可见;用户永远知道「这轮花了多少、离压缩还有多远」。
4. **双通道投递**(pi):运行中 Enter=立即引导(steer),Alt+Enter=排队轮后(follow-up)。两种意图都一键直达。
5. **模式切换在指尖**(Claude Code / Gemini):Shift+Tab 循环权限模式,不打断心流。
6. **不重写、只重构**(opencode 反例:Go TUI 推倒重来至今不稳):保留 ink + `<Static>` 架构(长会话不重绘的关键),按层抽离,每片行为等价可回归。

---

## 2. 布局总览

```
│ ⏺ 读取 packages/kernel/src/kernel.ts        ← scrollback(<Static>,只渲一次)
│   ⎿ 963 行
│ ⏺ 好的,turn 循环在 runTurn() 里……            ← 助手文本(markdown 渲染)
│                                              ← 轮间空行分隔
│ ❯ 把熔断阈值改成可配置                        ← 用户输入(青)
│ ⏺ Edit(packages/kernel/src/loop-breaker.ts)  ← live 区(当前轮流式)
│   ⎿ +4 -1(Ctrl+O 展开 diff)
├──────────────────────────────────────────────
│ ⠹ 修改 loop-breaker.ts… 12s · ↓1.4k(Esc 中断 · Alt+Enter 排队)
│ ╭────────────────────────────────────────────╮
│ │ ❯ █                                        │  ← 多行输入框(随内容长高)
│ ╰────────────────────────────────────────────╯
│ opus-4.8 · supervised ⇧⇥ │ ctx 62% · ↑48k ↓3.2k · $0.41 · main · ~/yo-agent
```

四段式:**scrollback**(已完成区块)→ **live 区**(当前轮)→ **活动行 + 输入框**(或审批面板 / 选择器,三者互斥)→ **状态栏**。

---

## 3. 渲染语言(P4-P7)

### 3.1 区块视觉体系

统一「动作头 + 结果尾」两行式(对齐 Claude Code 的 `⏺`/`⎿`):

- `❯ ` 用户消息(青);`⏺ ` 助手文本段 / 工具动作;`  ⎿ ` 结果摘要(dim);`💭` 推理(dim,可 `/reasoning` 关);`↳` 子 agent(整组缩进 2 格,子层工具再缩进)。
- 轮与轮之间强制一个空行;`TurnCompleted(end_turn)` **不再打 notice**,改为在结果尾追加一条 dim 的轮摘要:`· 8.2s · ↓2.1k · $0.03`;`interrupted`/`TurnFailed` 才输出黄/红 notice(P7)。

### 3.2 工具专属视图(注册表)

`render/tool-views.ts` 按工具名注册「头部摘要 + 折叠尾 + 展开体」三段渲染器,未注册的走通用视图(现状行为):

| 工具 | 头 | 折叠尾(默认) | 展开体(Ctrl+O / verbose) |
|---|---|---|---|
| read | `⏺ Read(src/kernel.ts)` | `⎿ 963 行` | 无(读全文无意义) |
| edit / apply_patch | `⏺ Edit(loop-breaker.ts)` | `⎿ +4 -1` | **彩色 unified diff**(见 3.4) |
| write | `⏺ Write(new-file.ts)` | `⎿ 新文件 · 82 行` | 内容前 20 行 |
| bash | `⏺ Bash(pnpm test …)` | 输出末 5 行;exit≠0 红色标 | 输出末 30 行 + 截断落盘路径 |
| grep / glob / ls | `⏺ Grep("LoopBreaker")` | `⎿ 12 处命中` + 前 3 条 | 全部命中 |
| todo | 独立 checklist 区块:`☐/◐/☑ 事项`(消费 `Todo` 事件,增量更新同一区块) | | |
| subagent_spawn | `↳ 子 agent:label(model)` + 子层事件缩进折叠 | `⎿ 摘要` | |
| mcp 工具 | `⏺ server:tool(…)` | 通用尾 | pretty JSON |

`Plan` 事件渲染为缩进列表区块;`BackgroundProcess` 渲染为 dim 单行(P6)。

### 3.3 Markdown 渲染

自研轻量渲染器 `render/markdown.ts`(纯函数:md 文本 → 带样式的行数组,零新依赖):支持 **标题**(加粗+下划线)、**加粗/斜体/行内代码**、**代码块**(dim 边框 + 语言标签 + 2 格缩进;语法高亮不做,后置)、**列表/引用/分隔线**、**简单表格**(等宽对齐)。流式期间对「未闭合代码块」按已开启样式渲染,闭合时不回改(`<Static>` 不可回写,live 区块在 commit 前才终渲一次——见 §8 架构)。

### 3.4 Diff 渲染

`render/diff.ts` 纯函数:`(patch 文本 | {old,new})` → 着色行(`+` 绿 / `-` 红 / `@@` 青 / 上下文 dim,带行号,连续未变更 >3 行折叠为 `···`)。edit/write 的工具展开体与**审批面板**(§6)共用。

### 3.5 宽度自适应

渲染统一经 `useStdout().columns` 传宽(监听 resize);行截断/表格/diff 都按实际列宽;宽字符用 ink 自带的 `string-width` 度量,不再硬编码 120 列(P6)。

---

## 4. 输入编辑器(P1-P3)

### 4.1 多行 buffer

`input/editor.ts`:纯函数式文本 buffer(`{text, cursor}` + 操作集),**按字素簇**(`Intl.Segmenter`)移动/删除,渲染光标按显示宽度定位(CJK 占 2 列)——P2 根治。输入框为圆角边框 Box,随内容自动长高(上限 10 行,超出内部滚动)。

换行三路(都插入 `\n` 不提交):**Alt+Enter**(空闲态)、**Ctrl+J**、行尾 `\` + Enter(CC 惯例)。

### 4.2 Bracketed paste

进 TUI 时开启 `\x1b[?2004h`(退出恢复):粘贴内容整段落入 buffer,换行不触发提交(P1)。粘贴 >10 行折叠显示为 `[粘贴 #1 · 42 行]` 占位符(提交时展开原文),避免输入框爆屏(CC 做法)。

### 4.3 编辑快捷键(readline 惯例)

`←→`/`Ctrl+B/F` 字素移动 · `Alt+←→`/`Alt+B/F` 词移动 · `Ctrl+A/E`、`Home/End` 行首尾 · `Ctrl+W` 删前词 · `Ctrl+K/U` 删到行尾/清空 · `↑↓` 多行内按行移动,首/末行再按才进历史。

### 4.4 持久历史

`input/history.ts`:追加写 `~/.config/yo-agent/history.jsonl`(带 cwd + 时间戳;上限 1000 条滚动;权限 600)。启动加载,`↑↓` 跨进程召回;同 cwd 的条目优先。`Ctrl+R` 反向增量搜索(后置,非本阶段承诺)。

### 4.5 退出保护(P13)

空闲 Ctrl+C / Ctrl+D:第一次显示「再按一次退出」(3 秒窗口),第二次退出。运行中 Ctrl+C 与 Esc 同义 = 中断当前轮。Esc 空闲单击清空输入(保持 4.5)。

---

## 5. 运行态交互(P8-P9)

### 5.1 活动行(spinner 升级)

`⠹ <动作词>… <耗时>s · ↓<本轮出 tok>(Esc 中断 · Alt+Enter 排队)`

动作词由最近事件驱动:`思考中`(Reasoning/无事件)→ `读取 kernel.ts`(ToolCallStarted read)→ `执行 pnpm test`(bash)→ `等待审批`。耗时自 `TurnStarted` 起秒级刷新;`↓` 来自 `UsageUpdate`。

### 5.2 双通道投递(pi 范式)

- **Enter(运行中)= steer**:立即注入当前轮(现状语义不变),transcript 记 `↳ 引导:…`。
- **Alt+Enter(运行中)= 排队 follow-up**:UI 级队列,轮完成后自动作为下一轮提交。输入框上方显示 `⏸ 已排队 1 条(↑ 取回编辑)`;`↑` 取回、Esc 中断时队列保留并询问。纯 UI 实现,内核零改动。

### 5.3 详细模式

`Ctrl+O` 切换 verbose:影响**此后**渲染的工具区块(折叠尾 ↔ 展开体)。已入 `<Static>` 的区块不可回改——这是 ink 架构的已知取舍,如实标注;全量回看后置为 alt-screen transcript 视图(非本阶段)。

---

## 6. 审批体验(P5)

面板重设计(仍与输入框互斥,风险色边框保留):

```
╭─ ⚠ Bash · 风险 high ─────────────────────────╮
│ rm -rf dist && pnpm build                     │ ← 命令全文(不截断,多行滚动)
│ cwd: ~/yo-agent · 理由: 含 rm -rf             │ ← 风险要点(assessRisk 输出)
│ ❯ 1. 允许一次        2. 总是允许(本会话)      │
│   3. 拒绝一次        4. 拒绝并告诉它该怎么做… │
╰──────────────────────────────────────────────╯
```

- **按工具渲染入参**:bash → 命令全文 + cwd;edit/write → **彩色 diff**(复用 3.4,审批时终于「看得见改动再批」);MCP → server 名 + pretty JSON。
- **数字键 1-4 直选** + ↑↓/Enter;`y`=允许一次、`n`=拒绝一次。
- **选项 4「拒绝并引导」**:选中后就地展开一行输入,提交 = `decideApproval(reject_once)` + `kernel.steer(文本)` 组合,内核零改动(对齐 CC 的 "tell Claude what to do differently")。
- 审批态 Esc = 取消选择(不再直接拒绝),连按两次才拒绝——消除与全局 Esc 中断的语义冲突(P13)。

---

## 7. 状态栏 + 命令系统 + 会话(P10-P12)

### 7.1 状态栏(两端对齐单行)

左:`<model> · <mode> ⇧⇥`(演示态显著黄字 `FAKE 演示`)
右:`ctx <剩余%> · ↑<累计入> ↓<累计出>(cache <命中>) · $<成本> · <git 分支> · <cwd>`

- `ctx %` 来自新内核接缝 `contextState`(§9),<20% 时黄色、<10% 红色——「离自动压缩多远」可见(pi footer 精神)。
- git 分支:UI 直接读 `.git/HEAD`(纯展示,无接缝)。

### 7.2 Slash 命令系统

`commands.ts` 注册表(`{name, alias, desc, args?, run}`),输入 `/` 即出**补全菜单**(输入框上方浮层,前缀+模糊过滤,↑↓/Tab 选、Enter 执行),未知命令不再只能事后 warn(P10)。

| 命令 | 行为 | 依赖接缝 |
|---|---|---|
| `/help` `/clear` `/cwd` `/exit` | 现状保留(`/clear` 加确认:仅清屏不清上下文的说明) | — |
| `/new` | 结束当前会话、开新会话(确认) | 无(组合现有) |
| `/model` | **交互选择器**列 `listModels()`,选中即切,下一轮生效 | `setModel` |
| `/mode` | 选择器切权限模式;`bypass` 需二次确认 | `setPermissionMode` |
| `/compact` | 手动触发压缩,完成显示省下 tokens | `compactNow` |
| `/resume` | **会话选择器**:短 id · 时间 · 模型 · 首问摘要,选中恢复 | `listPersistedSessions` |
| `/cost` | 本会话用量明细(按轮:in/out/cache/$) | 无(UI 累积) |
| `/mcp` | MCP server 连接状态表 | 无(UI 累积 `McpServerStatus`) |
| `/reasoning` | 推理流显示开关 | 无 |

**Shift+Tab** 循环 `read-only → supervised → accept-edits → autonomous`(`ci`/`bypass` 不进循环,仅 `/mode` 显式可达)——CC/Gemini 共识键位。

**@ 文件补全**:输入 `@` 触发文件模糊选择器(git ls-files 优先、退回 fs 遍历,忽略 node_modules/.git;上限 5000 条),选中插入相对路径。仅补全文本,不做上下文注入(内核零改动;注入语义留给模型工具自取)。

### 7.3 CLI 入口

`yoagent --continue`(恢复最近会话)/ `yoagent --resume [id]`(不带 id 进选择器)。

---

## 8. 代码架构重构(P14)

```
packages/surface-cli/src/
├─ headless.ts / jsonl.ts / compose.ts        # 不动
└─ tui/
   ├─ app.ts          # ink 组装壳(目标 <200 行:接 reducer、路由按键、摆区块)
   ├─ model.ts        # ★ UiState + Block + reducer(AgentEvent→状态迁移,纯函数)
   ├─ keymap.ts       # ★ 按键路由器:审批 > 选择器 > 补全 > 编辑器 > 全局,层级吞键
   ├─ input/editor.ts # ★ 多行 buffer(字素/词操作/显示宽度)
   ├─ input/history.ts    # 持久历史
   ├─ input/completion.ts # ★ slash + @文件补全引擎
   ├─ commands.ts     # slash 注册表
   └─ render/         # markdown.ts★ diff.ts★ tool-views.ts★ blocks.ts
                      # statusbar.ts spinner.ts approval.ts picker.ts(通用选择器)
```

★ = 纯函数模块,离线单测主战场。核心转变:**事件折叠逻辑从 useEffect 搬进 reducer**(`(state, AgentEvent) → state`),ink 组件只订阅 state 渲染;`<Static>` 提交策略不变(区块完成才 commit,live 区终渲一次落静态区)。live 区渲染 50ms 合帧(AssistantText delta 高频防闪)。

---

## 9. 内核小接缝(全部 kernel 方法级,协议冻结不动)

| 接缝 | 签名 | 说明 | 预估 |
|---|---|---|---|
| K1 | `setModel(sessionId, model)` | 改 `SessionState.model`,下一轮生效;校验目录内存在 | ~15 行 |
| K2 | `setPermissionMode(sessionId, mode)` | 改 `SessionState.permissionMode`;交互态本人操作允许任意切换(与 4C 子 agent 只收紧不冲突——那是派生策略) | ~15 行 |
| K3 | `compactNow(sessionId)` | 复用既有 Condenser 路径立即压缩,发 `ContextCompacted` | ~30 行 |
| K4 | `contextState(sessionId): {estTokens, windowTokens}` | 复用 `tokens.ts` 估算 + `usableContextTokens` | ~20 行 |
| K5 | `store.listPersistedSessions(): {sessionId, model, createdAt, lastActive, firstPrompt}[]` | SQLite/Memory EventLog 扫 `SessionStarted` + 首条输入 | ~40 行 |

每个接缝配单测;RPC/ACP 暴露不在本阶段(留 Phase 5+ 按需)。

---

## 10. 交付切片与验证

| 片 | 内容 | 退出验证 |
|---|---|---|
| **4.6a 架构重构** | reducer + keymap + 目录拆分,**行为等价** | 既有 20 项 TUI 测试不改断言全绿;reducer 新增单测覆盖全部 21 事件 |
| **4.6b 输入编辑器** | 多行/bracketed paste/CJK 字素/持久历史/readline 键/退出保护 | editor 纯函数单测(含 emoji/CJK 边界);粘贴 42 行文本不误提交 |
| **4.6c 渲染语言** | markdown/diff/工具视图注册表/Todo/Plan/子 agent 分组/去噪/活动行 | markdown·diff 快照单测;冒烟:edit 工具显示 `+n -m` 尾 |
| **4.6d 命令与补全** | slash 注册表+菜单、@文件、/cost /mcp /new、选择器组件 | 补全引擎单测;冒烟:`/mo`+Tab → `/model` |
| **4.6e 接缝与会话** | K1-K5 + /model 切换 + Shift+Tab + /compact + /resume + --continue + Alt+Enter 排队 | 接缝单测;冒烟:跨进程 /resume 续聊 |
| **收口** | 真机 PTY 冒烟矩阵(粘贴/多行/diff 审批/切模式/resume)+ 按 ADR-14 节奏整体对抗式审查 | `pnpm run check` 全绿不退化 |

**阶段退出标准**:① 多行粘贴与 CJK 编辑无误提交/无光标错位;② edit 类审批面板呈现彩色 diff;③ 跨进程 `/resume` 恢复会话继续对话;④ 状态栏 context% 实时可见;⑤ 全量回归 460+ 不退化。

## 11. 非目标(明确不做)

鼠标支持 · 图片/多模态输入 · alt-screen 全量 transcript 回看与 pi 式 `/tree` DAG 视图(Phase 6 候选)· vim 输入模式 · 主题配置系统(仅集中色板常量)· 语法高亮 · `Ctrl+R` 历史搜索(4.6 内 stretch,不承诺)。
