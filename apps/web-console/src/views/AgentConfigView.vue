<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { notifyAgentChanged } from '../composables/use-chat';
import { parseHeaders, stringifyHeaders, testConnection, validateAgent } from '../services/agent-form';
import { app } from '../services/app-state';
import type { AgentConfigRecord, DeclarativeHttpTool } from '../services/types';
import { AGENT_COLORS, demoToolTemplates, newAgentRecord } from '../services/types';

const route = useRoute();
const router = useRouter();

const isNew = computed(() => route.path === '/agents/new');
const rec = reactive<AgentConfigRecord>(newAgentRecord());
const connHeadersText = ref('');
const toolHeaderTexts = reactive<string[]>([]);
const errors = ref<string[]>([]);
const testResult = ref('');
const saving = ref(false);

function load(): void {
  const source = isNew.value ? newAgentRecord() : app.agentById(String(route.params.id));
  if (!source) {
    void router.replace('/agents/new');
    return;
  }
  Object.assign(rec, JSON.parse(JSON.stringify(source)) as AgentConfigRecord);
  connHeadersText.value = stringifyHeaders(rec.connection.headers);
  toolHeaderTexts.splice(0, toolHeaderTexts.length, ...rec.tools.map((t) => stringifyHeaders(t.headers)));
  errors.value = [];
  testResult.value = '';
}
watch(() => route.fullPath, load, { immediate: true });

function syncHeaders(): void {
  rec.connection.headers = parseHeaders(connHeadersText.value);
  rec.tools.forEach((t, i) => {
    t.headers = parseHeaders(toolHeaderTexts[i] ?? '');
  });
}

function addTool(tool?: DeclarativeHttpTool): void {
  rec.tools.push(
    tool ?? { name: '', description: '', inputSchemaJson: '{\n  "type": "object",\n  "properties": {}\n}', url: '', method: 'POST', headers: {} },
  );
  toolHeaderTexts.push(tool ? stringifyHeaders(tool.headers) : '');
}

function fillTemplates(): void {
  for (const t of demoToolTemplates()) addTool(t);
}

function removeTool(i: number): void {
  rec.tools.splice(i, 1);
  toolHeaderTexts.splice(i, 1);
}

async function runTest(): Promise<void> {
  syncHeaders();
  testResult.value = '测试中…';
  const r = await testConnection(rec);
  testResult.value = `${r.ok ? '✅' : '❌'} ${r.message}`;
}

async function save(): Promise<void> {
  syncHeaders();
  errors.value = validateAgent(rec);
  if (errors.value.length > 0) return;
  saving.value = true;
  try {
    await app.saveAgent(JSON.parse(JSON.stringify(rec)) as AgentConfigRecord);
    notifyAgentChanged(rec.id); // 活会话属此 agent 则 dispose，强制下次拿新配置的 kernel
    void router.push('/');
  } finally {
    saving.value = false;
  }
}

async function remove(): Promise<void> {
  if (!window.confirm(`删除 agent「${rec.name}」？其历史会话仍保留，可在侧栏查看。`)) return;
  await app.removeAgent(rec.id);
  notifyAgentChanged(rec.id); // 活会话属此 agent 则 dispose（删除后会话变 orphaned，不可再驱动）
  void router.push('/');
}
</script>

