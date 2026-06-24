import { describe, it, expect } from 'vitest';
import type { Provider } from '@yo-agent/provider';
import type { ToolRegistry } from '@yo-agent/tools';
import type { EventStore } from '@yo-agent/store';
import type { Condenser, Surface } from '@yo-agent/kernel';
import { EVENTLOG_SCHEMA_VERSION } from '@yo-agent/store';

/**
 * Phase 0 退出标准之二：四接口冻结且可被实现（`satisfies` 在 typecheck 阶段保证结构正确）。
 */
describe('四接口冻结（Provider / Tool / Surface / Condenser）', () => {
  it('Provider 可被实现', () => {
    const p = {
      id: 'fake',
      capabilities: {
        nativeToolCalling: true,
        thinking: true,
        promptCache: true,
        effort: true,
      },
      async *streamChat() {
        yield { kind: 'TextDelta', text: 'hi' } as const;
      },
      async listModels() {
        return [];
      },
    } satisfies Provider;
    expect(p.id).toBe('fake');
  });

  it('ToolRegistry 可被实现', () => {
    const reg = {
      register(_tool) {},
      resolveAvailable(_ctx) {
        return [];
      },
      executor(_name) {
        return undefined;
      },
    } satisfies ToolRegistry;
    expect(reg.resolveAvailable({ sessionId: 's', cwd: '/' })).toEqual([]);
  });

  it('Condenser / Surface 可被实现', () => {
    const c = {
      shouldCompact: (ctx) => ctx.usedTokens / ctx.usableTokens >= 0.8,
      condense: async (messages) => messages, // 消息级（送 LLM 的窗口，§5.1）
    } satisfies Condenser;
    const s = { kind: 'cli', start: async () => {} } satisfies Surface;
    expect(c.shouldCompact({ usedTokens: 90, usableTokens: 100 })).toBe(true);
    expect(s.kind).toBe('cli');
  });

  it('EventStore 可被实现 + EventLog schema 版本入库', () => {
    const store = {
      async append() {},
      async *read() {},
      async head() {
        return null;
      },
      async createSession() {},
      async getSession() {
        return null;
      },
      async saveCheckpoint() {},
    } satisfies EventStore;
    expect(store).toBeDefined();
    expect(EVENTLOG_SCHEMA_VERSION).toBe(1);
  });
});
