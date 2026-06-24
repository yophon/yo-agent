/**
 * yo-agent CLI（Phase 1）。三种 surface 形态共享同一内核：
 *   pnpm --filter @yo-agent/cli start -- -p "提问"            # headless 文本
 *   pnpm --filter @yo-agent/cli start -- --tui -p "提问"       # Ink TUI（交互审批）
 *   pnpm --filter @yo-agent/cli start -- --mode jsonl -p "提问" # 结构化 JSONL（给 bridge/脚本）
 *
 * Provider：ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY（OPENAI_MODE=responses，YO_TOOL_SHIM=1 双轨）；
 * 否则 FakeProvider 演示。YO_DB=路径 → SQLite 持久化。YO_COMPACT=1 → 启用 Condenser。自动加载 cwd 链上 yo.md/AGENTS.md。
 */
import { AgentKernel, HistoryLoopBreaker, loadConventionFiles } from '@yo-agent/kernel';
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
import type { EventEnvelope } from '@yo-agent/protocol';

interface Args {
  prompt: string;
  mode: 'tui' | 'jsonl' | 'headless';
}

function parseArgs(argv: string[]): Args {
  let prompt = '';
  let wantJsonl = false;
  let wantTui = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue; // pnpm 注入的分隔符
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
    if (a.startsWith('-')) continue; // 未知 flag 跳过
    positional.push(a);
  }
  if (!prompt) prompt = positional.join(' ');
  const mode: Args['mode'] = wantJsonl ? 'jsonl' : wantTui ? 'tui' : 'headless';
  return { prompt, mode };
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

async function main(): Promise<void> {
  const { prompt, mode } = parseArgs(process.argv.slice(2));
  if (!prompt) {
    console.error('用法：yo-agent [-p "提问"] [--tui | --mode jsonl]');
    process.exit(2);
  }
  const cwd = process.cwd();
  const system = (await loadConventionFiles(cwd)) || undefined;
  const env = process.env;

  const { provider, model, demo } = selectProvider(env, prompt);
  if (demo && mode !== 'jsonl') {
    console.error('[演示态] 未设 API key，使用 FakeProvider。设置 ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY 接真实模型。');
  }
  const catalog = ModelCatalog.bundled();
  const tools = new InMemoryToolRegistry();
  for (const t of builtinTools) tools.register(t);

  const kernel = new AgentKernel({
    store: buildStore(),
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: buildCondenser(env, provider, model),
    checkpointer: env.YO_CHECKPOINT === '1' ? new ShadowGitCheckpointer({ dir: cwd }) : undefined,
    model,
    cwd,
    usableContextTokens: usableContextTokens(model, catalog),
    interactiveApproval: mode === 'tui',
    approvalTimeoutMs: mode === 'tui' ? 5 * 60_000 : undefined, // 5 分钟默认 deny（§6.3）
  });

  const sessionId = await kernel.startSession({ system, model });

  if (mode === 'tui') {
    await runTui({ kernel, sessionId, prompt });
    return;
  }

  const renderer = mode === 'jsonl' ? new JsonlRenderer() : new HeadlessRenderer();
  // 先重放已落库的历史（SessionStarted=cursor 0，承载 model/tools/workspace/permission 等初始化元数据），
  // 再订阅实时——否则结构化消费者（bridge/脚本）丢首条 SessionStarted（subscribe 不重放）。
  for await (const e of kernel.events.read(sessionId)) renderer.render(e);
  kernel.subscribe(sessionId, null, (env2: EventEnvelope) => renderer.render(env2));
  await kernel.submitInput(sessionId, prompt, `cli-${Date.now()}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
