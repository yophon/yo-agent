/** 真机端到端（模式 A）：与 web-demo 完全相同的 surface-web 装配，走 demo-backend 代理 + 工具。 */
import { ChatController, createWebAgent, defineHttpTool } from '@yo-agent/surface-web';

const BASE = 'http://localhost:8788';
const token = 'demo-123';
const headers = () => ({ 'x-demo-token': token });

const agent = createWebAgent({
  connection: { provider: 'openai', model: 'gpt-5.5', baseUrl: `${BASE}/v1`, headers: { 'x-demo-token': token } },
  system: '你是「yo 商城」的智能客服，能查订单（order_query）。回答简洁。',
  tools: [
    defineHttpTool({
      name: 'order_query',
      description: '按订单号查询订单状态、物流与预计送达时间。',
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      url: `${BASE}/api/tools/order_query`,
      headers,
    }),
  ],
});

const c = new ChatController(agent);
c.onChange((s) => {
  const last = s.messages[s.messages.length - 1];
  if (last)
    process.stdout.write(
      `\r[turnActive=${s.turnActive}] parts=${JSON.stringify(last.parts.map((p) => (p.type === 'tool' ? `tool:${p.name}:${p.status}` : 'text'))).slice(0, 120)}   `,
    );
});
await c.send('订单 42 到哪了？');
console.log('\n--- 最终状态 ---');
const assistant = c.state.messages[1];
const toolPart = assistant?.parts.find((p) => p.type === 'tool');
const textParts = assistant?.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
console.log('工具调用:', toolPart && toolPart.type === 'tool' ? `${toolPart.name} → ${toolPart.status} | ${toolPart.output.slice(0, 120)}` : '（无）');
console.log('回答:', textParts);
console.log('error:', c.state.error ?? '（无）');
console.log('totals:', JSON.stringify(c.state.totals));
const pass =
  toolPart?.type === 'tool' && toolPart.status === 'ok' && !!textParts && /发货|18:00|明天/.test(textParts) && !c.state.error;
console.log(pass ? '✅ E2E 模式 A 通过：LLM 经代理流式回答 + 调工具 + 结果进答案' : '❌ E2E 未达标');
process.exit(pass ? 0 : 1);
