/**
 * yo-agent CLI（Phase 1 + Phase 2 RpcSurface）。多 surface 形态共享同一内核：
 *   pnpm --filter @yo-agent/cli start -- -p "提问"             # headless 文本
 *   pnpm --filter @yo-agent/cli start -- --tui -p "提问"        # Ink TUI（交互审批）
 *   pnpm --filter @yo-agent/cli start -- --mode jsonl -p "提问"  # 结构化 JSONL 单次
 *   pnpm --filter @yo-agent/cli start -- rpc                     # JSON-RPC over stdin/stdout（通用远端驱动，常驻）
 *   pnpm --filter @yo-agent/cli start -- rpc --listen 8787      # JSON-RPC over WS + ed25519 设备鉴权（隧道内）
 *   pnpm --filter @yo-agent/cli start -- mcp-server             # MCP server over stdio（被 Claude Code/Cursor 调用，常驻）
 *
 * Provider：ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY（OPENAI_MODE=responses，YO_TOOL_SHIM=1 双轨）；
 * 否则 FakeProvider 演示。YO_DB=路径 → SQLite 持久化。YO_COMPACT=1 → 启用 Condenser。自动加载 cwd 链上 yo.md/AGENTS.md。
 */
import { AgentKernel, HistoryLoopBreaker, loadConventionFiles } from '@yo-agent/kernel';
import type { Kernel } from '@yo-agent/kernel';
import { MemoryEventStore, ShadowGitCheckpointer, SqliteEventStore } from '@yo-agent/store';
import type { EventStore } from '@yo-agent/store';
import { InMemoryToolRegistry, builtinTools } from '@yo-agent/tools';
import { ModelCatalog } from '@yo-agent/provider';
import {
  HeadlessRenderer,
  JsonlRenderer,
  buildCondenser,
  runTui,
  selectProvider,
  usableContextTokens,
} from '@yo-agent/surface-cli';
import { JsonlStreamChannel, RpcSurface, serveWebSocket } from '@yo-agent/surface-rpc';
import {
  McpHostManager,
  McpServerSurface,
  autoApproveGate,
  createStdioClientTransport,
  createStdioTransport,
  loadMcpServers,
  loadTrustedProjectServers,
} from '@yo-agent/surface-mcp';
import { PairingGate } from '@yo-agent/auth';
import { homedir } from 'node:os';
import type { ApprovalGate } from '@yo-agent/kernel';
import type { EventEnvelope } from '@yo-agent/protocol';

type Mode = 'tui' | 'jsonl' | 'headless' | 'rpc' | 'mcp-server';

interface Args {
  prompt: string;
  mode: Mode;
  /** rpc --listen <port>：WS server 模式（带设备鉴权），否则 stdio。 */
  listenPort?: number;
}

function parseArgs(argv: string[]): Args {
  let prompt = '';
  let wantJsonl = false;
  let wantTui = false;
  let wantRpc = false;
  let wantMcp = false;
  let listenPort: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue; // pnpm 注入的分隔符
    if (a === '--listen') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        listenPort = Number.parseInt(v, 10);
        i++;
      }
      continue;
    }
    if (a === '-p') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        prompt = v;
        i++;
      } // -p 后紧跟 flag/缺值 → 视为缺 prompt，触发用法提示
      continue;
    }
    if (a === '--mode') {
      const v = argv[i + 1];
      if (v === 'jsonl') wantJsonl = true;
      if (v !== undefined && !v.startsWith('-')) i++; // 消费其 value，勿泄漏进 positional
      continue;
    }
    if (a === '--tui') {
      wantTui = true;
      continue;
    }
    if (a === 'rpc' || a === '--rpc') {
      wantRpc = true;
      continue;
    }
    if (a === 'mcp-server' || a === '--mcp-server') {
      wantMcp = true;
      continue;
    }
    if (a.startsWith('-')) continue; // 未知 flag 跳过
    positional.push(a);
  }
  if (!prompt) prompt = positional.join(' ');
  const mode: Mode = wantMcp ? 'mcp-server' : wantRpc ? 'rpc' : wantJsonl ? 'jsonl' : wantTui ? 'tui' : 'headless';
  return { prompt, mode, listenPort };
}

