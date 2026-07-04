import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store/core';
import { createWebAgent } from '@yo-agent/surface-web';
import { LocalConsoleStore } from '../src/services/console-store';
import { materializeAgentConfig, openSharedEventStore } from '../src/services/runtime';
import { demoToolTemplates, newAgentRecord } from '../src/services/types';

function rec() {
  const r = newAgentRecord();
  r.name = '客服';
  r.connection = { provider: 'openai', model: 'fake-model', baseUrl: 'http://localhost:8788/v1', apiKey: '', headers: { 'x-demo-token': 't' } };
  r.system = '你是客服';
  r.tools = demoToolTemplates();
  return r;
}

describe('materializeAgentConfig（声明式记录 → 可执行配置）', () => {
  it('工具物化 + store/agentProfile 透传 + 全链路可跑（confirm 审批弹窗管道生效）', async () => {
    const events = new MemoryEventStore();
    const record = rec();
    record.approvalMode = 'confirm';
    record.tools[0]!.name = 'order_query';
    const approvalUi = vi.fn(async () => true); // 模拟用户点「允许」
    const cfg = materializeAgentConfig(record, events, approvalUi);
    expect(cfg.agentProfile).toBe(record.id);
    expect(cfg.store).toBe(events);
    expect(cfg.tools?.map((t) => t.descriptor.name)).toEqual(['order_query', 'ticket_create']);

    // confirm gate：工具是 approval:'never'（defineHttpTool 缺省）不会问；换 risk-based 验证弹窗管道。
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FakeProvider().script(toolCallTurn('order_query', 't1', { orderId: '42' })).script(textTurn('好'));
    const tool = cfg.tools?.[0];
    if (tool) tool.descriptor.approval = 'risk-based';
    const agent = createWebAgent({ ...cfg, providerOverride: provider });
    const c = await agent.startSession();
    await agent.kernel.submitInput(c, '查 42', 'k');
    expect(approvalUi).toHaveBeenCalledWith(expect.objectContaining({ tool: 'order_query' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('inputSchemaJson 非法 → 可行动错误', () => {
    const record = rec();
    record.tools[0]!.inputSchemaJson = '{bad';
    expect(() => materializeAgentConfig(record, new MemoryEventStore())).toThrow(/不是合法 JSON/);
  });
});

describe('openSharedEventStore', () => {
  it('有 IndexedDB → 持久实现 + deleteSession 可用', async () => {
    const shared = await openSharedEventStore(`yo-shared-${Date.now() % 100000}-a`);
    expect(shared.persistent).toBe(true);
    expect(typeof shared.deleteSession).toBe('function');
  });

  it('无 IndexedDB → 降级 Memory 并标记不持久', async () => {
    const g = globalThis as { indexedDB?: unknown };
    const saved = g.indexedDB;
    g.indexedDB = undefined; // 模拟隐私模式无 IndexedDB（idbGlobals 判空即降级）
    const shared = await openSharedEventStore();
    expect(shared.persistent).toBe(false);
    expect(shared.deleteSession).toBeUndefined();
    g.indexedDB = saved;
  });
});

describe('LocalConsoleStore（fake-indexeddb）', () => {
  it('agent 与 sessionMeta CRUD 往返', async () => {
    const s = await LocalConsoleStore.open(`yo-console-${Date.now() % 100000}`);
    const a = rec();
    await s.saveAgent(a);
    expect((await s.getAgent(a.id))?.name).toBe('客服');
    a.name = '售后';
    await s.saveAgent(a); // upsert
    expect((await s.listAgents()).map((x) => x.name)).toEqual(['售后']);
    await s.deleteAgent(a.id);
    expect(await s.getAgent(a.id)).toBeNull();

    await s.saveSessionMeta({ sessionId: 's1', title: 'T' });
    expect((await s.getSessionMeta('s1'))?.title).toBe('T');
    await s.deleteSessionMeta('s1');
    expect(await s.getSessionMeta('s1')).toBeNull();
  });
});
