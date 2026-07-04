/**
 * check:browser 冒烟入口（5A）：把「内核 + 纯逻辑外围」按浏览器平台打包，
 * 任何 node: 前缀或 Node 内建被牵进模块图 → esbuild 解析期即红（见 check-browser.mjs）。
 * 5B 后 surface-web 真入口并列加入；本 fixture 保底覆盖四个 core 面。
 */
import { AgentKernel, NoopCondenser, makeLoopBreaker } from '@yo-agent/kernel/core';
import { MemoryEventStore } from '@yo-agent/store/core';
import { InMemoryToolRegistry } from '@yo-agent/tools/core';
import { AnthropicProvider, FakeProvider, GeminiProvider, OpenAiCompatibleProvider, OpenAiResponsesProvider } from '@yo-agent/provider';

export function smokeAssemble(): AgentKernel {
  // 引用全部 provider 构造，确保 process.env 防御在浏览器打包面内被覆盖。
  void [AnthropicProvider, GeminiProvider, OpenAiCompatibleProvider, OpenAiResponsesProvider];
  return new AgentKernel({
    store: new MemoryEventStore(),
    provider: new FakeProvider(),
    tools: new InMemoryToolRegistry(),
    loopBreaker: makeLoopBreaker('loose'),
    condenser: new NoopCondenser(),
    cwd: '/',
  });
}
