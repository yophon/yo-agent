# yo-agent DESIGN.md 查漏补缺补充包（基于 claudeLearning 31 篇笔记）

> 来源：8 个 bundle 对 DESIGN.md 的 findings，基于 `claudeLearning/` 31 篇 Claude Code / Agent SDK 笔记 + `docs/research/claude-code.md`（2026-06 官方文档核查）产出。
> 本文档已去重、合并同类项、按 DESIGN 章节归类，剔除与设计已充分覆盖的纯 confirmation。
> 措辞均写成可直接落到 DESIGN.md 的形式（含机制 / 参数 / 命名）。

---

## 高优先级待应用清单（Top 14）

| # | DESIGN 章节 | 类型 | 一句话改动 | 优先级 |
|---|------------|------|-----------|--------|
| 1 | §2.1 | gap | TurnLoop 补 `stop_reason='max_tokens' → 追加「请继续」user 消息续传`，不抛 TurnFailed | high |
| 2 | §4 | gap | ProviderEvent / usage 表补 `cache_creation_input_tokens` + `thinking_tokens` 两字段，否则成本低估 | high |
| 3 | §4 | gap | prompt cache 机制三参数落地：4-breakpoint 上限、tools 末元素打 cache_control、~1024 token 最低阈值 | high |
| 4 | §4 | gap | thinking 须加 beta header `interleaved-thinking-2025-05-14`；max_tokens ≥ budget + 答案；thinking 不可 cache | high |
| 5 | §2 | enrichment | 主循环明确「同 step 多 tool_use 用 Promise.all 并发执行」，结果合并为单条 user 消息回填 | high |
| 6 | §4 | correction | effort 轴对 AnthropicProvider 应翻译为 `thinking.budget_tokens`，无 `output_config` 原生字段 | high |
| 7 | §5.1 | enrichment | Condenser 决策纳入「compact 后 cache 必失效」成本约束 + compact 频率 guard | high |
| 8 | §3.1 | gap | `ToolContext` 补字段：session_id / cwd / user_id / transcript_path（多租户 RBAC + audit 基础） | high |
| 9 | §3.3 | gap | MCP 工具名强制 `mcp__<server>__<tool>` 格式 + 权限 matcher 通配 `mcp__github__*` | high |
| 10 | §3.3 | gap | 内部 MCP server 防护：破坏性 tool 须 `confirm` 参数（默认 dry_run）+ 每用户每分钟限流 | high |
| 11 | §3.3 | gap | MCP Sampling 原语：server 反向借调 Host LLM（`sampling/createMessage`），需 host 端路由 + 限流 | high |
| 12 | §8.3 | gap | Skill 渐进披露：ContextAssembler 每轮注入 `{name,description}` 摘要目录；description 用 TRIGGER/SKIP 模板 | high |
| 13 | §3.4 / §9.2 | enrichment | Permission matcher 语法 `Bash(cmd:*)` + permission mode 扩展 + Protected Paths 枚举 | high |
| 14 | §8.3 | correction | SKILL.md frontmatter 的 `tools?` 是 yo-agent 扩展（CC 原生无），需显式标注或下移到 recipe | high |

---

## §2 Agent 内核（Kernel）

### 【gap·high】§2.1 stop_reason='max_tokens' 须自动续传，不能抛错
TurnLoop 伪码补一条分支：当 `ProviderEvent{kind:'Stop', reason:'max_tokens'}` 时，向消息历史追加 `{role:'user', content:'请继续'}` 并继续循环，**不** `emit(TurnFailed)`。语义：模型话未说完但本次配额用尽，属正常续写而非错误。
出处：20-AgentLoop内部机制.md（§七）。

### 【gap·medium】§2.1 stop_reason='pause_turn'（extended thinking 暂停）须在循环处理
若接 Anthropic extended thinking（Claude 4 系列），`ProviderEvent{kind:'Stop', reason}` 枚举需加 `'pause_turn'`（与 `'tool_use'/'end_turn'/'max_tokens'/'refusal'` 并列），循环遇到 `pause_turn → continue`（继续循环）而非退出。
出处：20-AgentLoop内部机制.md（§七）。

### 【enrichment·high】§2 同 step 多 tool_use 必须 Promise.all 并发执行
Claude 4.x 默认倾向一次返回多个 tool_use block。主循环「执行 0..N 个 tool」必须实现为 `Promise.all` 并发，所有结果收集后**作为单条 user 消息内的多个 tool_result 一起回填**（Anthropic 要求单条 user 消息包含所有 tool_result）。顺序 for 循环会把 5×200ms 工具变成 1s。
出处：13-ToolUse实战.md。

### 【enrichment·medium】§2 ContextAssembler 增 count_tokens 执行前预检
`client.messages.count_tokens(model, messages)` 不发推理只计 token。ContextAssembler.assemble() 在 Anthropic provider 下可选调用做预检：预估 input > `context window * 0.9` 时**先触发 Condenser**，压缩后仍超则 `TurnFailed{error:'token_budget_exceeded'}`（复用已有 `StopReason='tool_budget_exceeded'`），避免浪费一次推理 400。
出处：12-AnthropicAPI入门.md、18-BatchAPI与成本优化.md（§6）。

### 【enrichment·medium】§2 streaming 中断后只在 final message 确认后写 history
streaming 中途网络断、assistant 回复未完整时，history **不应**写入半截内容。正确做法：拿到 `stream.finalMessage()`（TS）后才 append messages。observation 注入逻辑应确保只在 provider stream 正常完成（emit Stop）后才写 EventLog 的 assistant turn；partial + Error 场景（§2.4）只留 partial，不构成合法 assistant turn，不触发 tool 执行。
出处：12-AnthropicAPI入门.md（踩坑#5）。

### 【gap·medium】§2.3 LoopBreaker WARN 须注入可理解提醒消息
LoopBreaker `check()` 返回 `'warn'` 时，内核应向 LLM 注入一条 tool_result 级系统提醒（如「你已连续调用同一工具 10 次，可能陷入循环，请考虑换思路或向用户请求帮助」），迫使 LLM 重新思考，而不仅内部记录 warn 状态。
出处：20-AgentLoop内部机制.md（§十踩坑5）。

### 【gap·medium】§2.1 Plan→Todo 接力工作流写进主循环说明
在 §2.1 主循环说明注明：复杂任务推荐 plan→todo 工作流——LLM 在 plan mode 探索后调 `ExitPlanMode`，进入执行后用 `todo_write` 建清单，TurnLoop 按 todo 推进，每步 PostToolUse hook 自动验证。resume 后可从 todo 队列恢复断点（正对应 resume(cursor) 目标）。
出处：09-Plan-Mode.md（§六.1）。

### 【enrichment·medium】§2.5 子 agent 底层 = fork 新 Agent Loop 实例 + 最终 text 作 tool_result 注入
`subagent_spawn` 工具的 executor 实现规范：(1) 创建新 Agent Loop 实例；(2) 从父复制 options（model/tools/permissions）；(3) 给子独立 messages history；(4) 以 subagent.prompt 作初始 user 消息；(5) 跑子 loop 到结束；(6) `return childFinalText` 作为 tool_result 注入主 history。即主 history 里是标准 `tool_use(subagent_spawn) + tool_result(summary)` 模式，主循环**无需**特殊分支处理 SubagentResult 事件。
出处：20-AgentLoop内部机制.md（§九）。

### 【gap·high】§2.5 子 agent 补 maxTurns / isolation / memory 字段
`SubagentManager.spawn()` 的 opts 和 recipe YAML 同时补：
- `maxTurns?: number`——限制子 agent 轮次。
- `isolation?: 'none' | 'worktree' | 'container'`——`worktree` 时子 agent 在独立 git worktree 跑，跑完有改动则保留 worktree 路径返回、无改动自动清理（并行批量改文件的隔离核心）。
- `memory?: boolean`——启用独立 memory 目录 `~/.yo-agent/agent-memory/`，与主 session memory 隔离。
- `skipContextFiles?: boolean`——内置 Explore 子 agent 跳过 CLAUDE.md/yo.md 加载以加速。
- `outputMaxTokens?: number`——约束子 agent 报告长度，防回注主 context 膨胀。
出处：07-Subagents子代理.md、21-自定义Tool与Subagent.md、claude-code.md（§8）。

