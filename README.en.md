# yo-agent

English | [中文](README.md)

A general-purpose Agent Runtime built with TypeScript. The same kernel can run in a terminal, over remote RPC, through MCP or ACP, and in the browser.

It provides a complete agent loop, tool calling, approvals, context compaction, session recovery, MCP integration, subagents, and extensions. This repository is currently a source workspace: all packages are private and have not been published to npm.

## Features

- Multiple providers: Anthropic, OpenAI Responses, OpenAI-compatible APIs, and Gemini
- Coding tools: file access, search, editing, patches, shell commands, and todos
- Interactive terminal: multi-turn conversations, streaming output, approvals, session recovery, and task inspection
- Persistence: in-memory, SQLite, and IndexedDB stores with event replay, reconnect, and session forking
- Tool ecosystem: MCP host, MCP server, trusted extensions, and isolated plugins
- Integration surfaces: JSON-RPC, WebSocket, ACP, an embeddable browser API, and WeChat bots (iLink)
- Runtime safeguards: permission modes, risk assessment, tool timeouts, loop detection, and checkpoints

## Quick Start

Requirements: Node.js 22.5+ and pnpm 10. Node 20 can run most features, but does not support the built-in `node:sqlite` persistence layer.

```bash
pnpm install
pnpm run install:cli
```

Configure a model provider:

```bash
export ANTHROPIC_API_KEY=sk-...
# or
export OPENAI_API_KEY=sk-...
# or
export GEMINI_API_KEY=...
```

Start the interactive terminal:

```bash
yoagent --tui
```

To run directly from the workspace without installing the global command:

```bash
pnpm --filter @yo-agent/cli start -- --tui
```

Without an API key, yo-agent uses `FakeProvider`, which is only intended to verify the installation and UI.

## CLI

```bash
# Interactive multi-turn session
yoagent --tui
yoagent --tui -p "Inspect this project"

# One-shot execution
yoagent -p "Explain src/main.ts"

# JSONL event stream
yoagent --mode jsonl -p "Run the tests and summarize the results"

# Resume a session; requires YO_DB
yoagent --continue
yoagent --resume
yoagent --resume <session-id>

# Remote protocols
yoagent rpc
yoagent rpc --listen 8799
yoagent mcp-server
yoagent acp

# WeChat integration (official iLink Bot protocol)
yoagent weixin login                          # QR-code login
yoagent weixin run                            # resident send/receive loop (YO_DB recommended)
yoagent weixin allow <accountId> <userId>     # authorize a sender
```

Use `/help` inside the TUI to list available commands. Common commands include `/model`, `/cwd`, `/resume`, `/compact`, `/tasks`, `/fork`, and `/tree`.

## Configuration

The CLI reads environment variables from the current process. When launched through the global `yoagent` command, it also loads `~/.config/yo-agent/config.env`; explicitly exported shell variables take precedence. Workspace `pnpm` commands do not load this file automatically.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Use Anthropic |
| `OPENAI_API_KEY` | Use OpenAI or an OpenAI-compatible API |
| `OPENAI_BASE_URL` | Set a custom OpenAI-compatible endpoint |
| `OPENAI_MODE=responses` | Use the OpenAI Responses API |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Use Gemini |
| `YO_MODEL` | Override the default model |
| `YO_DB` | Set the SQLite session database path |
| `YO_COMPACT=1` | Enable context compaction |
| `YO_COMPACT_MODEL` | Select the model used for compaction summaries |
| `YO_CHECKPOINT=1` | Create a shadow-git checkpoint after edits |
| `YO_LOOP_BREAKER` | Set loop detection to `off`, `loose`, or `strict`; defaults to `loose` |
| `YO_TOOL_SHIM=1` | Enable the prompt shim for compatible models without native tool calling |
| `YO_HISTORY` | Set the TUI input history path; an empty string disables history |
| `YO_TRUSTED_KEYS` | Set the list of device public keys allowed to use WebSocket RPC |
| `YO_CONFIG` | Override the config file loaded by the global launcher |

