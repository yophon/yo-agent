# Phase 4.8 —— 工程卫生与基建补课(已完成)

> **收口状态**:a–e 五切片全部交付(2026-07-02,commit 796e9e0…),572 测试全绿(68 文件)。
> `check` 升级为 typecheck + **lint** + gen:schema + test;CI 落地(含 schema 漂移校验);
> 全仓行覆盖首测 **85.5%**(v8,未设门槛)。真机反馈两条(子代理模型上下文 / 审批上浮)记录于
> [`feedback/4.8.md`](feedback/4.8.md),立项留待下一阶段。

> 4.7 收口后的全仓盘点(3 路并行审读:代码债 / 工程基建 / 架构缺口)结论:代码质量信号极好
> (源码零 TODO/FIXME、零 `any`/`@ts-ignore`、包依赖图无循环无越层),但**工程基建长期缺位**——
> 无 CI、无 lint、无 coverage、README 落后两个 phase。本阶段不动内核、不加功能,专修"底座外围":
> 让验证门从"本地自觉"升级为"远端强制",并把文档与依赖对齐到现实。
>
> **基线**:4.7 收口 560 测试全绿(67 文件,1 真机冒烟门控跳过);`check` = typecheck + gen:schema + test。

---

## 0. 现状诊断(4.7 收口后盘点)

| # | 维度 | 问题 | 现状根源 |
|---|---|---|---|
| Q1 | 文档 | **README 落后两个 phase**:结构图漏 `plugin-host`/`surface-acp` 两个真实包、把 surface-acp 标为"Phase 3 待办";状态段止步 4.5(460 测试),4.6/4.7 无踪;`README.md:18` 开头挂"🚧 Phase 4 进行中"与同句"六片全交付"自相矛盾 | 状态段按 phase 追加,4.6/4.7 交付时漏更 |
| Q2 | 基建 | **无 CI**:`.github/workflows` 不存在,`check` 只靠本地手跑;GitHub remote 已有(yophon/yo-agent),回归无远端兜底 | 从未立项 |
| Q3 | 基建 | **无 lint**:零配置零依赖,但源码残留 9 处失效的 `eslint-disable` 注释(`tools/src/exec.ts`、`tui/app.ts` ×6、`input/editor.ts`、`tui-smoke.test.ts`)——曾预期有 lint 却从未落地,死注释无人校验 | lint 从未立项,注释手写自律 |
| Q4 | 基建 | **无 coverage 度量**:560 测试无法量化行覆盖;且 `vitest.config.ts` 只扫 `packages/*/test`,**`apps/yo-agent`(main.ts 482 行 CLI 入口)零测试覆盖** | vitest include 只写了 packages |
| Q5 | 基建 | **schema 漂移不设防**:`check` 里 `gen:schema` 每次重新生成,但生成物(已入库)有未提交 diff 时 check 照样绿——协议改了忘提交 schema 无人拦截 | check 无 `git diff --exit-code` 校验 |
| Q6 | 依赖 | **zod 双约束**:protocol `^3.24.1` vs surface-mcp `^3.23.8`,同 major 两个约束 | 各 phase 各自加依赖未回头对齐 |
| Q7 | 健壮 | **TUI 静默降级无反馈**:`execute.ts:87`(steer)、`execute.ts:238`(interrupt)、`app.ts:239`(submitInput)三处 `.catch(() => {})`——用户操作失败无任何 UI 提示,掩盖问题 | 4.5/4.6 增量交付时的省事写法 |

**保留资产**(本阶段不许动摇):源码态 workspace(`exports` 指 src、tsx 直跑、无构建产物);
`check` 三件套语义;4.7 的 TUI 架构(纯 reducer + `<Static>` + decoder)。

---

## 1. 切片规划

每切片独立提交、只补该片测试、全量回归不退化。顺序 a→e:先对齐文档(独立无依赖),
再落 lint(CI 要跑它),测试基建居中,CI 把前面全部串起来,依赖与健壮性收尾。

### 4.8a 文档对齐(Q1)