### 【enrichment·medium】§2.5 background 子 agent 审批浮现链路
background 子 agent 触发 `ApprovalRequested` 时应能通过 `parentSessionId` 链路浮现到父 session，由父 session 的 Surface 渲染审批 allow/deny（对应 CC v2.1.186+ 后台 subagent 权限浮现到主会话；此前版本后台审批直接拒绝）。在 §2.5 background 委派模式补此说明。
出处：07-Subagents子代理.md（claude-code.md §8 Agent Teams）。

### 【enrichment·medium】§2.5 并行 fan-out 需主 prompt 显式指示
主 prompt 不写「并行调三个 Task」时 LLM 默认顺序跑、慢 3x。SubagentManager 增 `spawnBatch(tasks[], { parallel: true })` 语义（单轮多 spawn）；Recipe instructions 模板提供「**并行**派以下 N 个 subagent（单条消息发 N 个 Task）」示例 prompt。
出处：23-实战AgentSDK项目.md（踩坑#1）。

---

## §3 工具系统（Tools）

### 【gap·high】§3.1 ToolContext 字段补全（多租户 / audit 基础设施）
`ToolExecutorRef.execute(input, ctx: ToolContext)` 的 `ToolContext` 明确列出字段：`session_id`、`cwd`、`user_id`（应用层注入）、`transcript_path`。用途：①按 user_id 做 RBAC；②按 session_id 写 audit log；③按 cwd 限制文件读写范围。这是聊天平台多用户 + audit 场景的必要基础设施。
出处：21-自定义Tool与Subagent.md。

### 【enrichment·medium】§3.1 tool description 三段式 + input_schema 严格化
- description 规范格式：第一行说返回什么，第二行说「仅在何条件有效（TRIGGER）」，第三行用「不返回: X/Y/Z（用专用 tool 获取）」明确排除项，避免相邻工具被 LLM 混淆调用。
- inputSchema 应尽量用 `enum`/`minimum`/`maximum`/`pattern` 约束（如 `action: enum[create,update,delete]`、`amount: minimum 0 maximum 10000`、`currency: pattern ^[A-Z]{3}$`），显著降低 LLM 填参出错率。并在 Gemini provider 降级（§4.2）时注明需剥除的 JSONSchema7 字段。
出处：21-自定义Tool与Subagent.md（§4.1/§4.2）、24-MCPServer入门.md（§5.1）。

### 【gap·medium】§3.2 tool 错误必须用 status='error'（is_error）不能包在 'ok'
内置工具 executor 出错必须 `emit ToolCallCompleted{status:'error'}`，不能包在 `status:'ok'` + 错误文本里——否则 PolicyEngine 和 LLM 都误判为正常输出继续推理，造成幻觉串联。MCP tool 结果转换层同样将 MCP 的 `isError:true` 映射到 `status='error'`。建议 LoopBreaker 区分：业务错误不应立即熔断。
出处：21-自定义Tool与Subagent.md、24-MCPServer入门.md（§5.4/§6.2）。

### 【gap·medium】§3.2 列表型工具主动截断 + 分页约定
列表/搜索类工具（grep/bash/search_logs）返回行数超阈值时主动截断，末尾附 `[截断，还有 N 行未显示；用 limit 参数加大]` 提示；inputSchema 约定 `limit`（默认 50，最大 200）/`offset` 参数。与已有「大输出写盘只回路径（nanobot 50KiB）」互补：前者截短内容送 LLM，后者超大文件不走内存。
出处：21-自定义Tool与Subagent.md（§4.5）、13-ToolUse实战.md（踩坑#8）。

### 【gap·medium】§3.4 副作用工具 dry_run / confirm 双步模式（工具级，与协议审批并存）
内置高危工具（bash/write）inputSchema 增 `confirm` 字段约定：LLM 第一次不带 `confirm=true` 时只返回「会做什么」描述，LLM 转向用户确认后再带 `confirm=true` 第二次真正执行。与 §3.4 ApprovalGate（协议级审批，引擎拦截）形成纵深防御——dry_run 是 LLM 自主两步确认，ApprovalGate 是引擎强制门。
出处：21-自定义Tool与Subagent.md（§4.4）、29-Agent设计模式.md（铁律#9）。

### 【enrichment·high】§3.1/§3.4 Permission matcher 语法落地：`Bash(cmd:*)`
明确采用 Claude Code 同等 matcher 语法（迁移 settings 无需重写）：`<工具名>(<参数 pattern>)`；`Bash(npm test)` 精确匹配命令本身不带参数，`Bash(npm test:*)` 允许带任意参数。优先级 `deny > ask > allow > 默认行为`，deny 跨层取并集（任意层 deny 即拒绝，不可被上层 allow 覆盖）。
出处：03-核心工具与权限模型.md（§五.2）、30-生产化与团队协作.md（§2）。

### MCP 集成（§3.3）

### 【gap·high】§3.3 MCP 工具名强制 `mcp__<server>__<tool>` + 通配权限
MCP 工具注入 ToolRegistry 时 `name` 字段强制格式 `mcp__{serverName}__{toolName}`（双下划线，serverName 来自 `.yo-agent/mcp.json` 顶层 key）。这是权限通配 matcher（`mcp__github__*`、`mcp__postgres__delete_*`）正确匹配的前提，也影响 yo.md 工具使用说明。白名单字段名：`enabledMcpServers: [...]`（project 级白名单），`enableAllProjectMcpServers: true`（信任所有）。
出处：06-MCP在Claude-Code里的用法.md（§5/§3.1）、claude-code.md（§3）。

### 【gap·high】§3.3 MCP server 三层配置 + project 级默认拒绝
建模三层：`~/.yo-agent/mcp.json`（user 级，全局持久）+ `.yo-agent/mcp.json`（project 级，提交 git，**默认不激活，需 config 显式 opt-in 信任**，防供应链攻击）+ local 级（本机临时）。`.yo-agent/config.toml` 的 `enabledMcpServers` 控制 project 级白名单。
出处：06-MCP在Claude-Code里的用法.md。

### 【gap·high】§3.3 内部 MCP server（McpServerSurface）工程铁律
- **破坏性 tool 须 `confirm: bool` 参数（默认 false，默认返回 dry_run 结果）**——server 侧二次防护，与 §9.2 ApprovalGate（agent 侧）叠加纵深防御。
- **每用户每分钟调用限流**（如 `maxCallsPerMinute=30`，滑动窗口），超限返回错误而非无限穿透（防 LLM bug 一晚调爆 API）。
- **stdio 模式日志必须写 stderr 或文件**：任何 `process.stdout.write` 污染 JSON-RPC 协议会致宿主失联；pino 须配 `destination: process.stderr`。
出处：25-实战内部MCPserver.md（§4.1/§4.5/§6.1）、24-MCPServer入门.md（§6.1）。

### 【gap·high】§3.3 MCP Sampling 原语：server 反向借调 Host LLM
MCP server 在 tool 内部通过 `ctx.sampling.create_message({messages, max_tokens})` 反向调用 Host 的 LLM（成本计入 user 配额，server 不持 API key）。yo-agent 作为 MCP host 需实现 `sampling/createMessage` 请求处理器（路由到当前会话 Provider）+ 调用频率限制（防恶意 server 滥用 user 配额）。典型用途：server 内 BM25 候选 + LLM 语义重排、智能摘要、query 改写。
出处：27-MCP进阶ResourcesPrompts.md（§7）。

