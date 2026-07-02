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
import {
  AgentKernel,
  DefaultSubagentManager,
  HistoryLoopBreaker,
  appendMemoryLine,
  createInProcessRunner,
  findWorkspaceRoot,
  loadConventionFiles,
  loadRecipes,
  loadSkills,
  memoryKeyFor,
  parseRememberDirective,
  renderSkillSummaries,
} from '@yo-agent/kernel';
import type { Kernel, Recipe, Skill } from '@yo-agent/kernel';
import {
  InMemoryMemoryStore,
  MemoryEventStore,
  ShadowGitCheckpointer,
  SqliteEventStore,
  SqliteMemoryStore,
} from '@yo-agent/store';
import type { MemoryStore } from '@yo-agent/store';
import type { EventStore } from '@yo-agent/store';
import { InMemoryToolRegistry, builtinTools, makeSkillActivateTool, makeSubagentSpawnTool } from '@yo-agent/tools';
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
import { AcpSurface } from '@yo-agent/surface-acp';
import { ndJsonStream } from '@zed-industries/agent-client-protocol';
import { Readable, Writable } from 'node:stream';
import {
  McpHostManager,
  McpServerSurface,
  autoApproveGate,
  createStdioClientTransport,
  createStdioTransport,
  loadMcpServers,
  loadTrustedProjectServers,
} from '@yo-agent/surface-mcp';
import { DefaultPluginHost, loadPluginSpecs, workerTransportFactory } from '@yo-agent/plugin-host';
import { PairingGate } from '@yo-agent/auth';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalGate } from '@yo-agent/kernel';
import type { EventEnvelope } from '@yo-agent/protocol';

type Mode = 'tui' | 'jsonl' | 'headless' | 'rpc' | 'mcp-server' | 'acp';

interface Args {
  /** 4.6e：'last'（--continue）| 'picker'（--resume 不带 id）| 具体会话 id。 */
  resume?: string;
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
  let wantAcp = false;
  let listenPort: number | undefined;
  /** 4.6e:'last'(--continue)| 'picker'(--resume 不带 id)| 具体会话 id。 */
  let resume: string | undefined;
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
      if (v === 'rpc') wantRpc = true;
      if (v === 'mcp-server') wantMcp = true;
      if (v === 'acp') wantAcp = true;
      if (v === 'tui') wantTui = true;
      if (v !== undefined && !v.startsWith('-')) i++; // 消费其 value，勿泄漏进 positional
      continue;
    }
    if (a === '--tui') {
      wantTui = true;
      continue;
    }
    if (a === '--continue' || a === '-c') {
      resume = 'last';
      wantTui = true;
      continue;
    }
    if (a === '--resume' || a === '-r') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        resume = v;
        i++;
      } else {
        resume = 'picker';
      }
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
    if (a === 'acp' || a === '--acp') {
      wantAcp = true;
      continue;
    }
    if (a.startsWith('-')) continue; // 未知 flag 跳过
    positional.push(a);
  }
  if (!prompt) prompt = positional.join(' ');
  const mode: Mode = wantAcp
    ? 'acp'
    : wantMcp
      ? 'mcp-server'
      : wantRpc
        ? 'rpc'
        : wantJsonl
          ? 'jsonl'
          : wantTui
            ? 'tui'
            : 'headless';
  return { prompt, mode, listenPort, resume };
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

