/**
 * demo 装配（PHASE-5 5D）：设置面板 → createWebAgent（双模式）→ ChatController → <yo-chat>。
 * 模式 A：baseUrl 指 demo-backend，x-demo-token 宿主鉴权，挂 order_query/ticket_create 工具；
 * 模式 B：用户中转站直连（apiKey 默认只留内存；「记住」显式勾选才落 localStorage，明文风险已在 UI 标注）。
 */
import type { WebAgentConfig, WebProviderKind } from '@yo-agent/surface-web';
import { ChatController, createWebAgent, defineHttpTool } from '@yo-agent/surface-web';
import './yo-chat'; // 副作用导入：customElements.define('yo-chat')
import type { YoChatElement } from './yo-chat';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const val = (id: string): string => $<HTMLInputElement>(id).value.trim();

const SYSTEM_A = [
  '你是「yo 商城」的智能客服，友好、简洁、直接给结论。',
  '能查订单物流（order_query）、给用户建售后工单（ticket_create）。',
  '查不到订单时请让用户确认订单号；超出能力范围的请求就建工单转人工。',
].join('\n');

const STORE_KEY = 'yo-web-demo-config';

function demoTools(base: string, token: string) {
  const headers = () => ({ 'x-demo-token': token });
  return [
    defineHttpTool({
      name: 'order_query',
      description: '按订单号查询订单状态、物流与预计送达时间。',
      inputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string', description: '订单号，如 42' } },
        required: ['orderId'],
      },
      url: `${base}/api/tools/order_query`,
      headers,
    }),
    defineHttpTool({
      name: 'ticket_create',
      description: '为用户创建售后/人工跟进工单，返回工单号。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话概括问题' },
          detail: { type: 'string', description: '问题细节与用户诉求' },
        },
        required: ['title'],
      },
      url: `${base}/api/tools/ticket_create`,
      headers,
      kind: 'other', // 有副作用（建单），不进只读并发批
    }),
  ];
}

function buildConfig(): WebAgentConfig {
  const mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement).value;
  if (mode === 'A') {
    const base = val('a-base').replace(/\/$/, '');
    const token = val('a-token');
    const provider = $<HTMLSelectElement>('a-provider').value as WebProviderKind;
    return {
      connection: {
        provider,
        model: val('a-model'),
        // openai 系 provider 会自拼 /chat/completions 等，base 直接给根即可
        baseUrl: provider === 'anthropic' ? base : `${base}/v1`,
        headers: { 'x-demo-token': token },
      },
      system: SYSTEM_A,
      tools: $<HTMLInputElement>('a-tools').checked ? demoTools(base, token) : [],
    };
  }
  const provider = $<HTMLSelectElement>('b-provider').value as WebProviderKind;
  const headers: Record<string, string> = {};
  const base = val('b-base');
  // 官方 Anthropic 直连需显式声明浏览器访问；中转站多余头无害。
  if (provider === 'anthropic') headers['anthropic-dangerous-direct-browser-access'] = 'true';
  return {
    connection: {
      provider,
      model: val('b-model'),
      baseUrl: base || undefined,
      apiKey: val('b-key') || undefined,
      headers,
    },
    system: '你是一个乐于助人的中文助手，回答简洁。',
  };
}

function restore(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Record<string, string> | null;
    if (!saved) return;
    for (const [id, v] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = v;
    }
    $<HTMLInputElement>('b-remember').checked = true;
  } catch {
    /* 损坏的存档直接忽略 */
  }
}

function persistIfAsked(): void {
  if ($<HTMLInputElement>('b-remember').checked) {
    const ids = ['b-provider', 'b-base', 'b-key', 'b-model'];
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(ids.map((id) => [id, val(id)]))));
  } else {
    localStorage.removeItem(STORE_KEY);
  }
}

function switchPanels(): void {
  const mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement).value;
  $('panel-a').hidden = mode !== 'A';
  $('panel-b').hidden = mode !== 'B';
}

for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener('change', switchPanels);
restore();
switchPanels();

$<HTMLButtonElement>('apply').addEventListener('click', () => {
  const status = $('status');
  try {
    persistIfAsked();
    const controller = new ChatController(createWebAgent(buildConfig()));
    ($('chat') as YoChatElement).controller = controller;
    status.textContent = '已连接，可以开聊';
  } catch (e) {
    status.textContent = `配置错误：${e instanceof Error ? e.message : String(e)}`;
  }
});