### 【gap·medium】§3.3 MCP Resources 原语：list_resources + subscribe + 多 mime
McpServerSurface 暴露 resource 需：① `list_resources()`（Host UI 发现 resource 的必备接口，不实现则无法展示列表）；② subscribe 机制（server 主动推送更新通知，Host 重新拉取，需心跳超时清理防内存泄漏）；③ 多 mime type（text/image/binary）。URI 命名约定 `agentresource://session/{id}/...`。
出处：27-MCP进阶ResourcesPrompts.md。

### 【gap·medium】§3.3 MCP Prompts 映射为 slash commands
MCP Prompts（参数化 prompt 模板）映射为 `/mcp__<server>__<prompt>` slash 命令。McpServerSurface 对外暴露时，把内置 skill/recipe 包装为 MCP Prompt——被 Claude Code/Cursor 接管时，skills 作为 Prompts 出现在宿主 UI 的 slash 列表（低成本生态融合）。在 §11.2 或 §3.3 补此映射。
出处：27-MCP进阶ResourcesPrompts.md（§5）、claude-code.md（§3）。

### 【enrichment·medium】§3.3 Streamable HTTP 可恢复性（session id 断线重连）
Streamable HTTP 相对旧 SSE：单一端点、流式响应、**可恢复（网络断后用 session id 续连）**、鉴权走标准 HTTP headers。yo-agent 作为 MCP host 连接外部 Streamable HTTP server 时，可利用 server 的 session id 做 transport 层重连（区别于 yo-agent EventLog 的应用层 resume）。补 client 端 session id 保存与断线重连逻辑。
出处：26-MCP安全与远程化.md（§6）。

### 【enrichment·medium】§3.3 MCP Streaming Progress：report_progress 长任务进度
长任务（>10s）通过 `ctx.report_progress(progress, total)` 推进度（Host 显示进度条 / 决定是否 cancel），独立于 tool result chunks。host 端接收外部 server 的 progress notifications 应转换为 ToolCallOutput delta 事件；server 端长时工具（bash 长任务）应通过 progress notifications 汇报进度。
出处：27-MCP进阶ResourcesPrompts.md（§6）。

### 【enrichment·medium】§3.3 mcp.json 的 `${VAR}` 环境变量插值
解析 mcp.json 时对 `${VAR}` 格式（如 `${GITHUB_TOKEN}`）做 process.env 展开，展开值内存持有不写盘、不进日志，防 token 硬编码进配置文件。
出处：06-MCP在Claude-Code里的用法.md（§3/§9）。

### 【enrichment·medium】§3.3 ToolSearch 懒加载阈值建议 >20 tool
ToolRegistry 懒加载策略：>20 个 tool 时启用 ToolSearch 模式（对齐 Claude Code），超阈值的 MCP tool 只注册 name+description 摘要，schema 在 LLM 调用前按需拉取。配套内置工具 `ToolSearch` + `WaitForMcpServers`。
出处：06-MCP在Claude-Code里的用法.md（claude-code.md §3）。

### 【enrichment·low】§3.3 MCP server 灰度发布 + deprecation 策略
McpServerSurface tool schema 变更遵循 deprecation：v1/v2 并行路径（`/mcp/deploy` vs `/mcp/deploy-v2`），用户 opt-in v2，稳定后切默认；废弃 tool 保留至少一版并标注 `[DEPRECATED]` + warning 日志，避免宿主因 tool 突然消失调用失败。
出处：25-实战内部MCPserver.md（§6）。

### 【enrichment·low】§3.3 MCP inspector 作为内部 server 开发调试工具
`packages/mcp/` 开发优先用 MCP Inspector 而非直接联调宿主，命令：`npx @modelcontextprotocol/inspector node dist/mcp-server/index.js`（web UI 手动调 tool/resource/prompt，看 JSON-RPC 详情，比联调宿主快约 5 倍）。可在 §13 Phase 3 补充。
出处：24-MCPServer入门.md（§4）。

### 【enrichment·high】§3.2 内置工具集补缺项（标注 Phase N）
补充：`MultiEdit`（一次精确替换同文件多处，token 高效，edit 工具可支持 patches 数组）、`EnterPlanMode`/`ExitPlanMode`（见 §8.3 Plan Mode）、`ToolSearch`/`WaitForMcpServers`、`AskUserQuestion`（结构化多选，IM 可渲染按钮）、`LSP`（Phase N，接口预留 `kind='lsp'`）、`EnterWorktree`/`ExitWorktree`。
出处：03-核心工具与权限模型.md（§3）、claude-code.md（§3）。

---

## §4 Provider 抽象（BYOK）

### 【gap·high】§4 usage 表 / UsageUpdate 补 cache_creation + thinking_tokens
Anthropic usage 对象含：`input_tokens`、`cache_creation_input_tokens`（写 cache 加价 1.25x~2x）、`cache_read_input_tokens`（读 cache 打折 0.1x）、`output_tokens`，开 thinking 后加 `thinking_tokens`。DESIGN 现仅 input/output/cache_read，**缺 cache_creation（成本低估 25%~100%）+ thinking_tokens（thinking 费用无法归因）**。补全两字段并在成本公式分别乘倍率。
出处：14-PromptCaching.md、18-BatchAPI与成本优化.md（§8）。

### 【gap·high】§4 prompt cache 三参数机制落地
- **4-breakpoint 上限**：Anthropic 最多 4 个 cache breakpoint，超过报错/不生效。典型分配：bp1=system 长文档末、bp2=tools 列表末、bp3=对话历史稳定早期 turn 末、bp4 留半动态数据。
- **tools 端标记位置**：cache_control 不加在 tools 字段本身，而加在 **tools 数组最后一个工具对象上**（含义：缓存 system + 所有工具的前缀）。
- **~1024 token 最低阈值**：Sonnet 约 1024+ token 才生效，低于此静默不缓存（cache_creation/cache_read 均 0）。ContextAssembler 组装时检查前缀长度，低于阈值跳过写 cache_control 避免误导 UsageUpdate。
出处：14-PromptCaching.md。

### 【gap·medium】§4 prompt cache 1h TTL 选项
两档 TTL：5min（默认，写 cache 加价 1.25x）/ 1h（加价 2x），通过 `cache_control.ttl:'1h'` 切换。批处理 recipe（间歇任务）用 1h，对话/编程 session 用 5min。ContextAssembler 按 recipe / session 类型决定 TTL。
出处：14-PromptCaching.md。

### 【gap·high】§4 thinking 三约束（beta header / max_tokens / 不可 cache）
- AnthropicProvider.streamChat() 在 **thinking enabled + tools 非空时自动附加** `extra_headers={'anthropic-beta':'interleaved-thinking-2025-05-14'}`，否则每次 tool_result 回来后 Claude 无法在调下一工具前继续推理。
- `max_tokens` 必须 ≥ `budget_tokens + 期望输出长度`（推荐 budget × 1.5~2）；thinking enabled 时 AnthropicProvider 校验并自动补足。
- thinking 内容**不进 cache**（每次全新），仅 system/tools/messages 仍可 cache。
出处：15-ExtendedThinking.md。

### 【enrichment·high】§4.4 ContextAssembler 保证 tools 排序稳定
某些框架 autosort 工具列表导致内容看似一样但 hash 不同、cache 永久 miss。`resolveAvailable()` 返回工具列表须保证输出顺序稳定：内置工具按注册顺序固定，MCP 工具按 `server+name` 字典序固定。
出处：14-PromptCaching.md（踩坑#6）。

### 【enrichment·medium】§4 system prompt 组装顺序 + 各段 cache_control
`build_system_prompt` 拼接顺序与 cache 放置：`[{text:INTERNAL_BASE_PROMPT}, {text:USER_YO_MD, cache_control:ephemeral}, {text:PROJECT_YO_MD, cache_control:ephemeral}, {text:SKILLS_DIRECTORY, cache_control:ephemeral}, {text:options.system_prompt||''}]`。关键：①skills 摘要目录（只放 name+description）作独立段；②每个稳定静态段打 ephemeral breakpoint；③用户动态 system_prompt 放末尾**不 cache**。在 §4.4 / §2.1 ContextAssembler 补此拼接规范。
出处：20-AgentLoop内部机制.md（§二）。

