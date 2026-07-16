import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { RegisteredTool } from '@yo-agent/tools';
import { WeixinSurface, addAllowFrom } from '@yo-agent/surface-weixin';
import type { FetchLike, WeixinAccount, WeixinMessage } from '@yo-agent/surface-weixin';

const account: WeixinAccount = { accountId: 'bot-s', token: 'tok', baseUrl: 'https://gw.example', ownerUserId: 'owner', createdAt: 1 };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yo-wx-surf-'));
}

/** 出站网关 mock：记录 sendmessage / sendtyping，getconfig 发 ticket。 */
function gateway(): { fetchImpl: FetchLike; sent: Array<{ to: string; text: string; contextToken?: string }>; typing: number[] } {
  const sent: Array<{ to: string; text: string; contextToken?: string }> = [];
  const typing: number[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.includes('sendmessage')) {
      const msg = body.msg as { to_user_id: string; context_token?: string; item_list?: Array<{ text_item?: { text?: string } }> };
      sent.push({ to: msg.to_user_id, text: msg.item_list?.[0]?.text_item?.text ?? '', ...(msg.context_token ? { contextToken: msg.context_token } : {}) });
      return new Response('{"ret":0}');
    }
    if (url.includes('getconfig')) return new Response('{"ret":0,"typing_ticket":"tk"}');
    if (url.includes('sendtyping')) {
      typing.push((body as { status: number }).status);
      return new Response('{"ret":0}');
    }
    return new Response('{"ret":0}');
  };
  return { fetchImpl, sent, typing };
}

function harness(opts: { stateDir?: string; allowAll?: boolean } = {}) {
  const provider = new FakeProvider();
  const tools = new InMemoryToolRegistry();
  const kernel = new AgentKernel({
    store: new MemoryEventStore(),
    provider,
    tools,
    loopBreaker: new HistoryLoopBreaker(),
    condenser: new NoopCondenser(),
    model: 'fake-model',
    cwd: '/tmp',
  });
  const gw = gateway();
  const surface = new WeixinSurface({
    kernel,
    account,
    stateDir: opts.stateDir ?? tmpDir(),
    allowAll: opts.allowAll ?? false,
    fetchImpl: gw.fetchImpl,
  });
  return { provider, tools, kernel, gw, surface };
}

function inbound(text: string, opts: { from?: string; id?: number; ctx?: string; type?: number; group?: string } = {}): WeixinMessage {
  return {
    message_id: opts.id ?? Math.floor(Math.random() * 1e9),
    from_user_id: opts.from ?? 'owner',
    message_type: opts.type ?? 1,
    ...(opts.group ? { group_id: opts.group } : {}),
    ...(opts.ctx ? { context_token: opts.ctx } : {}),
    item_list: [{ type: 1, text_item: { text } }],
  };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('6b WeixinSurface 端到端（真内核 + FakeProvider + mock 网关）', () => {
  it('好友文本 → 内核 turn → FINISH 回复（context_token 回传 + typing 起止 + 确定性会话 id）', async () => {
    const h = harness();
    h.provider.script(textTurn('订单 42 已发货'));
    await h.surface.handleMessage(inbound('订单 42 到哪了', { ctx: 'ctx-1' }));
    await until(() => h.gw.sent.length === 1);
    expect(h.gw.sent[0]).toEqual({ to: 'owner', text: '订单 42 已发货', contextToken: 'ctx-1' });
    expect(h.gw.typing).toEqual([1, 2]); // turn 起止各一次
    expect(h.kernel.listSessions().map((s) => s.sessionId)).toEqual(['wx-bot-s-owner']);
  });

  it('同好友连发两条：内核队列串行（第二 turn 带第一轮上下文），回复按序', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tool: RegisteredTool = {
      descriptor: { name: 'gate', kind: 'other', description: 'g', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval: 'never' },
      executor: {
        async *execute() {
          await gate;
          yield { kind: 'output' as const, chunk: 'ok' };
        },
      },
    };
    h.tools.register(tool);
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('答一'));
    h.provider.script(textTurn('答二'));

    await h.surface.handleMessage(inbound('第一问', { id: 1 }));
    await h.surface.handleMessage(inbound('第二问', { id: 2 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.gw.sent).toHaveLength(0); // 第一 turn 还挂在 gate；第二条在内核队列排队未跑
    release();
    await until(() => h.gw.sent.length === 2);
    expect(h.gw.sent.map((s) => s.text)).toEqual(['答一', '答二']);
    expect(JSON.stringify(h.provider.seen[h.provider.seen.length - 1]!.messages)).toContain('第一问'); // 串行同会话带上下文
  });

  it('授权门：名单外发件人一次性提示不进内核；allow 落名单后放行；机主恒过', async () => {
    const dir = tmpDir();
    const h = harness({ stateDir: dir });
    await h.surface.handleMessage(inbound('在吗', { from: 'stranger', id: 11 }));
    await h.surface.handleMessage(inbound('在吗？', { from: 'stranger', id: 12 }));
    await until(() => h.gw.sent.length === 1); // 提示只发一次
    expect(h.gw.sent[0]!.text).toContain('yoagent weixin allow bot-s stranger');
    expect(h.kernel.listSessions()).toHaveLength(0); // 未进内核

    addAllowFrom('bot-s', 'stranger', dir);
    h.provider.script(textTurn('你好'));
    await h.surface.handleMessage(inbound('现在呢', { from: 'stranger', id: 13 }));
    await until(() => h.gw.sent.length === 2);
    expect(h.kernel.listSessions().map((s) => s.sessionId)).toEqual(['wx-bot-s-stranger']);
  });

  it('过滤面：BOT 消息防回环、群消息跳过、纯媒体跳过；语音转文字可消费', async () => {
    const h = harness();
    await h.surface.handleMessage(inbound('自发回显', { type: 2 }));
    await h.surface.handleMessage(inbound('群消息', { group: 'g1' }));
    await h.surface.handleMessage({ message_id: 21, from_user_id: 'owner', message_type: 1, item_list: [{ type: 2, image_item: {} }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.kernel.listSessions()).toHaveLength(0);

    h.provider.script(textTurn('听到了'));
    await h.surface.handleMessage({ message_id: 22, from_user_id: 'owner', message_type: 1, item_list: [{ type: 3, voice_item: { text: '帮我查下天气' } }] });
    await until(() => h.gw.sent.length === 1);
    expect(JSON.stringify(h.provider.seen[0]!.messages)).toContain('帮我查下天气');
  });

  it('超长回复按 2000 字切段顺序发送', async () => {
    const h = harness();
    h.provider.script(textTurn('长'.repeat(4500)));
    await h.surface.handleMessage(inbound('来个长的', { id: 31 }));
    await until(() => h.gw.sent.length === 3);
    expect(h.gw.sent.map((s) => s.text.length)).toEqual([2000, 2000, 500]);
  });
});