- README 结构图补 `plugin-host`/`surface-acp` 两包(含一行职责注释),移除"(Phase 3:...)"过时待办行。
- 状态段:Phase 4 去掉"🚧 进行中"矛盾表述;补 4.6/4.7 两条交付纪要(与 PHASE-4.6/4.7.md 头部口径一致);
  测试计数更新为当前真值(560 / 67 文件)。
- 验收:README 与 `ls packages`、`git log`、实测数字三方对得上。

### 4.8b lint 落地(Q3)

- 引入 **Biome**(单一工具,零插件链):`biome.json` 对齐现有风格(单引号、分号、2 空格),
  **仅启用 linter,formatter 不开**——避免全仓 format churn 污染 blame,格式化留后续单独评估。
  规则:recommended + `useExhaustiveDependencies`(接住 tui/app.ts 那 6 处 hooks 依赖标注)。
- 清 9 处失效 `eslint-disable`:仍需豁免的改为 `biome-ignore`(带理由),不再触发的直接删。
- 根 scripts 增 `lint: biome check .`;`check` 升级为 `typecheck && lint && gen:schema && test`。
- 验收:`pnpm run lint` 零告警;`check` 全绿;grep 全仓无 `eslint-disable` 残留。

### 4.8c 测试基建(Q4)

- `vitest.config.ts` include 扩为 `{packages,apps}/*/test/**`;引入 `@vitest/coverage-v8`,
  根 scripts 增 `test:coverage`(不设阈值门槛,先有度量再谈门槛)。
- `apps/yo-agent/src/main.ts` 的 CLI 参数解析抽为可测纯函数(如已可测则直接补测),
  补冒烟测试:`--tui` / `-p` / `--mode jsonl` / `rpc` / `mcp-server` 各分支的解析结果。
- 验收:apps 首批测试进收集且绿;`pnpm run test:coverage` 出报告。

### 4.8d CI(Q2 Q5,依赖 b/c)

- `.github/workflows/ci.yml`:push + PR 触发,Node 22 + pnpm 10,跑
  `pnpm install --frozen-lockfile` → `lint` → `typecheck` → `gen:schema` + **`git diff --exit-code`
  校验 schema 漂移**(Q5 就地解决)→ `test`。
- 验收:workflow 语法有效(`act` 或推送后首跑绿);本地 `check` 语义与 CI 一致。

### 4.8e 依赖与静默降级收尾(Q6 Q7)

- zod 统一 `^3.24.1`(surface-mcp 上调),`pnpm install` 后锁文件单版本。
- TUI 三处 `.catch(() => {})` 改为 dispatch 一条 notice(steer/interrupt/submit 失败可见);
  `app.ts:143` 文件补全失败回退空列表属合理降级,保留但补注释说明有意为之。
- 验收:各补一条 model/smoke 测试(失败路径出 notice);全量回归绿。

---

## 2. 非目标

- 不拆 `kernel.ts`(1076 行)、不补 TUI 渲染层单测大头——体量大、宜与下次大阶段收口的对抗式审查一起做。
- 不开 Biome formatter(全仓 format churn 另行评估)。
- 不升 React 19 / ink 6(decoder.ts 已收拢 ink 私有行为依赖,升级成本已压低,择机专项做)。
- 不动 `registry.ts:94` profile 工具过滤谓词(当前默认放行)——属功能语义收紧,列为 **Phase 5 开放渠道前置项**。
- 不做 coverage 阈值门槛(先度量一个阶段再定线)。

## 3. 里程碑

| 切片 | 预估 | 交付判据 |
|---|---|---|
| a 文档对齐 | 0.5h | README 与仓库现实三方对齐 |
| b lint 落地 | 1–2h | `pnpm run lint` 零告警,eslint-disable 清零 |
| c 测试基建 | 1–2h | apps 进测试收集,coverage 可跑 |
| d CI | 0.5–1h | workflow 全绿含 schema 漂移校验 |
| e 依赖与收尾 | 1h | zod 单约束,静默 catch 清零(除注明降级) |
