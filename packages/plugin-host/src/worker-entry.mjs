// 通用插件 Worker 运行时（4E / ADR-18）——**纯 ESM，无 TS 依赖**，故 `new Worker()` 无需 tsx loader 即可加载
// （绕开 4C 记录的 worker+tsx 脆弱性）。生产把它作 WorkerPluginTransport.entry；它据 workerData.modulePath
// 动态 import 插件模块（.mjs/.js）并按 protocol.ts 的消息契约跑 IPC：ready 握手 + 心跳 + invoke/hook 应答。
//
// 插件模块默认导出形状（与 sdk.ts definePlugin 返回值一致；插件也可不依赖 SDK 直接导出此形状）：
//   export default {
//     name: string,
//     tools?: [{ name, kind, description, inputSchema, approval?, handler(input, ctx) }],
//     hooks?: [{ point, handler(ctx, payload) }],
//   }
// tool handler 可返回 string / Promise<string> / AsyncIterable<string>（流式分片）；抛错 → done{isError}。
// hook handler：PreToolUse 返回 { decision:'allow'|'deny', input?, reason? } | void；其余观测型返回 void。
import { parentPort, workerData } from 'node:worker_threads';

const PROTOCOL = 1;
const port = parentPort;
if (!port) throw new Error('plugin worker 必须在 worker_threads 内运行');

const mod = await import(workerData.modulePath);
const plugin = mod.default ?? mod.plugin ?? mod;
if (!plugin || typeof plugin !== 'object') throw new Error('插件模块未默认导出有效对象');

const tools = new Map((plugin.tools ?? []).map((t) => [t.name, t]));
const hooks = new Map();
for (const h of plugin.hooks ?? []) {
  if (!hooks.has(h.point)) hooks.set(h.point, []);
  hooks.get(h.point).push(h.handler);
}

// ready 握手：上报清单（剥离 handler，只留可序列化声明）。
port.postMessage({
  type: 'ready',
  protocol: PROTOCOL,
  manifest: {
    name: plugin.name ?? workerData.id ?? 'plugin',
    tools: (plugin.tools ?? []).map((t) => ({
      name: t.name,
      kind: t.kind,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object' },
      ...(t.approval ? { approval: t.approval } : {}),
    })),
    hooks: [...hooks.keys()],
  },
});

// 心跳：周期上报存活；host 看门狗超时未收 → 判死降级。
let seq = 0;
const hb = setInterval(() => port.postMessage({ type: 'heartbeat', seq: ++seq }), workerData.heartbeatIntervalMs ?? 1000);
hb.unref?.();

port.on('message', (msg) => {
  if (msg?.type === 'invoke') void handleInvoke(msg);
  else if (msg?.type === 'hook') void handleHook(msg);
  else if (msg?.type === 'shutdown') {
    clearInterval(hb);
    port.close?.();
  }
});

async function handleInvoke(msg) {
  const t = tools.get(msg.tool);
  if (!t || typeof t.handler !== 'function') {
    port.postMessage({ type: 'done', id: msg.id, isError: true, error: `未知工具：${msg.tool}` });
    return;
  }
  try {
    const out = await t.handler(msg.input, msg.ctx);
    if (out != null && typeof out[Symbol.asyncIterator] === 'function') {
      for await (const chunk of out) port.postMessage({ type: 'chunk', id: msg.id, chunk: String(chunk) });
    } else if (out != null) {
      port.postMessage({ type: 'chunk', id: msg.id, chunk: String(out) });
    }
    port.postMessage({ type: 'done', id: msg.id });
  } catch (e) {
    port.postMessage({ type: 'done', id: msg.id, isError: true, error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleHook(msg) {
  const handlers = hooks.get(msg.point) ?? [];
  let decision;
  try {
    for (const h of handlers) {
      const r = await h(msg.ctx, msg.payload);
      if (msg.point === 'PreToolUse' && r && typeof r === 'object' && 'decision' in r) {
        decision = r;
        if (r.decision === 'deny') break; // deny 立即短路
      }
    }
  } catch {
    // hook 抛错：对主进程等价于「无裁决」（host 会放行；绝不让插件 hook 拖垮主 turn）。
    decision = undefined;
  }
  port.postMessage({ type: 'hook-result', id: msg.id, ...(decision ? { decision } : {}) });
}
