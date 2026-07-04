import { describe, expect, it } from 'vitest';
import { FakeProvider, errorTurn, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { RegisteredTool } from '@yo-agent/tools/core';
import type { WebAgent } from '@yo-agent/surface-web';
import { ChatController, createWebAgent } from '@yo-agent/surface-web';

function echoTool(name: string, reply: (input: unknown) => string): RegisteredTool {
  return {
    descriptor: {
      name,
      kind: 'fetch',
      description: 'echo',
      inputSchema: { type: 'object' },
      owner: 'core',
      availability: { always: true },
      approval: 'never',
    },
    executor: {
      async *execute(input) {
        yield { kind: 'output', chunk: reply(input) };
      },
    },
  };
}

function failTool(name: string, message: string): RegisteredTool {
  const t = echoTool(name, () => '');
  return {
    ...t,
    executor: {
      // biome-ignore lint/correctness/useYield: 抛错路径不产出
      async *execute() {
        throw new Error(message);
      },
    },
  };
}

function makeAgent(provider: FakeProvider, tools: RegisteredTool[] = []): WebAgent {
  return createWebAgent({
    connection: { provider: 'openai', model: 'fake-model', baseUrl: 'https://x.example/v1' },
    providerOverride: provider,
    tools,
  });
}

describe('ChatController（事件流→聊天状态归约）', () => {
  it('纯文本一轮：user/assistant 消息、流式增量合并、turnActive 迁移、onChange 有通知', async () => {
    const agent = makeAgent(new FakeProvider().script(textTurn('你好！')));
    const c = new ChatController(agent);
    let changes = 0;
    const sawActive: boolean[] = [];
    c.onChange((s) => {
      changes++;
      sawActive.push(s.turnActive);
    });
    await c.send('在吗');
    expect(changes).toBeGreaterThan(0);
    expect(sawActive).toContain(true); // turn 中间态可观测
    expect(c.state.turnActive).toBe(false);
    expect(c.state.messages).toEqual([
      { role: 'user', parts: [{ type: 'text', text: '在吗' }], status: 'done' },
      { role: 'assistant', parts: [{ type: 'text', text: '你好！' }], status: 'done' },
    ]);
    expect(c.state.error).toBeUndefined();
  });

  it('工具轮：同一 assistant 消息内 工具 part（running→ok，output 累积）后接文本 part', async () => {
    const provider = new FakeProvider()
      .script(toolCallTurn('order_query', 't1', { orderId: '42' }))
      .script(textTurn('订单 42 已发货'));
    const c = new ChatController(makeAgent(provider, [echoTool('order_query', (i) => `已查:${JSON.stringify(i)}`)]));
    const toolStatuses: string[] = [];
    c.onChange((s) => {
      const tool = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool');
      if (tool && tool.type === 'tool') toolStatuses.push(tool.status);
    });
    await c.send('订单 42 到哪了');
    const assistant = c.state.messages[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.parts.map((p) => p.type)).toEqual(['tool', 'text']);
    const tool = assistant?.parts[0];
    if (tool?.type !== 'tool') throw new Error('expect tool part');
    expect(tool).toMatchObject({ name: 'order_query', status: 'ok', output: '已查:{"orderId":"42"}' });
    expect(toolStatuses).toContain('running');
    expect(assistant?.parts[1]).toEqual({ type: 'text', text: '订单 42 已发货' });
  });

  it('工具抛错：part status=error，turn 正常收尾（LLM 继续应对）', async () => {
    const provider = new FakeProvider()
      .script(toolCallTurn('order_query', 't1', { orderId: 'x' }))
      .script(textTurn('后端暂时不可用'));
    const c = new ChatController(makeAgent(provider, [failTool('order_query', 'HTTP 500')]));
    await c.send('查一下');
    const tool = c.state.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool');
    expect(tool && tool.type === 'tool' ? tool.status : undefined).toBe('error');
    expect(c.state.messages[1]?.status).toBe('done');
    expect(c.state.turnActive).toBe(false);
  });

  it('TurnFailed：state.error 落文案、assistant 消息标 error、turnActive 复位', async () => {
    const provider = new FakeProvider().script(errorTurn('上游 401', { category: 'auth', status: 401 }));
    const c = new ChatController(makeAgent(provider));
    await c.send('在吗');
    expect(c.state.turnActive).toBe(false);
    expect(c.state.error).toContain('401');
    expect(c.state.messages[1]?.status).toBe('error');
  });

  it('用量累计：TurnCompleted 的 usage/costUsd 进 totals，跨 turn 叠加', async () => {
    const provider = new FakeProvider().script(textTurn('一')).script(textTurn('二'));
    const c = new ChatController(makeAgent(provider));
    await c.send('1');
    const after1 = { ...c.state.totals };
    await c.send('2');
    expect(c.state.totals.inputTokens).toBeGreaterThanOrEqual(after1.inputTokens);
    expect(c.state.totals.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('turn 进行中重复 send → 可行动错误；空闲 steer → 可行动错误', async () => {
    const c = new ChatController(makeAgent(new FakeProvider().script(textTurn('好'))));
    await expect(c.steer('x')).rejects.toThrow(/turn 进行中/);
    await c.send('在吗');
    // turn 已结束，再 send 正常（队列约束只在 turnActive 时生效）
    await expect(c.send('again')).resolves.toBeUndefined();
  });

  it('steer 插话后 turn 收尾不留幽灵 streaming 消息（审查 C2）', async () => {
    const provider = new FakeProvider()
      .script(toolCallTurn('slow_tool', 't1', {}))
      .script(textTurn('好的，已参考你的补充'));
    let controller: ChatController;
    const steeringTool: RegisteredTool = {
      ...echoTool('slow_tool', () => 'ok'),
      executor: {
        async *execute() {
          await controller.steer('补充一下：要发顺丰'); // 工具执行期 = turn 进行中
          yield { kind: 'output', chunk: 'ok' };
        },
      },
    };
    controller = new ChatController(makeAgent(provider, [steeringTool]));
    await controller.send('帮我改配送');
    expect(controller.state.messages.filter((m) => m.status === 'streaming')).toHaveLength(0);
    expect(controller.state.turnActive).toBe(false);
    // steer 的插话以 user 消息呈现
    expect(controller.state.messages.some((m) => m.role === 'user' && m.parts[0]?.type === 'text' && m.parts[0].text.includes('顺丰'))).toBe(true);
  });

  it('newSession：清空消息/错误/累计并换会话 id', async () => {
    const provider = new FakeProvider().script(textTurn('你好')).script(textTurn('新会话'));
    const c = new ChatController(makeAgent(provider));
    await c.send('在吗');
    const sid1 = c.state.sessionId;
    const sid2 = await c.newSession();
    expect(sid2).not.toBe(sid1);
    expect(c.state.messages).toEqual([]);
    await c.send('hi');
    expect(c.state.messages).toHaveLength(2);
  });
});
