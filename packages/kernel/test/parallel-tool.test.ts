/** feedback/4.10 — `parallel` 批量调用工具:内核内联展开,子调用逐一过准入链后进波次并发。 */
import { describe, expect, it } from 'vitest';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import type { ApprovalGate } from '@yo-agent/kernel';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry, parallelTool } from '@yo-agent/tools';
import type { RegisteredTool, ToolApproval } from '@yo-agent/tools';
import type { AgentEvent, EventEnvelope, ToolKind } from '@yo-agent/protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, capMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < capMs) await sleep(2);
}

function makeTool(opts: {
  name: string;
  kind: ToolKind;
  approval?: ToolApproval;
  execute: (input: unknown) => Promise<string>;
}): RegisteredTool {
  return {
    descriptor: {
      name: opts.name,
      kind: opts.kind,
      description: opts.name,
      inputSchema: { type: 'object' },
      owner: 'core',
      availability: { always: true },
      approval: opts.approval ?? 'never',
    },
    executor: {
      async *execute(input) {
        yield { kind: 'output', chunk: await opts.execute(input) };
      },
    },
  };
}

function harness(opts: { approvalGate?: ApprovalGate } = {}) {
  const store = new MemoryEventStore();
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  tools.register(parallelTool);
  const kernel = new AgentKernel({
    store,
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker({ breakThreshold: 99, warnThreshold: 99 }),
    condenser: new NoopCondenser(),
    approvalGate: opts.approvalGate,
  });
  return { store, provider, tools, kernel };
}

async function drive(h: ReturnType<typeof harness>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const sid = await h.kernel.startSession({ model: 'fake-model', cwd: '/tmp' });
  h.kernel.subscribe(sid, null, (env: EventEnvelope) => events.push(env.event));
  await h.kernel.submitInput(sid, 'go', 'k1');
  return events;
}

/** 第二次推理请求里回填的 tool_result 内容(合并结果断言目标)。 */
function resultContent(provider: FakeProvider): { content: string; isError?: boolean } {
  const msgs = provider.seen[1]!.messages;
  const msg = msgs.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  const block = (Array.isArray(msg?.content) ? msg.content : []).find((b) => b.type === 'tool_result') as {
    content: string;
    isError?: boolean;
  };
  return block;
}

