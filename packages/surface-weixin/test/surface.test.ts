import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentKernel, HistoryLoopBreaker, NoopCondenser } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import type { RegisteredTool } from '@yo-agent/tools';
import { WeixinSurface, addAllowFrom, encryptAesEcb, loadAllowList } from '@yo-agent/surface-weixin';
import type { FetchLike, WeixinAccount, WeixinMessage } from '@yo-agent/surface-weixin';

const account: WeixinAccount = { accountId: 'bot-s', token: 'tok', baseUrl: 'https://gw.example', ownerUserId: 'owner', createdAt: 1 };
const CDN = 'https://cdn.example/c2c';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yo-wx-surf-'));
}

interface SentItem {
  to: string;
  type: number;
  text: string;
  runId?: string;
  contextToken?: string;
  tool?: { name?: string; id?: string; status?: string };
}

/** 出站网关 mock：记录 sendmessage（全部 item）/ sendtyping，getconfig 发 ticket；CDN 下载按 url 表回密文。 */
function gateway(cdnFiles: Record<string, Buffer> = {}): {
  fetchImpl: FetchLike;
  /** 仅文本 item（6b 既有断言面）。 */
  sent: Array<{ to: string; text: string; contextToken?: string }>;
  /** 全部 item（6c 工具进度/顺序断言）。 */
  items: SentItem[];
  typing: number[];
} {
  const sent: Array<{ to: string; text: string; contextToken?: string }> = [];
  const items: SentItem[] = [];
  const typing: number[] = [];
  let serverId = 1000;
  const fetchImpl: FetchLike = async (url, init) => {
    if (init.method === 'GET' && url.startsWith(CDN)) {
      const hit = Object.entries(cdnFiles).find(([k]) => url.includes(k));
      return hit ? new Response(new Uint8Array(hit[1])) : new Response('nope', { status: 404 });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.includes('sendmessage')) {
      const msg = body.msg as {
        to_user_id: string;
        context_token?: string;
        run_id?: string;
        item_list?: Array<{
          type?: number;
          text_item?: { text?: string };
          tool_call_start_item?: { tool_name?: string; tool_call_id?: string };
          tool_call_result_item?: { tool_name?: string; tool_call_id?: string; status?: string };
        }>;
      };
      const it = msg.item_list?.[0] ?? {};
      const tool = it.tool_call_start_item ?? it.tool_call_result_item;
      const status = it.tool_call_result_item?.status;
      items.push({
        to: msg.to_user_id,
        type: it.type ?? 0,
        text: it.text_item?.text ?? '',
        ...(msg.run_id ? { runId: msg.run_id } : {}),
        ...(msg.context_token ? { contextToken: msg.context_token } : {}),
        ...(tool ? { tool: { name: tool.tool_name, id: tool.tool_call_id, ...(status !== undefined ? { status } : {}) } } : {}),
      });
      if (it.type === 1) sent.push({ to: msg.to_user_id, text: it.text_item?.text ?? '', ...(msg.context_token ? { contextToken: msg.context_token } : {}) });
      // 服务端 message_id 为 uint64 裸数字：顺手覆盖无损解析（> 2^53）
      return new Response(`{"ret":0,"message_id":${++serverId}0000000000000}`);
    }
    if (url.includes('getconfig')) return new Response('{"ret":0,"typing_ticket":"tk"}');
    if (url.includes('sendtyping')) {
      typing.push((body as { status: number }).status);
      return new Response('{"ret":0}');
    }
    return new Response('{"ret":0}');
  };
  return { fetchImpl, sent, items, typing };
}

function harness(opts: { stateDir?: string; allowAll?: boolean; pairingCode?: string; mediaDir?: string; cdnFiles?: Record<string, Buffer>; progressMessages?: boolean } = {}) {
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
  const gw = gateway(opts.cdnFiles);
  const surface = new WeixinSurface({
    kernel,
    account,
    stateDir: opts.stateDir ?? tmpDir(),
    allowAll: opts.allowAll ?? false,
    fetchImpl: gw.fetchImpl,
    cdnBaseUrl: CDN,
    mediaDir: opts.mediaDir ?? path.join(tmpDir(), 'media'),
    ...(opts.pairingCode ? { pairingCode: opts.pairingCode } : {}),
    ...(opts.progressMessages !== undefined ? { progressMessages: opts.progressMessages } : {}),
  });
  return { provider, tools, kernel, gw, surface };
}