### 【enrichment·medium】§4.4 subagent system_prompt + tool description 也打 cache_control
量化：subagent system_prompt + tool description 加 cache_control，第二次审同仓库 PR 省 80% 输入 token。SubagentManager.spawn() 时自动为子 system_prompt 注入 cache_control；tool description 列表组装 ChatRequest 时作独立静态块打 ephemeral 标记。
出处：23-实战AgentSDK项目.md（§九.3）。

### 【enrichment·medium】§4 tool_choice 四值枚举
ChatRequest.toolChoice 定义为联合类型：`{type:'auto'}`（默认）/`{type:'any'}`（强制调任一）/`{type:'tool',name:'X'}`（强制指定）/`{type:'none'}`（禁工具只输出文本）。用途：结构化抽取用 any、总结阶段用 none、ApprovalGate deny 后切 none。AnthropicProvider 直接透传，OpenAI/Gemini adapter 等价映射。
出处：13-ToolUse实战.md。

### 【enrichment·medium】§4 streaming tool_use 的 input_json_delta 累积
streaming 处理 tool_use：`content_block_start`(type='tool_use') → `content_block_delta`(delta.type='input_json_delta', delta.partial_json 是参数分片字符串)。ProviderEvent.ToolCallArgsDelta 须与 input_json_delta.partial_json 对齐；**累积所有 partial_json 拼接后才 JSON.parse，不能逐片 parse**。
出处：13-ToolUse实战.md。

### 【gap·medium】§4 metadata.user_id 透传用于滥用检测
多用户应用调 `/v1/messages` 时传 `metadata.user_id`，Anthropic 用此做滥用检测归因。ChatRequest 增 `userId?` 可选字段，AnthropicProvider 组装为 `metadata.user_id`（或经 providerOptions 逃生口传入）。
出处：12-AnthropicAPI入门.md。

### 【gap·medium】§4 Anthropic Server Tools（web_search/code_execution）versioned type 格式
ToolDescriptor 增 `serverTool` 可选字段。AnthropicProvider 序列化 tools 时对 serverTool 用带版本的 `type` 而非 name：`{type:'web_search_20250305', name:'web_search'}`、`{type:'code_execution_20250318', name:'code_execution'}`，由 Anthropic 后端执行，ToolExecutorRef 返回空（结果已附在 assistant content）。与自实现 web_search/web_fetch 区分。
出处：13-ToolUse实战.md。

### 【gap·medium】§4 Files API：file_id 跨会话复用
ProviderCapabilities 增 `supportsFileId: boolean`（仅 Anthropic）。CanonMessage 支持 `{type:'document', source:{type:'file', file_id:'...'}}` 引用格式。约束：单文件 ≤32MB；file_id 账户隔离（BYOK 多 key 下 A 的 file_id 对 B 无效）；有 TTL，过期 404。AnthropicProvider 暴露 `uploadFile()/deleteFile()/listFiles()`，DB 记 `files(file_id, filename, size_bytes, uploaded_at, expires_at, key_ref)`。**注意：file_id 引用首次仍按普通 input token 计费，需叠加 `cache_control:{type:'ephemeral'}` 才真正省 token**——ContextAssembler 组装含 file 引用时自动注入 cache_control。
出处：16-FilesAPI与Citations.md。

### 【gap·medium】§4 Citations：后端校验的可信引用
document content block 设 `citations:{enabled:true}` 后，返回 text block 带 `.citations[]`（含 `document_index`/`start_char_index`/`end_char_index`/`cited_text`，位置坐标由 Anthropic 后端真实抽取校验，非 LLM 编造）。AnthropicProvider 响应解析层拆解 citations，AgentEvent 扩展 AssistantText 携带 citations 元数据（或独立 CitationChunk 事件）供 surface 渲染可点击引用。法务/合规 RAG/学术场景。
出处：16-FilesAPI与Citations.md。

### 【gap·medium】§10 Batch API：离线 50% 折扣 + Batch×Cache 叠加
AnthropicProvider 增 `submitBatch()`：`messages.batches.create(requests:[{custom_id, params}])`，最多 10 万请求/批，24h SLA，input+output 均按实时价 50% 计费，状态 `in_progress/canceling/ended`，结果按 custom_id 对齐。**Batch + Cache 叠加约 5% 原价**（cache 命中付 10% × batch 5 折）。§10 用量表增 `batch_jobs(batch_id, status, request_count, result_url, cost_usd)`；§2 主循环区分「实时 turn」与「batch turn」。用于文档批量抽取、历史补标、评估数据集。
出处：18-BatchAPI与成本优化.md。

### 【enrichment·low】§4 模型路由：Haiku/Sonnet/Opus 任务分配比例
成熟生产基准：Haiku 60%（分类/标注/简单抽取）、Sonnet 35%（日常推理/客服/Coding）、Opus 5%（复杂决策/把关）。两阶段路由：入口 Haiku 粗判/抽信息→路由 Sonnet/Opus。recipe frontmatter 增 `routing_hint: 'fast'|'standard'|'complex'`；models.dev catalog 标注每模型推荐任务类型 + contextWindow（Sonnet 4.7 是 1M context，>200K 长上下文走它）。
出处：18-BatchAPI与成本优化.md（§4）、12-AnthropicAPI入门.md。

### 【enrichment·low】§4 Bedrock/Vertex adapter 同接口切换
AWS Bedrock 用 `AnthropicBedrock`（aws_region 参数），GCP Vertex 用 `AnthropicVertex`，接口与直连完全相同，adapter 薄封装即可。可在 Phase 5 / 企业场景 opt-in 加 AnthropicBedrockProvider / AnthropicVertexProvider。
出处：12-AnthropicAPI入门.md。

### 【enrichment·low】§4 output token 比 input 贵约 5 倍
Sonnet input $3/M vs output $15/M，省 output 性价比高 5 倍。turn 循环 `ChatRequest.maxTokens` 按场景设紧缩默认（非全局 8192）；结构化工具引导 JSON 输出；Condenser 摘要 max_tokens 单独配（建议 1024-2048）。
出处：18-BatchAPI与成本优化.md（§5）。

---

## §5 上下文与记忆

### 【enrichment·high】§5.1 compact 后 cache 必失效——纳入 Condenser 决策约束
每次 compact 后 history prefix 变化致之前 cache 全失效，下条消息重新写 cache。`shouldCompact()` 增「距上次 compact 的轮次/时间」guard 条件，防频繁手动 compact 导致 cache miss 费用叠加。ADR-6 补此成本后果说明 + 内置每日 compact 次数监控告警。
出处：22-长任务与Compaction.md（§4.3）。

### 【enrichment·high】§5.1 压缩算法补「cache breakpoint 重置」关键操作
压缩流程：①抽出早期 50%+ messages；②单独发给一个 Claude 写 summary；③用 `{role:user, content:'[历史摘要] '+summary}` 替换；④保留最近 N 条原始；⑤**cache breakpoint 从 summary 之后重新设置**（否则 cache 失效成本飙升）。在 `condense()` 后流程说明明确触发 Provider 层重建 cache prefix。
出处：20-AgentLoop内部机制.md（§五）。

### 【gap·medium】§5.1 /compact 的 hint 参数须传入 Condenser
`condense()` 签名改为 `condense(events, opts?: { hint?: string }): Promise<Event[]>`，把 §11.2 的 `/compact [指令]` hint 插入 Handoff 摘要 prompt，按 hint 重点保留用户最关心内容（不加 hint 默认 summary 可能丢失关键信息）。
出处：22-长任务与Compaction.md（§2.2/踩坑#7）。

