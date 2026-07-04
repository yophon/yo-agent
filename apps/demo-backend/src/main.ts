/**
 * 演示后端（PHASE-5 5D）—— 「后端只需要两样东西」的结构性示范：
 * 1. LLM 代理网关：POST /v1/* 流式透传上游（key 只存在于服务端 env，绝不下发前端）；
 * 2. 业务 API 按公开 API 标准暴露为工具：/api/tools/*，每个端点独立做令牌校验
 *    （agent loop 在客户端可被篡改——工具请求 = 用户直接调用，服务端必须自校验）。
 * 生产提示：本 demo 不含配额/滥用防护/审计，上线必须补；反向代理需关流缓冲（nginx: X-Accel-Buffering no）。
 *
 * env：PORT=8788 / DEMO_TOKEN=demo-123 / UPSTREAM_BASE=https://api.anthropic.com / UPSTREAM_KEY 或 ANTHROPIC_API_KEY/OPENAI_API_KEY
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8788);
const DEMO_TOKEN = process.env.DEMO_TOKEN ?? 'demo-123';
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE ?? 'https://api.anthropic.com').replace(/\/$/, '');
const UPSTREAM_KEY = process.env.UPSTREAM_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '';

// ───────────────────────── mock 业务数据 ─────────────────────────

const ORDERS: Record<string, { orderId: string; status: string; eta?: string; items: string[] }> = {
  '42': { orderId: '42', status: '已发货', eta: '明天 18:00 前', items: ['降噪耳机 ×1'] },
  '1001': { orderId: '1001', status: '待付款', items: ['机械键盘 ×1', 'USB-C 线 ×2'] },
  '7': { orderId: '7', status: '已签收', items: ['保温杯 ×1'] },
};
let ticketSeq = 1;

// ───────────────────────── 基础设施 ─────────────────────────

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-demo-token, x-api-key, authorization, anthropic-version');
  res.setHeader('access-control-max-age', '86400');
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 宿主鉴权示范：demo 用共享令牌，真实宿主换成自己的 cookie/JWT 校验。 */
function authed(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.headers['x-demo-token'] === DEMO_TOKEN) return true;
  json(res, 401, { error: '缺少或错误的 x-demo-token（demo 鉴权；宿主 app 换成自己的机制）' });
  return false;
}

// ───────────────────────── LLM 代理网关 ─────────────────────────

/** /v1/* 流式透传：Anthropic(/v1/messages)、OpenAI 兼容(/v1/chat/completions)、Responses(/v1/responses) 通吃。 */
async function proxyLlm(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  if (!authed(req, res)) return;
  if (!UPSTREAM_KEY) {
    json(res, 500, { error: '演示后端未配置上游 key：设 UPSTREAM_KEY（或 ANTHROPIC_API_KEY/OPENAI_API_KEY）' });
    return;
  }
  const body = await readBody(req);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // 两种上游鉴权头都带上（各家只认自己的，多余的被忽略）——key 只在这里出现。
    'x-api-key': UPSTREAM_KEY,
    authorization: `Bearer ${UPSTREAM_KEY}`,
  };
  const av = req.headers['anthropic-version'];
  if (typeof av === 'string') headers['anthropic-version'] = av;

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM_BASE}${pathname}`, { method: 'POST', headers, body });
  } catch (e) {
    json(res, 502, { error: `上游不可达：${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no', // 生产反代关缓冲的示范位
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  // 客户端断开 → 取消上游读（不再白烧上游 token）（审查 S5）。
  res.on('close', () => void reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value); // 逐 chunk flush，不缓冲整个响应——SSE 流式的关键
  }
  res.end();
}

// ───────────────────────── mock 客服工具 API ─────────────────────────

function orderQuery(res: http.ServerResponse, input: { orderId?: string }): void {
  const order = input.orderId ? ORDERS[input.orderId] : undefined;
  if (!order) {
    // 业务性「未找到」回 200 语义化结果（工具层 !ok 才算执行错误），LLM 可继续追问。
    json(res, 200, { found: false, message: `没有找到订单 ${input.orderId ?? ''}——请让用户确认订单号` });
    return;
  }
  json(res, 200, { found: true, ...order });
}

function ticketCreate(res: http.ServerResponse, input: { title?: string; detail?: string }): void {
  if (!input.title) {
    json(res, 400, { error: '缺少 title' });
    return;
  }
  const id = `TK-${String(ticketSeq++).padStart(4, '0')}`;
  json(res, 200, { ticketId: id, title: input.title, detail: input.detail ?? '', status: '已建单，工作日 24h 内跟进' });
}

// ───────────────────────── 路由 ─────────────────────────

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  try {
    if (req.method === 'POST' && pathname.startsWith('/v1/')) {
      await proxyLlm(req, res, pathname);
      return;
    }
    if (req.method === 'POST' && pathname.startsWith('/api/tools/')) {
      if (!authed(req, res)) return; // 每个工具端点独立鉴权——不是可选项
      const input = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      if (pathname === '/api/tools/order_query') {
        orderQuery(res, input);
        return;
      }
      if (pathname === '/api/tools/ticket_create') {
        ticketCreate(res, input);
        return;
      }
    }
    json(res, 404, { error: `未知端点：${req.method} ${pathname}` });
  } catch (e) {
    // 流式转发已发头后出错（上游中断）不能再 writeHead——直接断连，防 ERR_HTTP_HEADERS_SENT
    // 变 unhandledRejection 拖崩整个进程（审查 C1）。
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`demo-backend 启动: http://localhost:${PORT}`);
  console.log(`  LLM 代理: POST /v1/*  → ${UPSTREAM_BASE}（key ${UPSTREAM_KEY ? '已配' : '未配!'}）`);
  console.log('  工具:     POST /api/tools/order_query | /api/tools/ticket_create');
  console.log(`  鉴权:     x-demo-token: ${DEMO_TOKEN}`);
});