function inbound(text: string, opts: { from?: string; id?: number | string; ctx?: string; type?: number; group?: string } = {}): WeixinMessage {
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

/** 可被 gate 卡住的工具（并发/顺序测试用）。 */
function gatedTool(name: string): { tool: RegisteredTool; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tool: RegisteredTool = {
    descriptor: { name, kind: 'other', description: 'g', inputSchema: { type: 'object' }, owner: 'core', availability: { always: true }, approval: 'never' },
    executor: {
      async *execute() {
        await gate;
        yield { kind: 'output' as const, chunk: 'ok' };
      },
    },
  };
  return { tool, release };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const lastPrompt = (p: FakeProvider): string => JSON.stringify(p.seen[p.seen.length - 1]!.messages);

describe('6b WeixinSurface 端到端（真内核 + FakeProvider + mock 网关）', () => {
  it('好友文本 → 内核 turn → FINISH 回复（context_token 回传 + typing 起止 + 确定性会话 id + run_id=turnId）', async () => {
    const h = harness();
    h.provider.script(textTurn('订单 42 已发货'));
    await h.surface.handleMessage(inbound('订单 42 到哪了', { ctx: 'ctx-1' }));
    await until(() => h.gw.sent.length === 1);
    expect(h.gw.sent[0]).toEqual({ to: 'owner', text: '订单 42 已发货', contextToken: 'ctx-1' });
    expect(h.gw.typing).toEqual([1, 2]); // turn 起止各一次
    expect(h.kernel.listSessions().map((s) => s.sessionId)).toEqual(['wx-bot-s-owner']);
    const turnId = (await collect(h.kernel.events.read('wx-bot-s-owner'))).find((e) => e.event.kind === 'TurnStarted')!.turnId;
    expect(h.gw.items[0]!.runId).toBe(turnId);
  });

  it('同好友连发两条：内核队列串行（第二 turn 带第一轮上下文），回复按序', async () => {
    const h = harness();
    const { tool, release } = gatedTool('gate');
    h.tools.register(tool);
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('答一'));
    h.provider.script(textTurn('答二'));

    await h.surface.handleMessage(inbound('第一问', { id: 1 }));
    await h.surface.handleMessage(inbound('第二问', { id: 2 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.gw.sent).toHaveLength(0); // 第一 turn 还挂在 gate；第二条在内核队列排队未跑（工具进度 item 不算文本）
    release();
    await until(() => h.gw.sent.length === 2);
    expect(h.gw.sent.map((s) => s.text)).toEqual(['答一', '答二']);
    expect(lastPrompt(h.provider)).toContain('第一问'); // 串行同会话带上下文
  });

  it('授权门：名单外发件人一次性提示不进内核；allow 落名单后放行；机主恒过', async () => {
    const dir = tmpDir();
    const h = harness({ stateDir: dir });
    await h.surface.handleMessage(inbound('在吗', { from: 'stranger', id: 11 }));
    await h.surface.handleMessage(inbound('在吗？', { from: 'stranger', id: 12 }));
    await until(() => h.gw.sent.length === 1); // 提示只发一次
    expect(h.gw.sent[0]!.text).toContain('yoagent weixin allow bot-s stranger');
    expect(h.gw.sent[0]!.text).not.toContain('配对'); // 未开配对码不提
    expect(h.kernel.listSessions()).toHaveLength(0); // 未进内核

    addAllowFrom('bot-s', 'stranger', dir);
    h.provider.script(textTurn('你好'));
    await h.surface.handleMessage(inbound('现在呢', { from: 'stranger', id: 13 }));
    await until(() => h.gw.sent.length === 2);
    expect(h.kernel.listSessions().map((s) => s.sessionId)).toEqual(['wx-bot-s-stranger']);
  });

  it('过滤面：BOT 消息防回环、群消息跳过、空壳媒体跳过；语音转文字可消费', async () => {
    const h = harness();
    await h.surface.handleMessage(inbound('自发回显', { type: 2 }));
    await h.surface.handleMessage(inbound('群消息', { group: 'g1' }));
    await h.surface.handleMessage({ message_id: 21, from_user_id: 'owner', message_type: 1, item_list: [{ type: 2, image_item: {} }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.kernel.listSessions()).toHaveLength(0);

    h.provider.script(textTurn('听到了'));
    await h.surface.handleMessage({ message_id: 22, from_user_id: 'owner', message_type: 1, item_list: [{ type: 3, voice_item: { text: '帮我查下天气' } }] });
    await until(() => h.gw.sent.length === 1);
    expect(lastPrompt(h.provider)).toContain('帮我查下天气');
  });

  it('超长回复按 2000 字切段顺序发送', async () => {
    const h = harness();
    h.provider.script(textTurn('长'.repeat(4500)));
    await h.surface.handleMessage(inbound('来个长的', { id: 31 }));
    await until(() => h.gw.sent.length === 3);
    expect(h.gw.sent.map((s) => s.text.length)).toEqual([2000, 2000, 500]);
  });
});

describe('6c 媒体 / 引用 / 工具进度 / 配对码', () => {
  it('图片：CDN 下载 + AES-128-ECB 解密 → 落媒体目录（按魔数定 .png）→ prompt 带路径与「不能看图」说明', async () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
    const mediaDir = path.join(tmpDir(), 'media');
    const h = harness({ mediaDir, cdnFiles: { 'encrypted_query_param=img-1': encryptAesEcb(png, key) } });
    h.provider.script(textTurn('收到图了'));
    await h.surface.handleMessage({
      message_id: 41,
      from_user_id: 'owner',
      message_type: 1,
      item_list: [
        { type: 1, text_item: { text: '看下这张' } },
        { type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'img-1' } } },
      ],
    });
    await until(() => h.gw.sent.length === 1);
    const files = fs.readdirSync(mediaDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.png$/);
    expect(fs.readFileSync(path.join(mediaDir, files[0]!))).toEqual(png); // 解密后逐字节等于原图
    const prompt = lastPrompt(h.provider);
    expect(prompt).toContain('看下这张');
    expect(prompt).toContain('用户发来图片，已保存到');
    expect(prompt).toContain(files[0]);
    expect(prompt).toContain('不能直接看图');
  });

  it('文件：aes_key 为 base64(hex 串) 形态；原名安全化落盘；下载失败降级为提示不丢消息', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const doc = Buffer.from('hello,world\n1,2\n');
    const mediaDir = path.join(tmpDir(), 'media');
    const h = harness({ mediaDir, cdnFiles: { 'encrypted_query_param=file-1': encryptAesEcb(doc, key) } });
    h.provider.script(textTurn('看到文件'));
    await h.surface.handleMessage({
      message_id: 42,
      from_user_id: 'owner',
      message_type: 1,
      item_list: [
        {
          type: 4,
          file_item: { file_name: '../../evil/数据.csv', media: { encrypt_query_param: 'file-1', aes_key: Buffer.from(key.toString('hex')).toString('base64') } },
        },
      ],
    });
    await until(() => h.gw.sent.length === 1);
    const files = fs.readdirSync(mediaDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-数据\.csv$/); // 路径段被剥掉，不逃逸
    expect(fs.readFileSync(path.join(mediaDir, files[0]!), 'utf8')).toBe('hello,world\n1,2\n');
    expect(lastPrompt(h.provider)).toContain('read 工具读取');

    h.provider.script(textTurn('没拿到'));
    await h.surface.handleMessage({
      message_id: 43,
      from_user_id: 'owner',
      message_type: 1,
      item_list: [{ type: 4, file_item: { file_name: 'x.bin', media: { encrypt_query_param: 'missing', aes_key: 'AAAA' } } }],
    });
    await until(() => h.gw.sent.length === 2);
    expect(lastPrompt(h.provider)).toContain('下载失败');
    expect(fs.readdirSync(mediaDir)).toHaveLength(1); // 失败不落盘
  });

  it('引用回复：ref_msg 指向用户自己的消息 → parentId=该 UserMessage cursor；指向 bot 回复 → parentId=该轮 TurnCompleted cursor；prompt 带引用摘要', async () => {
    const h = harness();
    h.provider.script(textTurn('第一答'));
    await h.surface.handleMessage(inbound('第一问', { id: '9007199254740993' })); // > 2^53，字符串形态
    await until(() => h.gw.sent.length === 1);
    const sid = 'wx-bot-s-owner';
    const log1 = await collect(h.kernel.events.read(sid));
    const firstUser = log1.find((e) => e.event.kind === 'UserMessage')!;
    const firstDone = log1.find((e) => e.event.kind === 'TurnCompleted')!;

    // 引用用户自己的第一问（svr_id = 入站 message_id）
    h.provider.script(textTurn('第二答'));
    await h.surface.handleMessage({
      message_id: 52,
      from_user_id: 'owner',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: '补充一下' }, ref_msg: { svr_id: '9007199254740993', title: '第一问' } }],
    });
    await until(() => h.gw.sent.length === 2);
    const log2 = await collect(h.kernel.events.read(sid));
    const secondUser = log2.filter((e) => e.event.kind === 'UserMessage')[1]!;
    expect(secondUser.parentId).toBe(firstUser.cursor);
    expect(secondUser.event.kind === 'UserMessage' ? secondUser.event.text : '').toBe('> 用户引用了这条消息：第一问\n补充一下');

    // 引用 bot 的第一答（svr_id = 网关回的 message_id，uint64 无损）
    h.provider.script(textTurn('第三答'));
    await h.surface.handleMessage({
      message_id: 53,
      from_user_id: 'owner',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: '这句什么意思' }, ref_msg: { svr_id: '10010000000000000', message_item: { type: 1, text_item: { text: '第一答' } } } }],
    });
    await until(() => h.gw.sent.length === 3);
    const log3 = await collect(h.kernel.events.read(sid));
    const thirdUser = log3.filter((e) => e.event.kind === 'UserMessage')[2]!;
    expect(thirdUser.parentId).toBe(firstDone.cursor);

    // 对不上的引用（历史/未缓存）：parentId 为 null，摘要照进 prompt
    h.provider.script(textTurn('第四答'));
    await h.surface.handleMessage({
      message_id: 54,
      from_user_id: 'owner',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: '还有这个' }, ref_msg: { svr_id: '1' } }],
    });
    await until(() => h.gw.sent.length === 4);
    const log4 = await collect(h.kernel.events.read(sid));
    const fourthUser = log4.filter((e) => e.event.kind === 'UserMessage')[3]!;
    expect(fourthUser.parentId).toBeNull();
    expect(lastPrompt(h.provider)).toContain('内容未附带');
  });

  it('工具进度：ToolCallStarted/Completed → TOOL_CALL_START/RESULT item（同 run_id、同 tool_call_id、状态 completed）且先于正文出站；可关', async () => {
    const h = harness();
    const { tool, release } = gatedTool('gate');
    h.tools.register(tool);
    h.provider.script(toolCallTurn('gate', 'tu1', {}));
    h.provider.script(textTurn('做完了'));
    await h.surface.handleMessage(inbound('干活', { id: 61 }));
    await until(() => h.gw.items.some((i) => i.type === 11));
    expect(h.gw.items.map((i) => i.type)).toEqual([11]); // 工具卡住：只有 START
    release();
    await until(() => h.gw.sent.length === 1);
    expect(h.gw.items.map((i) => i.type)).toEqual([11, 12, 1]);
    const [start, result, text] = h.gw.items as [SentItem, SentItem, SentItem];
    expect(start.tool).toEqual({ name: 'gate', id: 'tu1' });
    expect(result.tool).toEqual({ name: 'gate', id: 'tu1', status: 'completed' });
    expect(new Set([start.runId, result.runId, text.runId]).size).toBe(1); // 同一 run_id
    expect(text.text).toBe('做完了');

    const h2 = harness({ progressMessages: false });
    const g2 = gatedTool('gate');
    h2.tools.register(g2.tool);
    g2.release();
    h2.provider.script(toolCallTurn('gate', 'tu2', {}));
    h2.provider.script(textTurn('静默'));
    await h2.surface.handleMessage(inbound('干活', { id: 62 }));
    await until(() => h2.gw.sent.length === 1);
    expect(h2.gw.items.map((i) => i.type)).toEqual([1]);
  });

  it('配对码：陌生人「配对 <码>」命中 → 落名单 + 回执 + 后续进内核；码错 → 提示；提示文案含配对引导', async () => {
    const dir = tmpDir();
    const h = harness({ stateDir: dir, pairingCode: '246810' });
    await h.surface.handleMessage(inbound('你好', { from: 'stranger', id: 71 }));
    await until(() => h.gw.sent.length === 1);
    expect(h.gw.sent[0]!.text).toContain('配对 <码>');

    await h.surface.handleMessage(inbound('配对 000000', { from: 'stranger', id: 72 }));
    await until(() => h.gw.sent.length === 2);
    expect(h.gw.sent[1]!.text).toContain('配对码不正确');
    expect(loadAllowList('bot-s', dir)).toEqual([]);

    await h.surface.handleMessage(inbound('/pair 246810', { from: 'stranger', id: 73 }));
    await until(() => h.gw.sent.length === 3);
    expect(h.gw.sent[2]!.text).toContain('配对成功');
    expect(loadAllowList('bot-s', dir)).toEqual(['stranger']);
    expect(h.kernel.listSessions()).toHaveLength(0); // 配对命令本身不进内核

    h.provider.script(textTurn('欢迎'));
    await h.surface.handleMessage(inbound('现在可以了吗', { from: 'stranger', id: 74 }));
    await until(() => h.gw.sent.length === 4);
    expect(h.gw.sent[3]!.text).toBe('欢迎');
  });
});