### 【enrichment·high】§5.3 auto-memory 两级懒加载（200 行/25KB 索引）
MEMORY.md 是索引（每 session 启动加载前 200 行或 25KB cap）；细粒度 per-topic 文件存索引旁，索引引用时经 read 工具按需拉取；subagent 用独立 `~/.yo-agent/agent-memory/`。保证 per-session token 成本有界，与总 memory 大小无关。
出处：10-Memory与CLAUDE.md、claude-code.md。

### 【enrichment·medium】§5.2 yo.md 质量清单
补「yo.md quality checklist」：①每文件 ≤200 行（超长降 LLM 遵从率）；②写事实不写愿望（「we use Drizzle」非「we plan to migrate to Drizzle」，LLM 无法区分现状与愿景）；③禁 secrets（yo.md 提交 git）；④禁过时信息（陈旧条目比无条目更糟，LLM 当现状）；⑤无临时 TODO（进 issue tracker）；⑥≤500-1000 词（除 32KiB 技术上限外的理解上限）。分 topic 规则放 `.yo-agent/rules/<glob>.md` 懒加载（操作对应路径才注入）。
出处：10-Memory与CLAUDE.md、03-核心工具与权限模型.md（§5）。

### 【enrichment·medium】§5.2 yo.md @import 路径相对于「导入文件位置」非 cwd
@-reference 路径解析须相对**导入文件所在位置**，非 agent cwd——否则子包 yo.md 的 `@../../docs/architecture.md` 在非子包根目录启动时断裂。monorepo 模式：root yo.md 导入共享架构/部署文档，子 app yo.md 加 specifics 并导入 root 文档。§5.2 显式声明此 path-relative 规则（与 §8.3 skill @-reference 共用同一 resolver）。
出处：10-Memory与CLAUDE.md。

### 【gap·low】§5.3 用户主动写 memory 的 `#` / `/remember` 快捷路径
补 user-facing 即时捕获路径：CLI 以 `#` 前缀的消息识别为「写 memory」意图，agent 询问存 user 级还是 project 级；或提供 `/remember <text>` slash 路由到 MEMORY.md。IM 与 CLI surface 均可。
出处：10-Memory与CLAUDE.md。

### 【enrichment·medium】§13 长任务最稳范式：plan 文件 + session 分段 + git checkpoint + subagent 隔离
Anthropic 自家大型 demo 范式：①plan_mode 出 plan 写 `.yo-agent/<task>/plan.md`（目标/阶段/checkpoint 标记）；②每阶段 session 开始 Read plan.md→派 subagent 跑（独立 context）→主 agent 写回进度→commit/push checkpoint；③新 session Read plan.md 续接。规模建议：200K-500K token 还行，500K-1M 通常是任务设计问题应拆，1M+ 不该到。§13 Phase 4 补「长任务 plan 文件约定」，§5.2 增 `.yo-agent/<task>/plan.md` 推荐位置。
出处：22-长任务与Compaction.md（§9）。

---

## §8 插件 / 扩展 / 子 agent / 技能

### 【gap·high】§8.3 Skill 渐进披露：摘要目录每轮注入
补「摘要目录常驻 context」节点：`SkillRegistry.listSummaries()` 被 ContextAssembler 每轮组装调用，将所有已发现 skill 的 `{name, description}` 摘要目录（近零 token）追加到 system prompt 尾；LLM 据此自主决定是否激活，再调 `skill_activate` 拉全文。`skill_activate` 保留为 LLM 驱动 + 用户显式（`/skill <name>`）两种激活的执行路径。
出处：08-Skills技能系统.md。

### 【gap·high】§8.3 SKILL.md description 用 TRIGGER / SKIP 三段模板
description 内部格式（决定 LLM 自动激活精度，「95% 是否正确触发取决于 description」）：①核心场景一句话；②TRIGGER 关键词列表（文件名 pattern、import 名、用户措辞）；③SKIP 条件（防误激活）。§8.3 在 YAML schema 旁补此规范模板（内置 + 用户编写均推荐）。
出处：08-Skills技能系统.md。

### 【correction·high】§8.3 SKILL.md frontmatter `tools?` 是 yo-agent 扩展非 CC 原生
据 claude-code.md（2026-06 官方），CC skill SKILL.md frontmatter **只有 name + description**；工具约束在 subagent/recipe 层（agents/ YAML）定义，skill 只向主 LLM 注入 prompt context，不改可用工具集。处理：(a) 显式标注 `tools?` 为「yo-agent 扩展—CC 无等价」；或(b) 移除 SKILL.md 的 `tools?`，工具约束专归 recipe。**推荐 (a)**（§8.3 已单独设计 recipe，给用户细粒度控制而不强制写完整 recipe）。
出处：08-Skills技能系统.md（vs claude-code.md）。可信度：CC 原生模型以 claude-code.md 为准；是否保留扩展是 yo-agent 设计自由。

### 【gap·medium】§8.3 Skill 目录多文件 @-reference 展开
重型 skill 是目录：SKILL.md 经 `@checklist.md`、`@owasp-top-10.md`、`./scripts/scan-deps.sh` 引用辅助文件。SkillLoader 加载 SKILL.md 全文时须做 @-reference 展开（复用 §5.2 yo.md @import 的同一 resolver）。否则带 checklist 的 code-reviewer、带 OWASP 的 security-auditor 无法工作。
出处：08-Skills技能系统.md。

### 【gap·medium】§8 扩展机制选型反模式决策矩阵
在 §8 补一张决策矩阵（防 plugin 作者错配）：确定性强制动作→Hook（绝不写 skill/memory，LLM 概率系统会 ~5% 跳过）；知识/规范→yo.md 或 skill（绝不写 hook）；LLM 自主行为→skill（非 slash）；独立子任务→subagent。具体反模式：「commit 前跑测试」写 yo.md 失败（应 PreToolUse hook）；「注入分支信息」写 skill 失败（应 UserPromptSubmit hook）；「write 后自动 review」写 slash 失败（应 skill 或 system prompt）。
出处：28-Skill设计模式.md。

### 【gap·medium】§8.3 Skill + subagent 复合模式
SKILL.md body 可指示主 LLM 派 subagent：skill 给「标准方法/步骤清单」（如 pr-review checklist），方法内主 LLM 调 `subagent_spawn` 实际执行（跑 gh pr diff 并行检查各项）。§8.3 注明 SKILL.md body 可把 subagent_spawn 作为工作流步骤引用——skill 提供方法论，subagent 提供执行的 context 隔离。
出处：28-Skill设计模式.md。

### 【enrichment·high】§8.3 子 agent / recipe frontmatter 完整字段集（含 description 最关键）
`.yo-agent/agents/xxx.md`（或 recipe YAML）frontmatter：`name`（主 agent 调用的 subagent_type 值）、**`description`（「什么时候用我」，写好决定主 agent 是否调到它，最关键）**、`tools`（白名单，支持参数级 `Bash(gh pr diff:*)`）、`disallowedTools`（黑名单，与 tools 都设时黑名单优先）、`model`（独立绑定）、`permissionMode`、`isolation`、`memory`、`maxTurns`、`parameters`。DESIGN 现缺 `description`/`disallowedTools`/`isolation`/`memory`/`maxTurns`。
出处：07-Subagents子代理.md（§3）、21-自定义Tool与Subagent.md、claude-code.md（§8）。

### 【enrichment·medium】§8.3 project-level skills 是一等团队协作特性
`.yo-agent/skills/*/SKILL.md`（项目级，提交 git）自动全队共享——新成员 clone 即让 agent 遵循团队约定，无需 onboarding。同名冲突项目级胜（同 yo.md 层级优先）。团队 coding style、PR 模板、部署流程、安全 checklist 都可编码为 project skill。§8.3 把它作为一等协作特性记录。
出处：08-Skills技能系统.md。

