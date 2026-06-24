/**
 * @yo-agent/provider —— Provider 抽象（DESIGN §4 / §15.4）。
 * 类型契约在 types.ts；FakeProvider（测试用）在 fake.ts；真实 AnthropicProvider 在 anthropic.ts。
 */
export * from './types';
export * from './sse';
export * from './fake';
export * from './anthropic';
export * from './openai';
