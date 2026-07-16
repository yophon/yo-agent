# yo-agent

[English](README.en.md) | 中文

通用 Agent Runtime，使用 TypeScript 构建。同一个内核可以运行在终端、远程 RPC、MCP、ACP 和浏览器中。

它提供完整的 agent loop、工具调用、审批、上下文压缩、会话恢复、MCP、子 agent 和扩展机制。当前仓库是源码工作区，所有包均为私有包，尚未发布到 npm。

## 能力

- 多模型：Anthropic、OpenAI Responses、OpenAI-compatible、Gemini
- 编程工具：文件读写、搜索、编辑、patch、shell、todo
- 交互终端：多轮对话、流式输出、审批、会话恢复、任务查看
- 持久化：内存、SQLite、IndexedDB；事件流支持回放和断线续接
- 工具生态：MCP host、MCP server、可信扩展、隔离插件
- 集成接口：JSON-RPC、WebSocket、ACP、浏览器内嵌 API
- 运行保护：权限模式、风险判断、工具超时、循环熔断、checkpoint

## 快速开始

要求：Node.js 22.5+、pnpm 10。Node 20 可以运行大部分功能，但不支持内置的 `node:sqlite` 持久化。

```bash
pnpm install
pnpm run install:cli
```

配置一个模型：

```bash
export ANTHROPIC_API_KEY=sk-...
# 或
export OPENAI_API_KEY=sk-...
# 或
export GEMINI_API_KEY=...
```

启动交互终端：

```bash
yoagent --tui
```

未安装全局命令时，可以从工作区直接运行：

```bash
pnpm --filter @yo-agent/cli start -- --tui
```

没有配置 API key 时会使用 `FakeProvider`，只用于验证安装和界面。

## CLI

```bash
# 交互式多轮会话
yoagent --tui
yoagent --tui -p "检查这个项目"

# 单次执行
yoagent -p "解释 src/main.ts"

# JSONL 事件流
yoagent --mode jsonl -p "运行测试并总结结果"

# 恢复会话，需要配置 YO_DB
yoagent --continue
yoagent --resume
yoagent --resume <session-id>

# 远程协议
yoagent rpc
yoagent rpc --listen 8799
yoagent mcp-server
yoagent acp
```

TUI 内使用 `/help` 查看命令。常用命令包括 `/model`、`/cwd`、`/resume`、`/compact` 和 `/tasks`。

## 配置

CLI 会读取当前进程环境变量。通过全局 `yoagent` 启动时，还会加载 `~/.config/yo-agent/config.env`；Shell 中显式设置的变量优先。源码态 pnpm 命令不会自动加载这个文件。

| 变量 | 作用 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 使用 Anthropic |
| `OPENAI_API_KEY` | 使用 OpenAI 或兼容接口 |
| `OPENAI_BASE_URL` | 自定义 OpenAI-compatible 地址 |
| `OPENAI_MODE=responses` | 使用 OpenAI Responses API |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | 使用 Gemini |
| `YO_MODEL` | 覆盖默认模型 |
| `YO_DB` | SQLite 会话数据库路径 |
| `YO_COMPACT=1` | 启用上下文压缩 |
| `YO_COMPACT_MODEL` | 指定压缩摘要模型 |
| `YO_CHECKPOINT=1` | 编辑后创建 shadow-git checkpoint |
| `YO_LOOP_BREAKER` | `off`、`loose` 或 `strict`，默认 `loose` |
| `YO_TOOL_SHIM=1` | 为不支持原生工具调用的兼容模型启用 prompt shim |
| `YO_HISTORY` | TUI 输入历史路径；空字符串表示关闭 |
| `YO_TRUSTED_KEYS` | RPC WebSocket 允许的设备公钥列表 |
| `YO_CONFIG` | 覆盖全局启动器读取的配置文件路径 |