### 【enrichment·low】§8.3 skill 审计 / 剪枝生命周期
skill 泛滥（30+ 描述重叠）使激活非确定（模型随机挑）。SkillRegistry 暴露 `listActive()` 映射 `/skills` slash；§8.3 记「skill audit」实践（定期合并/删重叠）；注册时检测并警告与内置 skill 同名冲突（plugin 第三方 skill 尤需）。
出处：08-Skills技能系统.md。

### 【enrichment·low】§8.3 skill 跨 surface 复用
同一 SKILL.md（如 `~/.yo-agent/skills/pr-review/`）既能在 CI 经 Agent SDK 程序化 `skill_activate` 调用，又能在 CLI 经 `/skill <name>` slash 触发。§8.3 注明 surface 无关是 skill 复用核心价值。
出处：23-实战AgentSDK项目.md（§九.2）。

### 【enrichment·low】§8.1 插件包可分发 subagents + skills + hooks + MCP + yo.md 片段
`.yo-agent/plugins/` 插件包同时打包 skills/hooks/subagents/MCP/yo.md 片段，经 `/plugin install <name>@<marketplace>` 安装。`Plugin` 接口加 `registerRecipes?(reg: RecipeRegistry)`，或加载时扫描 plugin 目录下 `recipes/` 和 `agents/` 子目录。
出处：07-Subagents子代理.md（claude-code.md §8）。

### 【enrichment·medium】§8.2 Router / Orchestrator-Worker 模式显式建模
补 Router 模式：主 agent 当 router（轻量 Haiku 分类）按任务类型分派给 explore/review/coder 专门 subagent worker。仅在「角色差距大 / 工具集差异明显 / Router 判断标准明确」时引入多 agent（单 Agent + 好工具是 90% 场景正确选择）。
出处：29-Agent设计模式.md（§3.4）。

---

## §9 安全

### 【enrichment·medium】§9.2 permission callback 是 async、可查 RBAC/风控（SaaS 最后防线）
ConfirmationPolicy 的 `decide()` 是 async，允许 IO（查 RBAC、风控、数据库），返回 `{behavior:'deny'|'allow'|'ask_user', message?}`，比静态 matcher 灵活，是 SaaS 多用户场景核心扩展点。样例：`async decide(call, ctx): Promise<...> { await rbac.check(ctx.user, call.toolName) }`。
出处：20-AgentLoop内部机制.md（§四）、30-生产化与团队协作.md。

### 【enrichment·medium】§9.2 per-session 有状态调用计数限制
ApprovalGate / HookContext 增 per-session metadata 存储，允许 hook/callback 声明 `maxCallsPerSession: { [toolName]: number }` 这类有状态限制（如 `leave_review_comment` 只能调一次，调过返回 deny + 说明），比无状态 deny list 灵活。
出处：23-实战AgentSDK项目.md（§四）。

### 【enrichment·medium】§9.2 permission mode 枚举扩展
现 read-only/supervised/autonomous 三档扩为：`'read-only'`(=plan)/`'supervised'`(=default)/`'accept-edits'`(自动批准文件写、Shell 仍手动)/`'autonomous'`(=auto，内部策略引擎)/`'ci'`(=dontAsk，未在 allow 的操作直接拒绝而非 prompt)/`'bypass'`(仅容器)。Shift+Tab 在 supervised→accept-edits→read-only 三档循环。`auto`（本地分类器）作 Phase N 预留。CI 模式给明确枚举名 `ci` 便于 config/RPC 引用。
出处：03-核心工具与权限模型.md（§5）、claude-code.md（§5）。

### 【enrichment·medium】§9.4 Protected Paths 枚举 + allow 规则不可覆盖
硬编码 Protected Paths：`.git`、`.yo-agent/`、`~/.yo-agent/`、`.yo-agent/mcp.json`、provider key 引用文件、`yo.md`、`.ssh/`、`*.pem`/`*.key`，以及 shell rc(.bashrc/.zshrc)、.gitconfig、.npmrc。default/accept-edits/read-only 模式下写操作强制弹审批，**任何 allow 规则不能覆盖**（仅 bypass 模式失效，与 CC 一致）。
出处：03-核心工具与权限模型.md（§6）。

### 【enrichment·medium】§9.4 SSRF hostname 白名单防护
fetch 类工具（web_fetch、MCP 暴露的 fetch）增 `allowedDomains`/`blockedDomains` 配置；默认 blocklist 含 `169.254.0.0/16`（AWS metadata）、localhost、`10.0.0.0/8` 等内网地址（防 SSRF 打内网）。配套注入过滤：query >200 字符拒绝 + SQL 注入特征字符（`;`/`--`/`/*`）检测。
出处：26-MCP安全与远程化.md（§8）。

### 【gap·medium】§9 McpServerSurface 外部调用经统一 audit 路径
McpServerSurface 接受的外部 tool 调用同样经 ToolExecutor 路径，继承相同 audit log（session_id 用外部宿主 session context 注入），经 EventLog + OTel。审计字段全集 `{user, tool, args, timestamp, session_id}`，写 immutable storage（S3 + object lock 合规），推中央 ELK/Loki/Datadog，异常高频调危险 tool 报警。§10 明确 MCP server 模式 audit 覆盖范围。
出处：26-MCP安全与远程化.md（§9）。

### 【gap·medium】§9.5 工具输出 PII 脱敏（PostToolUse OutputSanitizer hook）
ToolCallOutput 注入上下文前加 OutputSanitizer（经 PostToolUse hook 实现），允许用户注册脱敏规则——server/工具结果返回前 mask PII（姓名/邮箱/电话/身份证），防完整 PII 进 LLM 上下文（进而进 Anthropic 训练流程）。企业部署硬需求。
出处：26-MCP安全与远程化.md（§10）。

### 【gap·medium】§9 McpServerSurface 6 层安全栈映射 + mTLS 内网选项
映射 6 层（任一缺失整体归零）：网络边界（VPN-only/公网+强鉴权/混合分级）→传输层（mTLS/HTTPS）→鉴权层（OAuth/Bearer/mTLS cert）→授权层（scope/RBAC）→应用层（tool 内 dry_run/confirm）→审计层。补 mTLS 内网选项（内网无 mTLS 横向移动后任意服务可访问）：HTTPS + mTLS 可选，VPN-only 内网不强制 OAuth 时的兜底。
出处：26-MCP安全与远程化.md（§1/§12）。

### 【gap·low】§3.3 MCP OAuth token 生命周期 + 时间窗口 scope
MCP host 端 OAuth token 短 TTL（access 1h / refresh 30d）。time-windowed scope：`deploy:prod:1h-only` 当次审批、1h 后失效。McpServerSurface 若实现 OAuth，scope 支持时间窗口粒度。
出处：26-MCP安全与远程化.md（§4.3）。

---

## §10 持久化与可观测性

### 【gap·medium】§10.3 补 compact 频率 + cache 命中率核心 metric 与告警
增 OTel gauge/counter：`yo_agent.compact.frequency`（每会话/每用户每天）、`yo_agent.cache.hit_rate`（= cache_read /(cache_read+cache_creation+input)，target >70%~80%，低于报警）、`yo_agent.compact.token_reduction_rate`。其他告警：日成本 >平时 3x、单用户单天 >X、模型分布(Haiku/Sonnet/Opus 占比)。CLI `--show-cost` 增 cache 命中率实时显示。§13 各 phase 退出标准加「核心 metric 告警跑通」。
出处：22-长任务与Compaction.md（§8）、14-PromptCaching.md（踩坑#10）、18-BatchAPI与成本优化.md、30-生产化与团队协作.md。

### 【enrichment·medium】§10 usage 表 / OTel span 补维度
usage 表或 OTel span attributes 增：`cache_creation_tokens INTEGER`、`thinking_tokens INTEGER`、`task_type TEXT`（模型路由分析）、`is_batch BOOLEAN`。
出处：18-BatchAPI与成本优化.md（§8）。

---

## §11 配置 / slash / hooks