function buildStore(): EventStore {
  const dbPath = process.env.YO_DB;
  if (dbPath) {
    try {
      return SqliteEventStore.open(dbPath);
    } catch (e) {
      console.error(`[warn] SQLite 不可用，降级内存：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return new MemoryEventStore();
}

function buildKernel(opts: { env: NodeJS.ProcessEnv; cwd: string; prompt: string; mode: Mode }): {
  kernel: AgentKernel;
  model: string;
  demo: boolean;
  mcpHost: McpHostManager;
} {
  const { provider, model, demo } = selectProvider(opts.env, opts.prompt);
  const catalog = ModelCatalog.bundled();
  const tools = new InMemoryToolRegistry();
  for (const t of builtinTools) tools.register(t);
  // MCP host：外部 server 工具经 3A 护栏注册进同一 registry；连接健康标志喂 kernel.toolFlags
  //（熔断/未连接 → 工具经 availability configFlag 从 resolveAvailable 消失）。连接在 main() 引导。
  const mcpHost = new McpHostManager({
    registry: tools,
    transportFor: createStdioClientTransport,
    log: (m) => console.error(m),
    // 连接状态变化（连接/断连/熔断）走 stderr 运行日志；落 EventLog 由 kernel.mcpStatusSource diff 负责。
    onStatus: (st) =>
      console.error(`[mcp] ${st.server} → ${st.status}${st.toolCount !== undefined ? `（${st.toolCount} 工具）` : ''}`),
  });
  const interactive = opts.mode === 'tui' || opts.mode === 'rpc';
  // mcp-server：autonomous 节点，放行所有工具（orchestrator 已委派信任，§3.3/§15.3 安全注见 surface-mcp）。
  const approvalGate: ApprovalGate | undefined = opts.mode === 'mcp-server' ? autoApproveGate : undefined;
  const kernel = new AgentKernel({
    store: buildStore(),
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: buildCondenser(opts.env, provider, model),
    checkpointer: opts.env.YO_CHECKPOINT === '1' ? new ShadowGitCheckpointer({ dir: opts.cwd }) : undefined,
    approvalGate,
    toolFlags: () => mcpHost.flags(),
    mcpStatusSource: () => mcpHost.statusSnapshot(), // MCP 连接状态落 EventLog（3C 可观测）
    mcpEnsureConnected: () => mcpHost.ensureConnected(), // 每 turn 起点重连空闲断连的 server（懒加载收口）
    model,
    cwd: opts.cwd,
    usableContextTokens: usableContextTokens(model, catalog),
    interactiveApproval: interactive,
    approvalTimeoutMs: interactive ? 5 * 60_000 : undefined, // 5 分钟默认 deny（§6.3）
  });
  return { kernel, model, demo, mcpHost };
}

/**
 * 引导 MCP host：加载三层信任配置 → 连接外部 server → 经 3A 护栏注册工具。
 * 非致命：任何加载/连接失败只记日志、不崩主流程（外部 server 不可信，不应阻断本机 agent）。
 * **不在 mcp-server 模式引导**——那里是 autoApproveGate，外部工具会被无审批放行（安全灾难，§15.3）。
 */
async function bootstrapMcpHost(mcpHost: McpHostManager, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const home = homedir();
  let trusted: Set<string>;
  try {
    trusted = await loadTrustedProjectServers(home, cwd);
  } catch (e) {
    console.error(`[mcp] 信任清单读取失败，project server 全部按未信任处理：${e instanceof Error ? e.message : String(e)}`);
    trusted = new Set();
  }
  let servers;
  try {
    servers = await loadMcpServers({
      homeDir: home,
      projectDir: cwd,
      processEnv: env,
      isProjectServerTrusted: (name) => trusted.has(name),
      log: (m) => console.error(m),
    });
  } catch (e) {
    console.error(`[mcp] 配置加载失败，跳过 MCP host：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (servers.length === 0) return;
  await mcpHost.start(servers);
}

/**
 * 进程退出前回收 MCP host 子进程（审查 lifecycle/wiring：常驻 rpc 与异常路径会泄漏 stdio 子 server）。
 * 覆盖 SIGINT/SIGTERM/EPIPE 三条退出路径——closeAll 逐个向 transport 发 SIGTERM 杀子进程。幂等。
 */
function installShutdown(mcpHost: McpHostManager): void {
  let closing = false;
  const shutdown = (code: number): void => {
    if (closing) return;
    closing = true;
    void mcpHost.closeAll().finally(() => process.exit(code));
  };
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') shutdown(0);
  });
}

async function main(): Promise<void> {
  const { prompt, mode, listenPort } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const env = process.env;

  // 常驻服务（rpc/mcp）兜底：后台 turn 异常不崩进程。管道断开/退出信号经各分支 installShutdown 回收子进程。
  if (mode === 'rpc' || mode === 'mcp-server') {
    process.on('uncaughtException', (e) => console.error('[uncaught]', e));
    process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  }

  // RPC 模式：--listen <port> → WS server（带设备鉴权），否则 stdio JSONL。日志一律走 stderr，进程常驻。
  if (mode === 'rpc') {
    const { kernel, mcpHost } = buildKernel({ env, cwd, prompt: '', mode });
    await bootstrapMcpHost(mcpHost, cwd, env); // 连外部 MCP server（真实 ApprovalGate 把关）
    installShutdown(mcpHost); // 常驻进程：SIGINT/SIGTERM/EPIPE 退出前回收子进程
    // 常驻进程才需空闲 TTL 清理：周期扫描断开长闲连接回收子进程（in-flight 守卫在 sweepIdle 内）。
    // unref 不阻止进程退出；进程退出时 installShutdown 已统一 closeAll。
    setInterval(() => void mcpHost.sweepIdle(), 60_000).unref();
    if (listenPort !== undefined) {
      // WS server：每连接先过 ed25519 + 配对码 + nonce 挑战握手，再交给 RpcSurface。
      const gate = new PairingGate();
      for (const k of (env.YO_TRUSTED_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) gate.trust(k);
      if (gate.trustedKeys().length === 0) {
        console.error(`[配对] 首次连接请用配对码：${gate.issueCode()}（带外告知客户端）`);
      }
      const handle = await serveWebSocket({
        port: listenPort,
        gate,
        onSession: (channel, pubKey) => {
          console.error(`[rpc] 已鉴权连接 ${pubKey.slice(0, 16)}…（设 YO_TRUSTED_KEYS=${pubKey} 可免配对重连）`);
          void new RpcSurface(channel).start(kernel as Kernel);
        },
        onAuthError: (e) => console.error('[rpc] 鉴权失败：', e instanceof Error ? e.message : e),
      });
      console.error(`[rpc] WS 监听 ws://0.0.0.0:${handle.port}（建议仅经 Tailscale/WireGuard 隧道访问）`);
      await new Promise<void>(() => {});
      return;
    }
    const channel = new JsonlStreamChannel(process.stdin, process.stdout);
    await new RpcSurface(channel).start(kernel as Kernel);
    await new Promise<void>(() => {}); // 永不 resolve：进程常驻
    return;
  }

  // MCP server 模式：stdout 是 MCP 协议通道（日志走 stderr），常驻；被 Claude Code/Cursor 当节点调用。
  if (mode === 'mcp-server') {
    const { kernel, mcpHost } = buildKernel({ env, cwd, prompt: '', mode });
    installShutdown(mcpHost); // 本模式不 bootstrap host（closeAll 为空 no-op），仍统一 EPIPE→受控退出
    await new McpServerSurface({ transport: createStdioTransport() }).start(kernel as Kernel);
    await new Promise<void>(() => {}); // 永不 resolve：进程常驻
    return;
  }

  if (!prompt) {
    console.error('用法：yo-agent [-p "提问"] [--tui | --mode jsonl | rpc | mcp-server]');
    process.exit(2);
  }
  const system = (await loadConventionFiles(cwd)) || undefined;
  const { kernel, model, demo, mcpHost } = buildKernel({ env, cwd, prompt, mode });
  if (demo && mode !== 'jsonl') {
    console.error('[演示态] 未设 API key，使用 FakeProvider。设置 ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY 接真实模型。');
  }
  await bootstrapMcpHost(mcpHost, cwd, env); // 连外部 MCP server（首轮前完成发现/注册）
  installShutdown(mcpHost); // SIGINT/SIGTERM 中断也回收子进程

  const sessionId = await kernel.startSession({ system, model });

  // try/finally：turn 抛错（走 main().catch→exit(1)）也回收子进程，不只 happy-path（审查 lifecycle）。
  try {
    if (mode === 'tui') {
      await runTui({ kernel, sessionId, prompt });
      return;
    }
    const renderer = mode === 'jsonl' ? new JsonlRenderer() : new HeadlessRenderer();
    // 先重放已落库的历史（SessionStarted=cursor 0，承载初始化元数据），再订阅实时——否则结构化消费者丢首条 SessionStarted。
    for await (const e of kernel.events.read(sessionId)) renderer.render(e);
    kernel.subscribe(sessionId, null, (env2: EventEnvelope) => renderer.render(env2));
    await kernel.submitInput(sessionId, prompt, `cli-${Date.now()}`);
  } finally {
    await mcpHost.closeAll(); // 一次性会话结束 / 异常 → 回收外部 server 子进程
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