Example:

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://gateway.example.com/v1
YO_MODEL=gpt-4o
YO_DB=~/.local/share/yo-agent/sessions.db
YO_COMPACT=1
```

## Project Context

yo-agent searches from the current directory up to the workspace root for `yo.md` and `AGENTS.md`, then injects those project conventions into the system prompt.

Long-term memory is stored in the workspace's `MEMORY.md`:

```bash
yoagent -p "#remember This project uses pnpm, not npm"
```

Skill and subagent configuration directories:

```text
~/.yo-agent/skills/                 # Global skills
<workspace>/.yo-agent/skills/       # Project skills
~/.yo-agent/agents/                 # Global agent recipes
<workspace>/.yo-agent/agents/       # Project agent recipes
```

## Web

Start the official web console:

```bash
pnpm --filter @yo-agent/web-console dev
```

The default URL is `http://localhost:5178`. The console supports multiple agent configurations, streaming chat, tool approvals, and IndexedDB-backed session recovery.

Run the embeddable browser demo:

```bash
UPSTREAM_KEY=sk-... pnpm --filter @yo-agent/demo-backend start
pnpm --filter @yo-agent/web-demo dev
```

The backend defaults to `http://localhost:8788`, and the web demo to `http://localhost:5177`. Use `UPSTREAM_BASE` to configure an Anthropic or OpenAI-compatible upstream endpoint. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` can be used instead of `UPSTREAM_KEY`.

## Extensions

Trusted extensions can register tools, commands, system prompt sections, and lifecycle hooks:

```bash
mkdir -p ~/.yo-agent/extensions
cp examples/extensions/word-count.ts ~/.yo-agent/extensions/
yoagent --tui
```

Place project extensions in `<workspace>/.yo-agent/extensions/`. Interactive sessions ask for confirmation before loading them for the first time. Extensions run in the main process with the current user's full permissions; untrusted code must use `plugin-host` instead of the trusted extension mechanism.

## Architecture

```text
packages/protocol        Events, RPC definitions, and runtime schemas
packages/provider        Provider adapters and model catalog
packages/tools           Tool registry, built-in tools, and execution backends
packages/store           EventLog, SQLite, IndexedDB, and checkpoints
packages/kernel          Agent loop, approvals, compaction, subagents, and policy
packages/surface-cli     Headless, JSONL, and TUI surfaces
packages/surface-rpc     JSON-RPC over stdio or WebSocket
packages/surface-mcp     MCP server and MCP host
packages/surface-acp     ACP integration
packages/surface-web     Browser Agent API and ChatController
packages/surface-weixin  Official WeChat iLink Bot protocol integration
packages/plugin-host     Worker-isolated plugins
packages/extension-host  In-process trusted extensions
apps/yo-agent            CLI composition root
apps/web-console         Vue web console
apps/web-demo            Embeddable browser demo
```

The core data model is an append-only `EventLog`. `AgentKernel` is the only event writer, while each surface consumes the kernel API and event stream. This allows sessions to be persisted, replayed, and resumed remotely.

See [`docs/DESIGN.md`](docs/DESIGN.md) for detailed design decisions.

## Development

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check
pnpm run test:coverage
```

`pnpm run check` runs type checking, linting, schema generation, the browser bundle check, and the full test suite.

## Security Boundaries

- The default shell backend only provides process-level L1 protection. It removes API keys and other sensitive environment variables and cleans up process groups on interruption, but commands can still access the host filesystem and network.
- The `bypass` permission mode skips approvals and must only be used in an explicitly trusted environment.
- WebSocket RPC listens on `0.0.0.0`; place it behind Tailscale, WireGuard, or another trusted network.
- Browser-side approval is not server-side authorization. Business tool APIs must independently authenticate and authorize every request.
- Trusted extensions are equivalent to executing local code. Changes to a previously trusted project extension do not trigger confirmation based on a file hash.

## Current Limitations

- Workspace packages are private, source-only packages without a stable npm release or API compatibility guarantee.
- Session fork/tree is implemented (a cross-session DAG via `forkedFrom` lineage); `EventEnvelope.parentId` remains unused, reserved for chat-platform reply threading.
- Container-level execution isolation, full observability, and multi-user authorization are still planned work.
