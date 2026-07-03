# Phase 4.9 —— Agent 自知与失败可交互(计划)

> 起因:真机反馈 [`feedback/4.8.md`](feedback/4.8.md)——LLM 裸猜模型名连环 404、子代理无权限静默失败。
> 三路并行审计(MCP / 记忆+skills / 权限+环境)确认这不是两个个案,而是三个**系统性病根**:
>
> 1. **自知信息只给人不给 LLM**:引擎把运行时状态齐全地做成了事件流 + 状态栏(给 surface/人看),
>    却几乎不回注 LLM 消息窗口。system prompt 只有约定文件 + 技能摘要(`kernel.ts:165`),
>    cwd/OS/日期/git/当前模型/可用模型/权限模式/MCP server 清单/记忆机制/可用画像——全部缺席。
> 2. **失败静默化**:子代理审批写死非交互默认拒(`subagent.ts:309`);MCP 熔断后工具无声消失
>    (`kernel.ts:845` emit-only);插件 turn 间崩溃工具静默蒸发;审批超时谎称「用户拒绝了」
>    (`kernel.ts:817→617`);profile 猜错静默降级成无画像子 agent(`subagent.ts:196`);
>    skill/recipe 加载失败连 stderr 都不进(`skills.ts:84`/`recipes.ts:60`);空串 model 穿透 `??`
>    兜底直达 provider 400(`subagent.ts:203`)。
> 3. **建好未接线**:MCP resources/prompts 全套实现仅测试调用(`mcp-host.ts:396-410`);
>    MemoryStore 双写单读是死数据(`listMemory` 零调用);LLM 无任何写记忆手段——
>    **与 DESIGN §5.3「动态记忆 agent 可读写」直接冲突**。
>
> 本阶段对齐的正面范例(抄它):`skill_activate` 猜错时回「未找到技能 x(可用:a, b, c)」
> (`skill-tool.ts:43`)——可行动错误 + 常驻摘要 + 工具描述三件套,是全仓自知做得最好的通道。
>
> **基线**:4.8 收口 572 测试全绿(68 文件);CI + lint 门已生效。

---

## 0. 审计发现矩阵(按维度 × 病根)

| 维度 | 不自知(病根 1) | 静默失败(病根 2) | 未接线(病根 3) |
|---|---|---|---|
| 模型 | 目录/当前模型不进 prompt;`listModels` 仅 RPC/TUI 可见 | 空串 model 透传 400;未知模型名透传 404 | — |
| 子代理 | profile 零枚举(与裸猜模型同构) | 审批默认拒;profile 猜错静默降级 | — |
| MCP | 无 server 清单工具;信任门跳过无提示;工具描述无来源标注 | 熔断后工具无声消失;失败文案无行动指引 | resources/prompts 死代码 |
| 记忆 | LLM 不知道有记忆系统、不知隔离边界 | 写失败裸栈崩进程;MEMORY.md 无脑 append 重复 | 无写记忆工具;MemoryStore 单读死数据 |
| skills | (已达标) | 加载失败三不见(无 stderr 无提示) | — |
| 权限/审批 | 当前 permissionMode 不进 prompt | 超时=真拒不可分;拒绝文案无引导 | — |
| 环境 | cwd/OS/日期/git 全缺(对照 CC `<env>` 块) | — | — |
| 插件 | — | turn 间崩溃工具静默消失 | — |
| 上下文/成本 | 满度不告知;成本 LLM 答不出 | — | — |

## 1. 切片规划

顺序 a→f:先落静态注入底座(a),解析加固与失败反馈跟上(b),审批上浮是功能主体(c),
动态注入依赖 a 的机制(d),记忆闭环(e)与 MCP 接线(f)相对独立收尾。

### 4.9a 静态自知注入(env 块 + 目录枚举)

- system 组装(`main.ts` systemSuffix / `kernel.ts:165`)前置 **env 块**:cwd、workspaceRoot、OS、
  日期、git 分支、会话初始 permissionMode。
- 注入**模型目录**:当前模型 + `ModelCatalog` 可用清单(修反馈①的根:LLM 从此有真实模型名可抄)。
- 注入**记忆机制 preamble**:告知有长期记忆、按 workspace 隔离、如何写(为 4.9e 的工具铺垫)。
- 注入**可用 recipe profile 枚举** + **已连接 MCP server 摘要**(含被信任门跳过的名单,LLM 能解释
  「为什么没有 github 工具」并引导 opt-in)。
- `subagent_spawn` 工具描述同步改写:model/profile 说明「留空沿用主 agent/default」,枚举可用值。
- 验收:FakeProvider 下 dump system prompt 断言各段齐全;subagent-tool schema 快照测试。

### 4.9b 解析加固与加载失败可见

- `subagent.ts:203` 空串归一化(`opts.model?.trim() || recipe?.model || defaultModel`)+ 经
  `ModelCatalog` 校验:未知模型**早失败**回可行动错误(「未知模型 x,可用:…;留空沿用主模型」),
  不再透传给上游烧一次 404。`subagent-tool.ts:67-73` 守卫同步收紧。
- profile 猜错对齐 skill 范式:`recipe === undefined && profile !== 'default'` → 返回
  「未知画像 x(可用:…)」,不再静默降级(`subagent.ts:196`)。
- `loadSkills`/`loadRecipes` 增 `onWarn` 回调(解析失败/超限/非法 mode),`main.ts` 接 stderr,
  与 plugin/mcp 日志对齐;`appendMemoryLine` 裹 try/catch,失败给用户可行动提示而非裸栈。
