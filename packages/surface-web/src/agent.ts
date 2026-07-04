/**
 * createWebAgent —— 浏览器侧组合根（PHASE-5 5B）。
 * 装配全部走 5A 的 core 子路径（浏览器安全面）：MemoryEventStore + InMemoryToolRegistry
 * + 按连接配置实例化 provider + 熔断/压缩。内核零改动，只做注入。
 */
import type { ApprovalGate, Condenser } from '@yo-agent/kernel/core';
import { AgentKernel, NoopCondenser, SummarizingCondenser, makeLoopBreaker, makeProviderSummarizer } from '@yo-agent/kernel/core';
import type { Id } from '@yo-agent/protocol';
import { ModelCatalog } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store/core';
import { InMemoryToolRegistry } from '@yo-agent/tools/core';
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
  /** 开新会话（system/model 取配置）；事件经 kernel.subscribe 消费，或直接交给 ChatController。 */
  startSession(): Promise<Id>;
}

export function createWebAgent(cfg: WebAgentConfig): WebAgent {
  const r = resolveWebAgentConfig(cfg);
  const provider = r.providerOverride ?? makeWebProvider(r.connection);
  const registry = new InMemoryToolRegistry();
  for (const t of r.tools) registry.register(t);
  // approval:'always' 的工具语义是「必经真人审批」，缺省 auto gate 会静默放行——
  // 不吞工具作者意图，出声提醒宿主传自定义 ApprovalGate（审查 S3）。
  if (r.approval === 'auto') {
    const always = r.tools.filter((t) => t.descriptor.approval === 'always').map((t) => t.descriptor.name);
    if (always.length > 0) {
      console.warn(`[surface-web] approval:'auto' 将自动放行声明 approval:'always' 的工具：${always.join(', ')}——需要真人审批请给 config.approval 传自定义 ApprovalGate`);
    }
  }

  const catalog = ModelCatalog.bundled();
  const contextWindow = catalog.contextWindow(r.connection.model);
  // 可用上下文 = 目录 contextWindow 的 80%，未知模型退默认（对齐 surface-cli/compose 语义）。
  const usableContextTokens = contextWindow ? Math.floor(contextWindow * 0.8) : 160_000;
  const condenser: Condenser = r.compaction
    ? new SummarizingCondenser({ summarize: makeProviderSummarizer(provider, r.connection.model) })
    : new NoopCondenser();

  const kernel = new AgentKernel({
    store: new MemoryEventStore(),
    provider,
    tools: registry,
    loopBreaker: makeLoopBreaker(r.loopBreakerMode),
    condenser,
    approvalGate: r.approval === 'auto' ? autoApproveGate : r.approval,
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
    startSession: () => kernel.startSession({ system: r.system, model: r.connection.model }),
  };
}