describe('parallel 工具 — 内核内联展开', () => {
  it('3 个只读子调用真并发(高水位=3),结果按序编号合并,子调用事件 id=外层id#序号', async () => {
    const h = harness();
    let active = 0;
    let maxActive = 0;
    h.tools.register(
      makeTool({
        name: 'probe',
        kind: 'read',
        execute: async (input) => {
          active++;
          maxActive = Math.max(maxActive, active);
          await waitUntil(() => active === 3, 200);
          active--;
          return `r${(input as { n: number }).n}`;
        },
      }),
    );
    h.provider.script(
      toolCallTurn('parallel', 'tu1', {
        calls: [
          { tool: 'probe', input: { n: 1 } },
          { tool: 'probe', input: { n: 2 } },
          { tool: 'probe', input: { n: 3 } },
        ],
      }),
    );
    h.provider.script(textTurn('done'));
    const events = await drive(h);
    expect(maxActive).toBe(3);
    const started = events.filter((e): e is Extract<AgentEvent, { kind: 'ToolCallStarted' }> => e.kind === 'ToolCallStarted');
    expect(started.map((e) => e.id)).toEqual(['tu1#1', 'tu1#2', 'tu1#3']);
    const r = resultContent(h.provider);
    expect(r.content).toContain('[1/3] probe\nr1');
    expect(r.content).toContain('[2/3] probe\nr2');
    expect(r.content).toContain('[3/3] probe\nr3');
    expect(r.isError).toBeUndefined();
  });

  it('子调用逐一走审批链:被拒的子调用不执行且标注,其余照常;部分失败整体不置 isError', async () => {
    // 只批 write 拒 danger(按工具名裁决)。
    const gate: ApprovalGate = {
      async request(req) {
        return { decision: req.tool === 'danger' ? 'reject_once' : 'allow_once' };
      },
    };
    const h = harness({ approvalGate: gate });
    const ran: string[] = [];
    h.tools.register(
      makeTool({
        name: 'danger',
        kind: 'execute',
        approval: 'always',
        execute: async () => {
          ran.push('danger');
          return 'boom';
        },
      }),
    );
    h.tools.register(
      makeTool({
        name: 'look',
        kind: 'read',
        execute: async () => {
          ran.push('look');
          return 'ok';
        },
      }),
    );
    h.provider.script(
      toolCallTurn('parallel', 'tu1', {
        calls: [
          { tool: 'look', input: {} },
          { tool: 'danger', input: {} },
        ],
      }),
    );
    h.provider.script(textTurn('done'));
    const events = await drive(h);
    expect(ran).toEqual(['look']); // danger 被拒未执行——审批链不可绕
    expect(events.some((e) => e.kind === 'ApprovalRequested')).toBe(true);
    const r = resultContent(h.provider);
    expect(r.content).toContain('[1/2] look\nok');
    expect(r.content).toContain('[2/2] danger（出错/被拒）');
    expect(r.content).toContain('用户拒绝了该工具调用');
    expect(r.isError).toBeUndefined(); // 部分失败:每段标注传达,不整体置错
  });

  it('未知子工具/嵌套 parallel → 对应段落报错;全部失败才整体 isError', async () => {
    const h = harness();
    h.provider.script(
      toolCallTurn('parallel', 'tu1', {
        calls: [
          { tool: 'no_such_tool', input: {} },
          { tool: 'parallel', input: { calls: [] } },
        ],
      }),
    );
    h.provider.script(textTurn('done'));
    await drive(h);
    const r = resultContent(h.provider);
    expect(r.content).toContain('[1/2] no_such_tool（出错/被拒）\n工具不在本 turn 可见集：no_such_tool');
    expect(r.content).toContain('[2/2] parallel（出错/被拒）\nparallel 不可嵌套');
    expect(r.isError).toBe(true);
  });

  it('calls 缺失/为空/超上限 → 整体可行动错误,不展开', async () => {
    const h = harness();
    h.tools.register(makeTool({ name: 'probe', kind: 'read', execute: async () => 'ok' }));
    h.provider.script(toolCallTurn('parallel', 'tu1', { calls: [] }));
    h.provider.script(
      toolCallTurn('parallel', 'tu2', { calls: Array.from({ length: 9 }, () => ({ tool: 'probe', input: {} })) }),
    );
    h.provider.script(textTurn('done'));
    await drive(h);
    const first = resultContent(h.provider);
    expect(first.content).toContain('calls 必须是非空数组');
    expect(first.isError).toBe(true);
    const msgs = h.provider.seen[2]!.messages;
    const all = JSON.stringify(msgs);
    expect(all).toContain('至多 8 个（收到 9）');
  });

  it('混入写类子调用:写作屏障,与前面的只读不同波(相对顺序保住)', async () => {
    const h = harness();
    const log: string[] = [];
    h.tools.register(
      makeTool({
        name: 'look',
        kind: 'read',
        execute: async () => {
          log.push('look');
          await sleep(10);
          return 'ok';
        },
      }),
    );
    h.tools.register(
      makeTool({
        name: 'put',
        kind: 'edit',
        execute: async () => {
          log.push('put');
          return 'ok';
        },
      }),
    );
    h.provider.script(
      toolCallTurn('parallel', 'tu1', {
        calls: [
          { tool: 'look', input: { n: 1 } },
          { tool: 'look', input: { n: 2 } },
          { tool: 'put', input: {} },
        ],
      }),
    );
    h.provider.script(textTurn('done'));
    await drive(h);
    expect(log).toEqual(['look', 'look', 'put']); // 写在两个只读之后(屏障波)
    const r = resultContent(h.provider);
    expect(r.content).toContain('[3/3] put\nok');
  });
});
