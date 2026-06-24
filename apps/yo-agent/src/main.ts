/**
 * yo-agent headless CLI（Phase 1）。
 *
 *   pnpm --filter @yo-agent/cli start -- -p "你的提问"
 *
 * Provider 选择：ANTHROPIC_API_KEY → Anthropic；OPENAI_API_KEY(+OPENAI_BASE_URL) → OpenAI 兼容；
 * 否则 FakeProvider 演示。YO_DB=路径 → SQLite 持久化（否则内存）。自动加载 cwd 链上的 yo.md/AGENTS.md。
 */
import { AgentKernel, HistoryLoopBreaker, NoopCondenser, loadConventionFiles } from '@yo-agent/kernel';
import { MemoryEventStore, SqliteEventStore } from '@yo-agent/store';
import type { EventStore } from '@yo-agent/store';
import { InMemoryToolRegistry, builtinTools } from '@yo-agent/tools';
import { AnthropicProvider, FakeProvider, OpenAiCompatibleProvider, textTurn } from '@yo-agent/provider';
import type { Provider } from '@yo-agent/provider';
import type { EventEnvelope } from '@yo-agent/protocol';

function parsePrompt(argv: string[]): string {
  const i = argv.indexOf('-p');
  if (i >= 0) return argv[i + 1] ?? '';
  return argv.filter((a) => !a.startsWith('-')).join(' ');
}

function buildProvider(prompt: string): Provider {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  if (process.env.OPENAI_API_KEY) return new OpenAiCompatibleProvider({ baseUrl: process.env.OPENAI_BASE_URL });
  const fake = new FakeProvider();
  fake.script(textTurn(`（FakeProvider 演示）收到："${prompt}"。设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 接真实模型。`));
  return fake;
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

function render(env: EventEnvelope): void {
  const e = env.event;
  switch (e.kind) {
    case 'AssistantText':
      if (e.delta) process.stdout.write(e.delta);
      break;
    case 'ToolCallStarted':
      process.stdout.write(`\n[tool ${e.name}] `);
      break;
    case 'ToolCallOutput':
      process.stdout.write(e.chunk);
      break;
    case 'ApprovalRequested':
      process.stdout.write(`\n[审批] ${e.tool}（headless 默认拒绝；交互审批见 Phase 2）`);
      break;
    case 'TurnCompleted':
      process.stdout.write(`\n[完成: ${e.stopReason}]\n`);
      break;
    case 'TurnFailed':
      process.stdout.write(`\n[失败: ${e.error.message}]\n`);
      break;
    default:
      break;
  }
}

async function main(): Promise<void> {
  const prompt = parsePrompt(process.argv.slice(2));
  if (!prompt) {
    console.error('用法：yo-agent -p "你的提问"');
    process.exit(2);
  }
  const cwd = process.cwd();
  const system = (await loadConventionFiles(cwd)) || undefined;
  const tools = new InMemoryToolRegistry();
  for (const t of builtinTools) tools.register(t);
  const kernel = new AgentKernel({
    store: buildStore(),
    provider: buildProvider(prompt),
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: process.env.YO_MODEL ?? 'claude-opus-4-8',
    cwd,
  });
  const sessionId = await kernel.startSession({ system });
  kernel.subscribe(sessionId, null, render);
  await kernel.submitInput(sessionId, prompt, `cli-${Date.now()}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