示例：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://gateway.example.com/v1
YO_MODEL=gpt-4o
YO_DB=~/.local/share/yo-agent/sessions.db
YO_COMPACT=1
```

## 项目上下文

yo-agent 会从当前目录向工作区根目录加载 `yo.md` 和 `AGENTS.md`，作为项目约定注入 system prompt。

长期记忆存放在工作区的 `MEMORY.md`：

```bash
yoagent -p "#remember 本项目使用 pnpm，不使用 npm"
```

技能与子 agent 配置目录：

```text
~/.yo-agent/skills/                 # 全局 skills
<workspace>/.yo-agent/skills/       # 项目 skills
~/.yo-agent/agents/                 # 全局 agent recipes
<workspace>/.yo-agent/agents/       # 项目 agent recipes
```

## Web

启动官方 Web 控制台：

```bash
pnpm --filter @yo-agent/web-console dev
```

默认地址为 `http://localhost:5178`。控制台支持多 agent 配置、流式聊天、工具审批和 IndexedDB 会话恢复。

运行浏览器内嵌示例：

```bash
UPSTREAM_KEY=sk-... pnpm --filter @yo-agent/demo-backend start
pnpm --filter @yo-agent/web-demo dev
```

默认后端地址为 `http://localhost:8788`，Web demo 为 `http://localhost:5177`。可用 `UPSTREAM_BASE` 配置 Anthropic 或 OpenAI-compatible 上游地址，也可以用 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 代替 `UPSTREAM_KEY`。

## 扩展

可信扩展可以注册工具、命令、system prompt 段和生命周期 hook：

```bash
mkdir -p ~/.yo-agent/extensions
cp examples/extensions/word-count.ts ~/.yo-agent/extensions/
yoagent --tui
```

项目扩展放在 `<workspace>/.yo-agent/extensions/`，首次交互加载时需要确认信任。扩展在主进程中执行，拥有当前用户的完整权限；不可信代码应使用 `plugin-host`，不要作为可信扩展加载。

## 架构

```text
packages/protocol        事件、RPC 和运行时 schema
packages/provider        模型适配与模型目录
packages/tools           工具注册、内置工具和执行后端
packages/store           EventLog、SQLite、IndexedDB、checkpoint
packages/kernel          agent loop、审批、压缩、子 agent、策略
packages/surface-cli     headless、JSONL 和 TUI
packages/surface-rpc     JSON-RPC over stdio/WebSocket
packages/surface-mcp     MCP server 与 MCP host
packages/surface-acp     ACP 接入
packages/surface-web     浏览器 Agent API 和 ChatController
packages/plugin-host     Worker 隔离插件
packages/extension-host  进程内可信扩展
apps/yo-agent            CLI 组合入口
apps/web-console         Vue Web 控制台
apps/web-demo            浏览器内嵌示例
```

核心数据模型是 append-only `EventLog`。`AgentKernel` 是事件的唯一写入方，各 surface 只消费内核接口和事件流，因此会话可以被持久化、回放和远程续接。

更完整的设计决策见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 开发

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check
pnpm run test:coverage
```

`pnpm run check` 依次执行类型检查、lint、schema 生成、浏览器打包检查和全部测试。

## 安全边界

- 默认 shell 后端只是进程级 L1 防护：会剥离 API key 等环境变量并在中断时清理进程组，但仍可访问本机文件系统和网络。
- `bypass` 权限模式会跳过审批，只应在明确受信任的环境使用。
- WebSocket RPC 会监听 `0.0.0.0`，应放在 Tailscale、WireGuard 或其他可信网络后面。
- 浏览器端审批不是服务端授权。业务工具 API 必须独立校验用户身份和权限。
- 可信扩展等同于执行本地代码；项目内容更新后不会按文件 hash 重新确认。

## 当前限制

- 仓库包仍是源码态私有包，没有稳定 npm 发布和 API 兼容承诺。
- EventLog 已保留 `parentId`，但会话 DAG、fork 和 tree UI 尚未完整实现。
- 容器级执行隔离、完整可观测性和多用户授权仍在规划中。