- 验收:空串/未知模型/未知 profile 三条路径单测;坏 SKILL.md 出警告不静默。

### 4.9c 子代理审批上浮 + 审批语义修正

- 移除 `subagent.ts:309` 写死的 `interactiveApproval:false`:给子内核注入**代理 ApprovalGate**,
  `.request()` 转调父内核在父会话登记 pending + emit `ApprovalRequested`(复用
  `kernel.ts:808-829` 的 `pendingApprovals`/`decideApproval`),TUI 现有审批面板零改动接管,
  批完 resolve 回子内核。经 `ChildAgentDeps`(`subagent.ts:268`)传接缝。
- worker 档补跨线程审批 RPC(worker 无法直连父 `pendingApprovals`),超时语义与主循环一致。
- **审批超时可区分**(`kernel.ts:817`):超时 resolve 带独立 reason,tool_result 改为
  「审批超时(5 分钟未响应)自动拒绝」,不再谎称「用户拒绝了」;surface 同步提示。
- **拒绝文案富化**(`kernel.ts:595/617`):带当前 permissionMode + 引导(「用户可 /mode 切换或
  重新发起」),LLM 不再自由脑补。
- 验收:子代理 ask 档在 TUI 弹审批、批准后写盘成功(复刻反馈②场景);超时/真拒文案区分单测;
  worker 档审批往返单测。

### 4.9d 动态状态注入(turn 起点接缝)

- `runTurnInner` 起点(`kernel.ts:390-402`)增统一「状态提醒注入」接缝,本片接三个生产者:
  - **toolset diff**:本 turn 可见工具相对上 turn 消失/新增时注入一句解释(MCP 熔断、插件崩溃、
    信任变化统一收口——工具不再无声蒸发);
  - **MCP server 状态变化**(`syncMcpStatus` diff 处顺手转注入,仅变化时,避免噪声);
  - **上下文满度**:接近压缩阈值(如 >70%)注入一次「上下文已用 X%」提醒,LLM 可主动收敛。
- permissionMode 中途切档(`kernel.ts:328`)也经此接缝注入,替代静态 system 行过期问题。
- 验收:熔断→下一 turn 注入提示;切档→下一 turn LLM 可见;注入去重(同状态不重复)单测。

### 4.9e 记忆读写闭环

- 新增 `memory_write` 工具(仿 `makeSkillActivateTool`):复用 `appendMemoryLine` +
  `MemoryStore.writeMemory`,幂等键去重同时修 MEMORY.md 无脑 append 的重复堆行
  (append 前按 `memoryKeyFor` 查重)。兑现 DESIGN §5.3「agent 可读写」。
- 结构化 MemoryStore 读回决策:**并入加载路**(`loadConventionFiles` 合并 `listMemory`)或
  **明确砍掉双写**(MEMORY.md 单一事实源)——二选一,不留死数据。倾向后者(简单、可 git 共享),
  DB 轨保留给 Phase 6 向量检索再启用。
- 验收:LLM 经 `#remember` 等价路径写入 + 下会话读回;重复写幂等;写失败出可行动错误。

### 4.9f MCP 自述与通道接线

- 新增只读工具 `mcp_list_servers`(转发 `statusSnapshot()`:server/状态/工具数/信任层),
  LLM 可回答「你连了哪些 server」且反映实时熔断态。
- MCP 工具描述前缀注入来源:`toolDescriptorFromMcp`(`mcp-host.ts:103`)description 前置
  「[外部 MCP server「X」提供]」。
- 调用失败文案加行动尾句(`mcp-host.ts:205,217`):「该失败已计入熔断;可稍后重试或改用其他工具」。
- resources 接线:`mcp_list_resources` / `mcp_read_resource` 两个工具(经 host 转发);
  prompts 走 CLI slash(`promptSlashName` 已备)给用户,本片可顺延。
- 验收:离线 FakeServer 下三个新工具往返单测;描述前缀快照测试。

## 2. 非目标(顺延)

- checkpoint 对 LLM 暴露 + 回滚工具、todo 跨轮持久与未完成提醒、成本查询工具——【中】级自知项,
  进 [`PHASE-4.10.md`](PHASE-4.10.md) 候选池 §C。
- auto-memory 自动蒸馏管线(Phase N 既定)、向量检索(Phase 6)。
- MCP prompts 的 CLI slash 注册(4.9f 标注可顺延,进 4.10 候选池)。
- 不做 system prompt 的全面重写/人设工程——本阶段只补「事实性自知」,提示词风格不动。
- 收口时按 ADR-14 节奏评估是否触发大阶段统一对抗式审查(4.5 起的 TUI + 本阶段审批上浮/注入面
  均未审,见 [`PHASE-4.10.md`](PHASE-4.10.md) §E)。

## 3. 里程碑

| 切片 | 预估 | 交付判据 |
|---|---|---|
| a 静态注入 | 1d | system 含 env/模型/记忆/画像/MCP 五段,反馈①根因闭合 |
| b 解析加固 | 0.5–1d | 空串/未知模型/未知 profile 早失败可行动,加载失败可见 |
| c 审批上浮 | 1.5–2d | 复刻反馈②场景:TUI 弹审批批准即写盘;超时/真拒可分 |
| d 动态注入 | 1d | 工具消失/切档/满度均有 turn 级提示,去重不噪 |
| e 记忆闭环 | 1d | memory_write 落地,双写单读死数据收口 |
| f MCP 接线 | 1d | mcp_list_servers + resources 工具往返,来源前缀落地 |
