/**
 * createWebAgent —— 浏览器侧组合根（PHASE-5 5B）。
 * 装配全部走 5A 的 core 子路径（浏览器安全面）：MemoryEventStore + InMemoryToolRegistry
 * + 按连接配置实例化 provider + 熔断/压缩。内核零改动，只做注入。
 */
import type { ApprovalGate, Condenser, FileSystem } from '@yo-agent/kernel/core';
import {
  AgentKernel,
  NoopCondenser,
  SummarizingCondenser,
  loadConventionFiles,
  loadSkills,
  makeLoopBreaker,
  makeProviderSummarizer,
  renderSkillSummaries,
} from '@yo-agent/kernel/core';
import type { Id } from '@yo-agent/protocol';
import { ModelCatalog } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store/core';
import {
  InMemoryToolRegistry,
  MAX_PARALLEL_CALLS,
  PARALLEL_TOOL,
  makeSkillActivateTool,
  parallelTool,
} from '@yo-agent/tools/core';
import type { WebAgentConfig } from './config';
import { makeWebProvider, resolveWebAgentConfig } from './config';

/**
 * 全自动放行 gate（缺省审批策略）：客服场景的安全边界在后端工具 API 的服务端鉴权，
 * 客户端审批 UI 不是防线（agent loop 用户可篡改）——见 PHASE-5 §0。
 */
const autoApproveGate: ApprovalGate = {
  async request() {
    return { decision: 'allow_once' as const };
  },
};

export interface WebAgent {
  readonly kernel: AgentKernel;
  readonly tools: InMemoryToolRegistry;
  readonly model: string;
  /** 开新会话（system 取配置，model 可覆盖）；事件经 kernel.subscribe 消费，或直接交给 ChatController。 */
  startSession(opts?: { sessionId?: Id; model?: string }): Promise<Id>;
}

export function createWebAgent(cfg: WebAgentConfig): WebAgent {
  const r = resolveWebAgentConfig(cfg);
  const provider = r.providerOverride ?? makeWebProvider(r.connection);
  const registry = new InMemoryToolRegistry();
  for (const t of r.tools) registry.register(t);
  // parallel 批量调用是引擎级能力（内核内联展开，feedback/4.10）：有工具就注册——
  // 尤其部分上游部署每响应至多 1 个 tool_call，没有它模型想并发也做不到；零工具时不注册（纯对话无对象）。
  const withParallel = r.tools.length > 0 && !r.tools.some((t) => t.descriptor.name === PARALLEL_TOOL);
  if (withParallel) registry.register(parallelTool);
  // 用法提示注入 system（4.9a 自知路数；feedback/4.10 实锤「工具描述 nudge 能背不能行」，须 system 级提醒）。
  const systemSuffix = withParallel
    ? `工具调用提示：需要同时执行多个工具调用（如批量查询多个订单）时，必须用 parallel 工具把它们装进一次调用（calls:[{tool,input},…]，至多 ${MAX_PARALLEL_CALLS} 个），不要逐个串行调用。`
    : undefined;
  // approval:'always' 的工具语义是「必经真人审批」，缺省 auto gate 会静默放行——
  // 不吞工具作者意图，出声提醒宿主传自定义 ApprovalGate（审查 S3）。
  if (r.approval === 'auto') {
    const always = r.tools.filter((t) => t.descriptor.approval === 'always').map((t) => t.descriptor.name);
    if (always.length > 0) {
      console.warn(`[surface-web] approval:'auto' 将自动放行声明 approval:'always' 的工具：${always.join(', ')}——需要真人审批请给 config.approval 传自定义 ApprovalGate`);
    }
  }

  // 5.2a contextFs：惰性加载一次（首个 startSession await），约定文件 + skills 摘要拼进 system、
  // 注册 skill_activate（懒加载全文）。虚拟 FS 约定：workspace 根 = '/'，skills 目录 = '/.yo-agent/skills'。
  // 失败降级（如宿主已注册同名 skill_activate 撞名）：出声告警、按无上下文段继续——不留未处理 rejection。
  const contextSections = r.contextFs
    ? loadWebContextSections(r.contextFs, registry).catch((e) => {
        console.warn(`[surface-web] contextFs 加载失败，已跳过：${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      })
    : undefined;

  const catalog = ModelCatalog.bundled();
  const contextWindow = catalog.contextWindow(r.connection.model);
  // 可用上下文 = 目录 contextWindow 的 80%，未知模型退默认（对齐 surface-cli/compose 语义）。
  const usableContextTokens = contextWindow ? Math.floor(contextWindow * 0.8) : 160_000;
  const condenser: Condenser = r.compaction
    ? new SummarizingCondenser({ summarize: makeProviderSummarizer(provider, r.connection.model) })
    : new NoopCondenser();

  const kernel = new AgentKernel({
    store: r.store ?? new MemoryEventStore(),
    agentProfile: r.agentProfile,
    provider,
    tools: registry,
    loopBreaker: makeLoopBreaker(r.loopBreakerMode),
    condenser,
    approvalGate: r.approval === 'auto' ? autoApproveGate : r.approval,
    systemSuffix,
    model: r.connection.model,
    cwd: '/',
    usableContextTokens,
    maxStepsPerTurn: r.maxStepsPerTurn,
    costEstimator: (model, usage) => catalog.estimateCost(model, usage),
  });

  return {
    kernel,
    tools: registry,
    model: r.connection.model,
    startSession: async (opts) => {
      const extra = contextSections ? await contextSections : undefined;
      const system = [r.system, extra].filter(Boolean).join('\n\n') || undefined;
      return kernel.startSession({ system, model: opts?.model ?? r.connection.model, sessionId: opts?.sessionId });
    },
  };
}

/**
 * 从注入的 FileSystem 组上下文段（5.2a）：约定文件链（'/' 起，MEMORY.md/@import 同 CLI 语义）+
 * skills 摘要（全文经 skill_activate 懒加载）。仅在 createWebAgent 时跑一次；坏文件经 console.warn 可见。
 */
async function loadWebContextSections(fs: FileSystem, registry: InMemoryToolRegistry): Promise<string | undefined> {
  const onWarn = (m: string): void => console.warn(`[surface-web] ${m}`);
  const conventions = await loadConventionFiles(fs, '/', { workspaceRoot: '/' });
  const skills = await loadSkills(fs, [{ dir: '/.yo-agent/skills', source: 'web' }], onWarn);
  if (skills.length > 0) {
    const byName = new Map(skills.map((s) => [s.name, s]));
    registry.register(makeSkillActivateTool((n) => byName.get(n), () => [...byName.keys()]));
  }
  return [conventions, renderSkillSummaries(skills)].filter(Boolean).join('\n\n') || undefined;
}