### 【gap·high】§11.3 Hook 事件集补关键缺失（现 13-14 个，实际 30 个）
HookEvent 枚举设计为可扩展 union（非写死），优先补对 yo-agent 有明确价值的：`PostToolBatch`（一批并行 tool 全部完成后一次性 hook，开销低于逐个 PostToolUse）、`StopFailure`（区分正常 Stop 与异常终止）、`PermissionRequest`（policy 层决定前触发，可外挂分类器，与 ApprovalRequest 分工需明确）、`UserPromptExpansion`（slash 渲染/@file 插入后，与 UserPromptSubmit 是不同阶段）、`InstructionsLoaded`（yo.md 加载后可检验/改写）、`FileChanged`（写操作完成后通知，触发 git/lint）、`WorktreeCreate`/`WorktreeRemove`、`TaskCreated`/`TaskCompleted`、`McpElicitation`（归一 Elicitation+ElicitationResult，外部 server 请求 user 补充信息时触发，转为 ApprovalRequested 类阻塞门）。在 §11.3 加「已收录/暂缓/永不收录」三列决策表，说明取舍理由。
出处：05-Hooks钩子系统.md、07-Subagents子代理.md、28-Skill设计模式.md、claude-code.md（§6）。

### 【gap·high】§11.3 Hook stdio JSON 协议定义
command 类型 hook 协议须明确：stdin 固定字段 `{session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input}`，PostToolUse 加 `tool_response`，UserPromptSubmit 加 `prompt`，Stop 加 `stop_hook_active`；exit code 三义：0=通过(stdout 进 transcript)、2=阻断(stderr 回灌 LLM)、其他非零=报错不阻断；JSON 输出控制字段：`decision`(block/allow)、`reason`(回灌 LLM 理由)、`continue`(bool)、`stopReason`、`suppressOutput`(bool)。HookHandler 现仅 `decision:'allow'|'deny'|'modify'`，**缺 reason/suppressOutput + exit-code 约定**。
出处：05-Hooks钩子系统.md（§4）。

### 【gap·high】§11.3 Hook 实现类型补协议描述 + `prompt`/`agent` 两种
对每种实现类型给一行协议：`command`（shell，stdio 协议见上）、`http`（POST JSON，等效 stdin 字段 + 期望 response 结构）、`mcp_tool`（传 tool_name+args，结果映射 decision）、`inline`（Node 函数）。补两种：`prompt`（hook 结果作为 prompt 追加给 LLM 继续推理）、`agent`（spawn 子 agent 处理，以 subagent_spawn 实现，对长时异步 hook 有用）。
出处：05-Hooks钩子系统.md、claude-code.md（§6）。

### 【gap·medium】§11.1 / §11.3 配置跨层合并语义（hook 叠加、deny 优先、其他覆盖）
明确：(1) **hooks 跨层叠加执行**（所有匹配层的 hook 都跑，非后层覆盖前层——全局个人 lint hook + 项目团队 guard hook 都生效）；(2) **deny 规则跨层取并集**（任意层 deny 即拒绝，不可被上层 allow 覆盖）；(3) 其他配置项（model/permissionMode）上层覆盖下层（project > global）。本机临时调试配置放 `.yo-agent/config.local.toml` 并 gitignore。
出处：05-Hooks钩子系统.md（§8）、02-安装配置与settings.md（§4.4）、30-生产化与团队协作.md（§2）。

### 【enrichment·medium】§11.1 补 enterprise/managed 配置层 + 五层优先级
补第五层 managed/enterprise policy（`/etc/yo-agent/managed-settings.json` 或 macOS `/Library/Application Support/...`，公司合规强制下发，个人不可覆盖）。优先级：enterprise > user > project > local > CLI flag。企业/团队部署需。
出处：02-安装配置与settings.md（§2）。

### 【enrichment·medium】§11.1 env 字段环境变量枚举 + config 键预留
config.toml 预留对应键（经 config 注入子进程，比 shell export 干净）：`kernel.bashTimeoutMs`(BASH_DEFAULT_TIMEOUT_MS，默认 2 分钟)、`kernel.bashMaxTimeoutMs`(BASH_MAX_TIMEOUT_MS)、`kernel.maxThinkingTokens`(MAX_THINKING_TOKENS，对应 reasoning budget)、`obs.telemetry`(DISABLE_TELEMETRY)。
出处：02-安装配置与settings.md（§6.1）。

### 【enrichment·medium】§11.1 / §9.1 apiKeyHelper 脚本化密钥获取
增 `provider.keyHelper` 字段（指向可执行脚本，stdout 为 API key，每次调用运行获取当前有效 key，支持自动轮换无需重启进程），接 AWS Secrets Manager / Vault / 1Password CLI / pass。比 OS keychain(keytar) 默认值更适合企业部署。
出处：02-安装配置与settings.md（§4.8）。

### 【gap·medium】§11.2 Slash command frontmatter 字段建模
定义 slash 文件结构（SKILL.md 风格 frontmatter）：`description`(/help 显示)、`argument-hint`(补全提示)、`allowed-tools`(执行期覆盖全局 permission 的工具白名单，安全隔离关键——IM 端 `/allow_once`/`/deny` slash 应锁死只能操作 approval)、`model`(slash 专属模型)、`disable-model-invocation`(禁 LLM 自动调用只许用户手动)。
出处：04-SlashCommands.md（§3）。

### 【gap·medium】§11.2 slash 发现路径 + 命名空间 + 动态语法 + IM 安全
- 文件约定：`~/.yo-agent/commands/<name>.md`(用户级)/`.yo-agent/commands/<name>.md`(项目级)；子目录形成命名空间前缀（`git/review.md`→`/git:review`）；同名项目级覆盖用户级。
- 动态语法：`` !`cmd` ``（跑命令把 stdout 替进 prompt）、`@path/to/file`（文件内联），均受 allowed-tools 约束。LLM 经 `SlashCommand` 工具可主动调 slash（`disable-model-invocation:true` 禁）。
- **IM 安全接缝**：IM Surface 的 slash 禁用 `!` 或强制 allowed-tools 锁死（注入风险）；`@` 文件包含需路径白名单。IM 平台 `/` 可能与平台指令冲突，可配 `!`/`#` 替代触发符。
出处：04-SlashCommands.md（§2/§5/§8）。

### 【gap·low】§7 / §10.3 statusline 脚本协议
定义 `StatuslineContext` JSON（stdin）：`{session_id, model, cwd, transcript_path, version, output_style}`，脚本 echo 字符串到 stdout 渲染到底部。适用 CliSurface 底部状态栏 + AcpSurface（Zed/JetBrains 状态指示）。保持与 CC 生态兼容。
出处：11-IDE集成与statusline.md（§5）。

### 【enrichment·low】§7 AcpSurface selection→context 注入 + diff 渲染
§7.2 AcpSurface 补：IDE 经 ACP 推 `@selection` context（类似 submitInput 携带 attachment）；diff 渲染复用现有 `FileChanged` AgentEvent + `ApprovalRequested` 事件（对应 IDE accept/reject diff 按钮），无需新增事件类型，但需说明映射。`/ide` 命令在 VSCode 终端启动时自动检测连接。
出处：11-IDE集成与statusline.md（§3）。

---

## §8.3 / §13 评测与生产门

### 【gap·medium】§8.3 / §13 skill/recipe 配套 evals 目录 + CI 评测门
增 `.yo-agent/evals/<skill-name>/case-N.md` 目录约定。改 prompt/model/tool 前后跑 evals（「改 prompt 不跑 evals = 凭感觉迭代」），PR 描述说明 Before/After 行为差异 + 评测结果（如激活率 80%→35%）。关键 metrics：任务成功率 + 平均 token + 平均延迟（可轻量：JSONL test cases + headless 模式跑）。§13 Phase 4/5 退出标准加「关键 skill 有 evals 集且 CI 通过」。
出处：30-生产化与团队协作.md（§3.3）、29-Agent设计模式.md（§6.5）。

