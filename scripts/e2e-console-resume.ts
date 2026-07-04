/**
 * Phase 5.1 headless 端到端冒烟：控制台核心链路（真 demo-backend + 真 LLM + 跨实例恢复）。
 * Node + fake-indexeddb 跑 IndexedDBEventStore（真 Chrome 的 IDB 行为由 web-console 目视验收）。
 * 验证：建 agent 配置 → materialize → 聊一轮含工具 → 模拟刷新（新 runtime 同库 open 回放）→ 续聊带上下文。
 */
import 'fake-indexeddb/auto';
import { IndexedDBEventStore } from '@yo-agent/store/core';
import { ChatController } from '@yo-agent/surface-web';
import { AgentRuntime, materializeAgentConfig } from '../apps/web-console/src/services/runtime.ts';
import { demoToolTemplates, newAgentRecord } from '../apps/web-console/src/services/types.ts';
import { listSessionItems } from '../apps/web-console/src/services/session-list.ts';
import { MemoryConsoleStore } from '../apps/web-console/src/services/console-store.ts';

const BASE = 'http://localhost:8788';

function rec() {
  const r = newAgentRecord();
  r.id = 'agent-shop';
  r.name = '商城客服';
  r.connection = { provider: 'openai', model: 'gpt-5.5', baseUrl: `${BASE}/v1`, apiKey: '', headers: { 'x-demo-token': 'demo-123' } };
  r.system = '你是「yo 商城」客服，能查订单（order_query）。回答简洁。';
  r.tools = demoToolTemplates();
  return r;
}

function assistantText(c: ChatController): string {
  const last = c.state.messages[c.state.messages.length - 1];
  return last?.parts.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
}

// ── 生命周期 1：建库，配置一个 agent，聊一轮含工具 ──
const store = await IndexedDBEventStore.open('e2e-console');
const consoleStore = new MemoryConsoleStore();
const record = rec();
await consoleStore.saveAgent(record);

const rt1 = new AgentRuntime(store); // approvalUi 省略（工具 approval:never，auto 放行）
const agent1 = rt1.agentFor(record);
void materializeAgentConfig; // 已在 agentFor 内部经 materialize（此处仅示意导出可用）
const c1 = new ChatController(agent1);
await c1.send('订单 42 到哪了');
const sid = c1.state.sessionId;
if (!sid) throw new Error('无 sessionId');
const round1 = assistantText(c1);
const tool1 = c1.state.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool');
console.log('轮1回答:', round1.trim());
console.log('轮1工具:', tool1 && tool1.type === 'tool' ? `${tool1.name}:${tool1.status}` : '（无）');
c1.dispose(); // 模拟关页

// ── 生命周期 2：新 runtime（模拟刷新后的新 kernel）同库 open 回放 + 续聊 ──
const rt2 = new AgentRuntime(store);
const c2 = new ChatController(rt2.agentFor(record));
await c2.open(sid);
const replayedRoles = c2.state.messages.map((m) => m.role).join(',');
const replayedUser = c2.state.messages[0]?.parts.find((p) => p.type === 'text');
console.log('回放消息角色序列:', replayedRoles);
console.log('回放首条用户气泡:', replayedUser && replayedUser.type === 'text' ? replayedUser.text : '（缺失!）');

await c2.send('那订单 7 呢');
const round2 = assistantText(c2);
console.log('轮2回答:', round2.trim());

// ── 侧栏会话列表（归属标注） ──
const items = await listSessionItems(store, consoleStore, [record]);
console.log('会话列表:', items.map((i) => `${i.agentName}/${i.title}`).join(' | '));

// ── 断言 ──
const pass =
  /发货|18:00|明天/.test(round1) &&
  tool1?.type === 'tool' &&
  tool1.status === 'ok' &&
  replayedRoles === 'user,assistant' &&
  (replayedUser?.type === 'text' ? replayedUser.text : '') === '订单 42 到哪了' &&
  /签收|7/.test(round2) &&
  c2.state.messages.length === 4 &&
  items.length === 1 &&
  items[0]?.agentName === '商城客服';

console.log(pass ? '\n✅ 控制台 E2E 通过：建配置 → 聊含工具 → 刷新恢复回放（用户气泡+工具）→ 续聊带上下文 → 会话归属' : '\n❌ E2E 未达标');
store.close();
process.exit(pass ? 0 : 1);