<template>
  <div class="page">
    <div class="head">
      <h2>{{ isNew ? '新增 Agent' : `配置：${rec.name || '（未命名）'}` }}</h2>
      <div class="actions">
        <button v-if="!isNew" type="button" class="btn-danger" @click="remove">删除</button>
        <button type="button" class="btn" :disabled="saving" @click="save">保存</button>
      </div>
    </div>

    <section class="card">
      <h3>基本</h3>
      <div class="grid2">
        <label class="field"><span>名称 *</span><input v-model="rec.name" type="text" placeholder="如：商城客服" /></label>
        <label class="field"><span>标识色</span>
          <select v-model="rec.color">
            <option v-for="c in AGENT_COLORS" :key="c" :value="c" :style="{ color: c }">{{ c }}</option>
          </select>
        </label>
      </div>
      <label class="field"><span>System Prompt（角色设定与边界）</span>
        <textarea v-model="rec.system" rows="4" placeholder="你是……能做……超出能力范围时……"></textarea>
      </label>
    </section>

    <section class="card">
      <h3>连接</h3>
      <div class="grid2">
        <label class="field"><span>协议 *</span>
          <select v-model="rec.connection.provider">
            <option value="openai">openai 兼容</option>
            <option value="openai-responses">openai-responses</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
          </select>
        </label>
        <label class="field"><span>模型 *</span><input v-model="rec.connection.model" type="text" placeholder="gpt-5.5 / claude-sonnet-5" /></label>
      </div>
      <div class="grid2">
        <label class="field"><span>baseUrl（自建代理 / 中转站；空 = 官方端点）</span>
          <input v-model="rec.connection.baseUrl" type="text" placeholder="https://relay.example/v1 或 http://localhost:8788/v1" />
        </label>
        <label class="field"><span>API Key（接代理可空，由代理侧注入）</span>
          <input v-model="rec.connection.apiKey" type="password" placeholder="sk-..." />
        </label>
      </div>
      <label class="field"><span>附加请求头（每行 <code>Name: value</code>，宿主鉴权令牌等）</span>
        <textarea v-model="connHeadersText" rows="2" placeholder="x-demo-token: demo-123"></textarea>
      </label>
      <p class="warn">API Key 明文存本机 IndexedDB——共用设备请留空，改用代理侧注入。</p>
      <button type="button" class="btn-ghost" @click="runTest">测试连接</button>
      <span class="hint" style="margin-left: 8px">{{ testResult }}</span>
    </section>

    <section class="card">
      <h3>功能</h3>
      <div class="grid2">
        <label class="field"><span>审批模式</span>
          <select v-model="rec.approvalMode">
            <option value="auto">自动放行（防线在后端工具 API）</option>
            <option value="confirm">弹窗确认（每次工具调用真人点头）</option>
          </select>
        </label>
        <label class="field"><span>死循环熔断</span>
          <select v-model="rec.loopBreakerMode">
            <option value="loose">loose（默认）</option>
            <option value="strict">strict</option>
            <option value="off">off</option>
          </select>
        </label>
      </div>
      <label><input v-model="rec.compaction" type="checkbox" /> 上下文自动压缩（长对话用同模型摘要腾窗口）</label>
    </section>

    <section class="card">
      <h3>工具（后端业务 API 声明；引擎自动附带 parallel 并发能力）</h3>
      <div v-for="(t, i) in rec.tools" :key="i" class="tool">
        <div class="grid2">
          <label class="field"><span>名称 *（字母/数字/下划线）</span><input v-model="t.name" type="text" placeholder="order_query" /></label>
          <label class="field"><span>端点 *</span>
            <div style="display: flex; gap: 6px">
              <select v-model="t.method" style="width: 90px">
                <option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
              </select>
              <input v-model="t.url" type="text" style="flex: 1" placeholder="https://api.example.com/tools/order_query" />
            </div>
          </label>
        </div>
        <label class="field"><span>描述 *（LLM 靠它决定何时调用）</span><input v-model="t.description" type="text" /></label>
        <div class="grid2">
          <label class="field"><span>入参 JSON Schema *</span>
            <textarea v-model="t.inputSchemaJson" rows="5" spellcheck="false"></textarea>
          </label>
          <label class="field"><span>请求头（每行 <code>Name: value</code>）</span>
            <textarea v-model="toolHeaderTexts[i]" rows="5" placeholder="x-demo-token: demo-123"></textarea>
          </label>
        </div>
        <button type="button" class="btn-danger" @click="removeTool(i)">移除此工具</button>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 8px">
        <button type="button" class="btn-ghost" @click="addTool()">+ 添加工具</button>
        <button type="button" class="btn-ghost" @click="fillTemplates">填入客服模板（demo-backend）</button>
      </div>
      <p class="hint">安全边界：agent loop 跑在浏览器里、可被用户篡改——每个工具端点必须按公开 API 标准做服务端鉴权与校验。</p>
    </section>

    <p v-if="errors.length" class="error-text">{{ errors.join('\n') }}</p>
  </div>
</template>

<style scoped>
.page { padding: 20px 24px; overflow-y: auto; }
.head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.head h2 { font-size: 18px; }
.actions { display: flex; gap: 8px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
.card h3 { font-size: 14px; margin-bottom: 10px; color: #374151; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.tool { border: 1px dashed #d1d5db; border-radius: 10px; padding: 12px; margin-bottom: 10px; background: #fafafa; }
</style>