### 【gap·medium】§2.4 / §3.4 / §9.2 / §10 生产上线 checklist 作 Phase 退出门
补四条作 Phase 4 退出标准：(1) §2.4 明确 **4xx 不重试、5xx 指数退避**（现仅「5xx/network/timeout 退避重试」）；(2) §3.4 写 tool 加前置 **dry_run + confirm**（现 L3 checkpoint 是事后回滚，缺前置 dry_run）；(3) §9.2 增 **per-user/per-day 配额**（现仅 per-turn token 预算）；(4) §10 增 **PII 脱敏 + 审计**说明。
出处：30-生产化与团队协作.md（§九）。

### 【enrichment·low】§4.4 同模型跨部署商 fallback 路径
§4.4 fallback 链补「同一模型跨部署商 fallback」（Anthropic 直连 vs Bedrock vs Vertex 是不同 adapter，需显式配置 fallback 链）。优雅降级序：Anthropic 直连挂→同模型 Bedrock/Vertex→降级模型(Opus 挂用 Sonnet)→模板回复/人工。§13 风险缓解表增「Anthropic 直连 outage」一行。
出处：30-生产化与团队协作.md（§七）。

### 【gap·medium】§3.2 todo_write 持久化路径（跨 session 恢复）
todo_write ToolDescriptor 增 `persistPath` 选项（默认 `.yo-agent/todos.json`），状态持久化到磁盘，新 session 启动时 todo 自动恢复（LLM 看到「上次还有 X 没做」）。§5 补 todo 持久化作第三种轻量 checkpoint 模式（A 文件型 / B todo 持久化 / C session resumption）。
出处：22-长任务与Compaction.md（§5.2）。

---

## §8.3 / §9.2 Plan Mode（跨章节）

### 【gap·high】§8.3 / §3.2 / §9.2 / §11.3 Plan Mode 作内核可选机制显式设计
- §3.2 内置工具补 `EnterPlanMode`/`ExitPlanMode`（LLM 主动经 EnterPlanMode 进入，yo.md 可配条件）。
- §9.2 plan 权限模式下工具级约束：进入后只读 Bash（git status/ls/cat）放行，Edit/Write/NotebookEdit 全禁，有副作用 Bash 禁（经 ToolDescriptor.availability 或 PolicyEngine 强制）。
- 退出靠 `ExitPlanMode` 触发 ApprovalGate 用户审批（approve→执行、reject→留 plan mode）。
- §11.3 加 EnterPlanMode/ExitPlanMode hook 事件。
出处：09-Plan-Mode.md。

---

## correction（需核实的冲突点）

> 以下为笔记与设计/各来源之间的冲突或需澄清点，标明哪边更可信。

### C1. Compaction 触发阈值：80% vs 85% vs 95% vs 60%（高优先）
- DESIGN §5.1：`used >= 80% usable`（横向共识）。
- 笔记 20/22：「~85%」「75-85%」（SDK/框架层观察，写于 2026-05，略早）。
- claude-code.md（2026-06 官方核查）：「约 95% 自动触发，手动建议 60%」。
- **结论（不矛盾，对应不同层/路径）**：95% 是 Claude Code CLI 产品层真实自动触发点（含大量 overhead）；80-85% 是 SDK/框架层保守触发（留缓冲给工具结果注入）；60% 是给 CLI 用户的**手动**最佳时机建议。
- **建议落地**：DESIGN 用「可配阈值，默认 0.80，可调至 0.85」（框架级保守合理，IM 上下文短可更激进），`condenser.thresholdRatio` 暴露为 config；同时区分两条路径——自动触发(默认 80%) vs `/compact` 手动(help text 写「建议 60-70%」)；保留 95% 作「紧急兜底（至少此前必须完成压缩）」。**不必改为 95%**——claude-code.md 时间最新但描述的是不同行为，非纠错。

### C2. effort 轴 → output_config（高优先，以笔记为准）
- DESIGN §4.2：「4.7/4.8/Fable 拒绝 temperature/top_p，用 `output_config.effort` + adaptive thinking」。
- 笔记 12/15：Messages API 中 temperature 仍是标准字段；thinking 是独立 `{type:'enabled', budget_tokens:N}` 结构；**无 `output_config` 原生字段**。
- **结论（以笔记为准，更接近 API 现实）**：`output_config.effort` 更像 yo-aichat 归一层自定义抽象，非 Anthropic 原生字段。effort 轴本身设计正确，但 AnthropicProvider 的**翻译逻辑需明确为 `effort → thinking.budget_tokens`**（如 high=16K、max=32K），而非透传不存在的原生 `output_config`。请核实 yo-aichat 归一层实际字段名后修正 §4.2 措辞。
- **⚠️ 2026-06 claude-api skill 权威核查 —— 本条 C2 已被推翻**：`output_config.effort`（`low|medium|high|xhigh|max`）**是 Anthropic 原生 GA 字段**（无 beta header，默认 `high`，`xhigh` 为 Claude Code 默认）；反而 `thinking.budget_tokens` 在 Opus 4.7/4.8/Fable 上**已移除（发送即 400）**，仅 Sonnet 4.5 及更早旧模型使用，4.6/Sonnet 4.6 上 deprecated。结论翻转：**DESIGN §4.2 的 `output_config.effort` 写法正确，应保留**；AnthropicProvider 的 effort 翻译走 `output_config.effort`，不要改成 budget_tokens。本笔记写于 2026-05、早于 effort 参数 GA，故结论过时。详见 DESIGN §15.4 / §15.10-C2。

### C3. 内置 subagent 数量：3 vs 4 vs 5（低优先，以 claude-code.md 为准）
- 笔记 07：列 4 个（Explore/Plan/general-purpose/statusline-setup）。
- claude-code.md（2026-06 官方核查）：**5 个**——Explore(Haiku，跳过 CLAUDE.md)、Plan(继承主会话模型)、general-purpose(全工具)、statusline-setup(Sonnet)、claude-code-guide(Haiku)。
- **结论**：以 claude-code.md 为准（时间最新）。yo-agent recipes 默认值设计可参考默认模型选择（Explore 用 Haiku 而非 Sonnet）。

### C4. WebSocket 传输不支持 OAuth（中优先，以 claude-code.md 为准）
- DESIGN §3.3：「SSE 已 deprecated，仅兼容旧服务器」（已对齐）。
- claude-code.md（§3）：4 种传输 stdio/http/sse(废弃)/ws，**ws 明确不支持 OAuth**（只支持静态 header 认证）。笔记 26 未明确区分 ws vs http。
- **结论（以 claude-code.md 为准，更精确）**：补约束——MCP host 选 WebSocket transport 时鉴权退化为静态 Bearer header，无法 OAuth token 刷新，生产推荐 Streamable HTTP。若 MCP server 配了 OAuth，必须用 streamable HTTP 而非 WebSocket。

### C5. permissionMode 在 auto 模式下被忽略（中优先）
- claude-code.md（§8）：子 agent 的 `permissionMode` 在 auto 模式下被忽略，统一由服务端分类器管控。
- **结论**：yo-agent 无 Anthropic 服务端分类器，但 §2.5 `deriveSubagentPolicy`（「只收紧不放宽」）应明确处理：父 session permissionMode 为 `'autonomous'`/`auto` 时，子 agent 自声明 permissionMode 是否被尊重的优先级规则。建议显式定义而非留空。

### C6. yo.md 软约束与 §9.5 缺交叉引用（中优先，coherence gap 非错误）
- DESIGN §5.2 正确写 yo.md 为软约束（user 消息注入），§9.5 正确描述软/硬分层，但两处无交叉引用。
- **结论**：非错误，是连贯性缺口。建议 §5.2 软约束说明后加「（见 §9.5：硬约束须写 PreToolUse hook 代码、非 yo.md，才能抗注入）」；§9.5 反向指回 §5.2。开放 IM 频道的群级 yo.md 尤其易被注入，此交叉引用重要。