async function buildKernel(opts: { env: NodeJS.ProcessEnv; cwd: string; prompt: string; mode: Mode }): Promise<{
  kernel: AgentKernel;
  model: string;
  demo: boolean;
  mcpHost: McpHostManager;
  pluginHost: DefaultPluginHost;
}> {
  const { provider, model, demo } = selectProvider(opts.env, opts.prompt);
  const catalog = ModelCatalog.bundled();
  const tools = new InMemoryToolRegistry();
  for (const t of builtinTools) tools.register(t);

  // 声明式扩展（4D）：从 ~/.yo-agent 与 workspace/.yo-agent 加载 skills（懒加载）+ recipes（子 agent 画像）。
  // global 在前、project 在后（project 同名覆盖）。提交 git 即全队共享。
  const wsRoot = findWorkspaceRoot(opts.cwd);
  const home = homedir();
  const skills: Skill[] = await loadSkills([
    { dir: join(home, '.yo-agent', 'skills'), source: 'global' },
    { dir: join(wsRoot, '.yo-agent', 'skills'), source: 'project' },
  ]);
  const recipes: Map<string, Recipe> = await loadRecipes([
    { dir: join(home, '.yo-agent', 'agents'), source: 'global' },
    { dir: join(wsRoot, '.yo-agent', 'agents'), source: 'project' },
  ]);
  const skillByName = new Map(skills.map((s) => [s.name, s]));
  if (skills.length > 0) tools.register(makeSkillActivateTool((n) => skillByName.get(n), () => [...skillByName.keys()]));
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
  // 插件 host（4E / ADR-18）：第三方插件跑独立 Worker，工具/hook 经 IPC 隔离；崩溃不拖垮主进程、读不到 secret。
  // 插件工具以 owner:'plugin'、approval 非 never 注册进同一 registry（经主审批流）；健康标志喂 kernel.toolFlags
  //（崩溃/未就绪 → availability configFlag 撤下 → 工具消失，复用 3C 熔断接缝）。
  const pluginSpecs = await loadPluginSpecs([join(home, '.yo-agent', 'plugins'), join(wsRoot, '.yo-agent', 'plugins')]);
  const pluginHost = new DefaultPluginHost({
    registry: tools,
    transportFor: workerTransportFactory(pluginSpecs),
    log: (m) => console.error(m),
  });
  // mcp + plugin 健康标志合并喂 availability（任一源熔断/崩溃 → 其工具从 resolveAvailable 消失）。
  const allFlags = (): Set<string> => new Set([...mcpHost.flags(), ...pluginHost.flags()]);
  const interactive = opts.mode === 'tui' || opts.mode === 'rpc' || opts.mode === 'acp';
  // mcp-server：autonomous 节点，放行所有工具（orchestrator 已委派信任，§3.3/§15.3 安全注见 surface-mcp）。
  const approvalGate: ApprovalGate | undefined = opts.mode === 'mcp-server' ? autoApproveGate : undefined;
  const store = buildStore();
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: buildCondenser(opts.env, provider, model),
    checkpointer: opts.env.YO_CHECKPOINT === '1' ? new ShadowGitCheckpointer({ dir: opts.cwd }) : undefined,
    approvalGate,
    toolFlags: () => allFlags(),
    mcpStatusSource: () => mcpHost.statusSnapshot(), // MCP 连接状态落 EventLog（3C 可观测）
    mcpEnsureConnected: () => mcpHost.ensureConnected(), // 每 turn 起点重连空闲断连的 server（懒加载收口）
    model,
    cwd: opts.cwd,
    usableContextTokens: usableContextTokens(model, catalog),
    interactiveApproval: interactive,
    approvalTimeoutMs: interactive ? 5 * 60_000 : undefined, // 5 分钟默认 deny（§6.3）
    systemSuffix: renderSkillSummaries(skills) || undefined, // 技能摘要常驻 system（4D，跨 surface 统一）
    costEstimator: (m, u) => catalog.estimateCost(m, u), // 4F：UsageUpdate/TurnCompleted 填 costUsd（含 cache 分价）
    sessionReaper: (sid) => subagents.abortInflight(sid), // 审查 gap#2：会话驱逐时回收其背景子 agent
    // fallbacks：内核已支持 deps.fallbacks（provider fallback 链 / auth rotation）；CLI 单 provider 默认不配链。
    // 多 key/多 provider 链由部署侧按需注入（见 docs/PHASE-4.md 4F）。
  });
  // 子 agent（4C / ADR-17）：host=本内核（仍是唯一 AgentEvent 写入者）；in-process 档跑独立 childSessionId 子内核。
  // deriveSubagentPolicy 收紧基准 = 父会话当前可见工具 + 权限模式；递归经 deriveSubagentPolicy 剥离 spawn + maxDepth 双防护。
  const subagents = new DefaultSubagentManager({
    host: kernel,
    runner: createInProcessRunner({
      store,
      provider,
      registry: tools,
      loopBreaker: () => new HistoryLoopBreaker(),
      condenser: () => buildCondenser(opts.env, provider, model),
      usableContextTokens: usableContextTokens(model, catalog),
    }),
    parentToolsOf: (sid) => tools.resolveAvailable({ sessionId: sid, cwd: opts.cwd, flags: allFlags() }).map((d) => d.name),
    parentModeOf: (sid) => kernel.listSessions().find((s) => s.sessionId === sid)?.permissionMode ?? 'supervised',
    cwdOf: () => opts.cwd,
    defaultModel: model,
    recipeFor: (profile) => recipes.get(profile), // 4D：子 agent 画像（工具/权限/model/prompt 请求，仍经 deriveSubagentPolicy 收紧）
  });
  tools.register(makeSubagentSpawnTool(subagents));

  // 插件 hook 跨进程兑现（4E）：聚合 Hooks 注册进 kernel HookBus 一次，按订阅 fan-out 经 IPC；
  // 插件不可用/超时/崩溃绝不抛（PreToolUse 视为放行，不因挂掉的插件拒主循环工具）。
  kernel.registerHook(pluginHost.hooks());
  // 启动插件（各自握手 ready 后注册其工具）；best-effort：失败/崩溃只记日志、不阻断本机 agent。
  if (pluginSpecs.length > 0) {
    try {
      const ok = await pluginHost.start(pluginSpecs);
      if (ok.length > 0) console.error(`[plugin] 已加载 ${ok.length}/${pluginSpecs.length} 插件：${ok.join(', ')}`);
    } catch (e) {
      console.error(`[plugin] 启动异常（跳过）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { kernel, model, demo, mcpHost, pluginHost };
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
function installShutdown(mcpHost: McpHostManager, pluginHost?: DefaultPluginHost): void {
  let closing = false;
  const shutdown = (code: number): void => {
    if (closing) return;
    closing = true;
    void Promise.allSettled([mcpHost.closeAll(), pluginHost?.closeAll() ?? Promise.resolve()]).finally(() =>
      process.exit(code),
    );
  };
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') shutdown(0);
  });
}

async function main(): Promise<void> {
  const { prompt, mode, listenPort, resume } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const env = process.env;

  // 常驻服务（rpc/mcp/acp）兜底：后台 turn 异常不崩进程。管道断开/退出信号经各分支 installShutdown 回收子进程。
  if (mode === 'rpc' || mode === 'mcp-server' || mode === 'acp') {
    process.on('uncaughtException', (e) => console.error('[uncaught]', e));
    process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  }

  // ACP 模式：stdin/stdout 是 ACP（JSON-RPC over ndjson）协议通道，被 Zed/JetBrains 接管为编程 agent 后端。
  // 日志走 stderr，进程常驻。审批经 ACP 反向 requestPermission（interactiveApproval）。
  if (mode === 'acp') {
    const { kernel, mcpHost, pluginHost } = await buildKernel({ env, cwd, prompt: '', mode });
    await bootstrapMcpHost(mcpHost, cwd, env); // 连外部 MCP server（真实 ApprovalGate 把关）
    installShutdown(mcpHost, pluginHost);
    setInterval(() => void mcpHost.sweepIdle(), 60_000).unref();
    const acpStream = ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    );
    await new AcpSurface(acpStream).start(kernel as Kernel);
    await new Promise<void>(() => {}); // 永不 resolve：进程常驻
    return;
  }

  // RPC 模式：--listen <port> → WS server（带设备鉴权），否则 stdio JSONL。日志一律走 stderr，进程常驻。
  if (mode === 'rpc') {
    const { kernel, mcpHost, pluginHost } = await buildKernel({ env, cwd, prompt: '', mode });
    await bootstrapMcpHost(mcpHost, cwd, env); // 连外部 MCP server（真实 ApprovalGate 把关）
    installShutdown(mcpHost, pluginHost); // 常驻进程：SIGINT/SIGTERM/EPIPE 退出前回收子进程
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
    const { kernel, mcpHost, pluginHost } = await buildKernel({ env, cwd, prompt: '', mode });
    installShutdown(mcpHost, pluginHost); // 本模式不 bootstrap host（closeAll 为空 no-op），仍统一 EPIPE→受控退出
    await new McpServerSurface({ transport: createStdioTransport() }).start(kernel as Kernel);
    await new Promise<void>(() => {}); // 永不 resolve：进程常驻
    return;
  }

  // --tui 是交互式 REPL，允许无初始 prompt 启动（进输入态等待键入）；其余一次性模式仍需 prompt。
  if (!prompt && mode !== 'tui') {
    console.error('用法：yo-agent [-p "提问"] [--tui | --mode jsonl | rpc | mcp-server | acp]');
    process.exit(2);
  }
  const workspaceRoot = findWorkspaceRoot(cwd);

  // 手动记忆主路（3E）：`#remember <文本>` 落盘 MEMORY.md + 写结构化 MemoryStore，不耗 LLM 轮次。
  const remember = parseRememberDirective(prompt);
  if (remember) {
    const line = await appendMemoryLine(workspaceRoot, remember.content);
    const memStore: MemoryStore = process.env.YO_DB ? SqliteMemoryStore.open(process.env.YO_DB) : new InMemoryMemoryStore();
    await memStore.writeMemory({
      workspacePath: workspaceRoot,
      key: memoryKeyFor(remember.content),
      content: remember.content,
      updatedAt: Date.now(),
      source: 'remember',
    });
    console.error(`[记忆] 已写入 ${workspaceRoot}/MEMORY.md：${line}`);
    return;
  }

  const system = (await loadConventionFiles(cwd, { workspaceRoot })) || undefined;
  const { kernel, model, demo, mcpHost, pluginHost } = await buildKernel({ env, cwd, prompt, mode });
  if (demo && mode !== 'jsonl') {
    console.error('[演示态] 未设 API key，使用 FakeProvider。设置 ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY 接真实模型。');
  }
  await bootstrapMcpHost(mcpHost, cwd, env); // 连外部 MCP server（首轮前完成发现/注册）
  installShutdown(mcpHost, pluginHost); // SIGINT/SIGTERM 中断也回收子进程

  // 4.6e：--continue/--resume <id> 优先恢复持久会话（需 YO_DB）；失败回退新会话。
  let sessionId: string | undefined;
  let openResumePicker = false;
  if (resume === 'picker') {
    openResumePicker = true;
  } else if (resume) {
    const target =
      resume === 'last'
        ? (await kernel.listPersistedSessions()).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.sessionId
        : resume;
    if (target && (await kernel.resumeSession(target).catch(() => false))) {
      sessionId = target;
      console.error(`[resume] 已恢复会话 ${String(target).slice(0, 8)}`);
    } else {
      console.error('[resume] 无可恢复会话（需 YO_DB=路径 持久化），已开新会话');
    }
  }
  // 4.7f:恢复成功的会话在 TUI 挂载时回放历史(不再空屏)。
  const replayOnMount = sessionId !== undefined;
  sessionId ??= await kernel.startSession({ system, model });

  // try/finally：turn 抛错（走 main().catch→exit(1)）也回收子进程，不只 happy-path（审查 lifecycle）。
  try {
    if (mode === 'tui') {
      const mode0 = kernel.listSessions().find((s) => s.sessionId === sessionId)?.permissionMode ?? 'supervised';
      const model0 = kernel.listSessions().find((s) => s.sessionId === sessionId)?.model ?? model;
      await runTui({ kernel, sessionId, prompt, model: model0, cwd, permissionMode: mode0, demo, openResumePicker, replayOnMount });
      return;
    }
    const renderer = mode === 'jsonl' ? new JsonlRenderer() : new HeadlessRenderer();
    // 先重放已落库的历史（SessionStarted=cursor 0，承载初始化元数据），再订阅实时——否则结构化消费者丢首条 SessionStarted。
    for await (const e of kernel.events.read(sessionId)) renderer.render(e);
    kernel.subscribe(sessionId, null, (env2: EventEnvelope) => renderer.render(env2));
    await kernel.submitInput(sessionId, prompt, `cli-${Date.now()}`);
  } finally {
    await Promise.allSettled([mcpHost.closeAll(), pluginHost.closeAll()]); // 一次性会话结束 / 异常 → 回收外部 server 子进程 + 插件 Worker
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
