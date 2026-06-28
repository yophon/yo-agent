# Phase 4.5 —— 安装分发 + 完整交互式 TUI

> 对应 [`DESIGN.md`](DESIGN.md) §7.2（CliSurface / Ink TUI）。一个面向**自用落地**的小阶段：让 yo-agent 能像普通命令行工具一样「装一次、任意目录直接 `yoagent` 启动」，并把 Phase 1 遗留的「单次问答型 TUI」彻底升级为可日常使用的**交互式多轮 REPL**。
>
> 触发动机：Phase 4 收口后首次真机试用，发现 (1) 没有全局命令、必须 `pnpm --filter ... start --` 冗长调用；(2) `--tui` 不带 `-p` 直接落「用法」分支无法进入；(3) 即便进入也只是「提交一次 → 渲染 → 自动退出」，无输入框、无多轮、无状态可视。属于「能力都在、出入口太糙」，故单列 4.5 收口体验层，不掺入 Phase 5 渠道开放。
>
> **基线**：Phase 4 整体收口 445 测试全绿。本阶段在此之上增量交付，全量回归不退化。

---

## 范围

纯**体验/分发层**改动，不触内核语义、不改协议、不动安全边界：

1. **全局命令 `yoagent`**：源码态 workspace（无构建产物、tsx 直跑）下的安装器 + 软链分发。
2. **私密运行配置**：`~/.config/yo-agent/config.env` 自动加载（provider key / base url / 模型），keys 不进 git、不污染 shell rc。
3. **完整交互式 TUI**：结构化区块渲染 + 多轮 REPL + 状态栏 + 行内编辑 + slash 命令 + 中断 / steer。

非目标（明确不做，留待后续）：鼠标 / 滚动回看 UI、Markdown 富渲染、多行编辑器、主题配置、`/compact` 等需要新内核接缝的命令。

---

## 交付内容

### 1. 全局命令 `yoagent`

- `apps/yo-agent/bin/yoagent.mjs` —— 启动器。源码态仓库不能 `node main.js`，故启动器用**仓库自带的 tsx loader**（`node --import .../tsx/dist/loader.mjs`）加载 `main.ts`，并以**用户当前 cwd** 为 agent 操作根目录。`TSX_TSCONFIG_PATH` 锁定仓库根 tsconfig，使路径别名（`@yo-agent/*`→`packages/*/src`）从任意目录解析。
- `apps/yo-agent/package.json` 增 `bin: { yoagent }`。
- `scripts/install-cli.ts`（`pnpm run install:cli`）—— 把启动器**软链**（非拷贝，随 `git pull` 即时生效）到 PATH 上首个「在 `$PATH` 且可写」的目录（`/opt/homebrew/bin` → `~/.local/bin` → `/usr/local/bin`，可 `YO_BIN_DIR` 覆盖）；不在 PATH 时打印提示。

### 2. 私密运行配置（启动器自动加载）

- `~/.config/yo-agent/config.env`（权限 600，`KEY=VALUE`，`#` 注释；`YO_CONFIG` 可改路径）。
- 加载规则：**shell 已显式 export 的同名变量优先**（便于 `YO_MODEL=... yoagent ...` 一次性覆盖），配置文件只补空缺。
- 与 4F 的 provider 选择链对齐：`OPENAI_API_KEY` + `OPENAI_BASE_URL` + `YO_MODEL`（或 `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`）。

### 3. 完整交互式 TUI（`packages/surface-cli`）

**渲染模型重构**：从「单 string 累加」改为**结构化区块**（`user` / `assistant` / `reasoning` / `tool` / `notice`）。已完成区块进 ink `<Static>`（只渲一次、落滚动区，不随每帧重绘 → 长会话不卡）；当前轮的流式区块在动态区实时刷新。

- **分角色渲染**：用户输入（青）/ 助手文本（默认）/ 推理（暗灰 `💭`）/ 通知（按 tone 着色）。
- **工具调用分组**：`图标 名称 · summary` + 输出末 N 行预览（暗色缩进）+ 完成 `✓/✗` + 截断落盘提示。覆盖 `ToolCallStarted/Output/Completed` 按 `id` 关联聚合。
- **状态栏**（底部常驻）：`model · 权限模式 · ↑入 token ↓出 token (cache) · $成本 · cwd`，token/成本来自 `UsageUpdate`（本轮实时）+ `TurnCompleted.usage`（累计）。
- **行内编辑**：光标 ←→、`Ctrl+A/E`（行首/尾）、`Ctrl+U`（清空）、退格、光标处插入。
- **输入历史**：`↑/↓` 召回既往提问。
- **slash 命令**：`/help` `/clear` `/model` `/cwd` `/exit` `/quit`（slash 不作为 prompt 提交）。
- **中断 / 引导**：运行中 `Esc` / `Ctrl+C` → `kernel.interrupt()` 中断当前轮；运行中直接输入 + 回车 → `kernel.steer()` 轮内追加引导；空闲 `Ctrl+C` 退出、`Esc` 清空输入。`runTui` 设 `exitOnCtrlC:false` 把 Ctrl+C 交给组件。
- **审批面板增强**：圆角边框按 risk 着色、显示工具名 + 风险等级 + 入参摘要、↑↓ 选择 / Enter 确认 / Esc 拒绝。
- `main.ts`：放行 `--tui` 无初始 prompt 启动（进输入态）；传入 `model/cwd/permissionMode` 供状态栏。

**内核侧零改动**：复用既有 `interrupt()` / `steer()` / `listSessions()` / `listModels()` / `decideApproval()` 接缝（Phase 4 已具备）。

---

## 验证

- `packages/surface-cli/src/tui-format.ts` 纯函数（token/成本/路径/预览/状态栏/slash 解析）→ `tui-format.test.ts` **8 测试**。
- `tui-smoke.test.ts`（ink-testing-library 离线）→ 由 3 扩到 **12 测试**：流式文本 + 完成、审批裁决（Enter / ↓↓Enter）、空 prompt 进输入态、多轮、`/exit`、工具分组渲染、状态栏用量、`/help`+`/clear`、`Esc` 中断、运行中 steer、`↑` 历史召回。
- **真机 PTY 冒烟**（接真实 gpt-5.5）：`yoagent --tui` 进 REPL → `/help` 渲染命令 → 工具调用读文件产出答案 → 状态栏显示模型 → `/exit` 退出，expect 全关卡通过（exit 0）。
- 全量门：`pnpm run check` = typecheck 0 + gen:schema + **460 测试**（59 文件，1 真机冒烟门控跳过）。

---

## 用法速查

```bash
pnpm install && pnpm run install:cli          # 装一次（软链 yoagent 到 PATH）

# 私密配置（示例：OpenAI 兼容网关）
cat > ~/.config/yo-agent/config.env <<'EOF'
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://your-gateway/v1
YO_MODEL=gpt-5.5
EOF
chmod 600 ~/.config/yo-agent/config.env

yoagent --tui            # 交互式聊天（推荐日常）
yoagent --tui -p "..."   # 带首问进入，之后多轮
yoagent -p "..."         # 单次问答（headless）
```

TUI 内：Enter 发送 · 运行中 Enter 追加引导 · Esc/Ctrl+C 中断当前轮 · ↑↓ 历史 · ←→/Ctrl+A/E 光标 · `/help` 看全部命令。
