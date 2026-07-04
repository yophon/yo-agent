<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { disposeChat, openChat, useChat } from '../composables/use-chat';
import { app } from '../services/app-state';

const route = useRoute();
const { chatState, send, steer, interrupt } = useChat();

const input = ref('');
const loadError = ref('');
const orphaned = ref(false);
const msgBox = ref<HTMLElement | null>(null);

async function loadFromRoute(): Promise<void> {
  loadError.value = '';
  orphaned.value = false;
  const sid = String(route.params.sessionId ?? '');
  if (!sid) return; // '/'：空态（从侧栏选 agent 开聊）
  const row = await app.shared.store.getSession(sid);
  if (!row) {
    loadError.value = '会话不存在或已被删除';
    return;
  }
  const rec = app.agentById(row.agentProfile);
  if (!rec) {
    orphaned.value = true; // agent 配置已删：无法物化 kernel，只提示（历史仍可在删除前导出——非本期）
    return;
  }
  try {
    await openChat(rec, sid);
    scrollBottom();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}
watch(() => route.fullPath, loadFromRoute, { immediate: true });

const turnActive = computed(() => chatState.value?.turnActive ?? false);

function scrollBottom(): void {
  requestAnimationFrame(() => {
    if (msgBox.value) msgBox.value.scrollTop = msgBox.value.scrollHeight;
  });
}
watch(() => chatState.value?.messages.length, scrollBottom);
watch(chatState, scrollBottom, { deep: false });

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!text || !chatState.value) return;
  input.value = '';
  if (turnActive.value) {
    await steer(text); // turn 进行中 → 插话引导
  } else {
    await send(text);
  }
  scrollBottom();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
}

// 离开视图（切到配置页等）不主动 dispose——会话保活以便快速切回；删除/换会话由 use-chat 统一收口。
void disposeChat; // 引用留存：显式生命周期出口在侧栏删除路径
</script>

<template>
  <div class="chat">
    <div v-if="loadError" class="notice error">{{ loadError }}</div>
    <div v-else-if="orphaned" class="notice">该会话所属的 agent 配置已删除，无法续聊；可在侧栏删除此会话。</div>

    <div v-else-if="!chatState" class="empty-state">
      <h2>yo-agent Web 控制台</h2>
      <p v-if="app.state.agents.length === 0">
        内核就在这个页面里跑。先<router-link to="/agents/new">新增一个 agent</router-link>（配置连接与工具），然后回来开聊。
      </p>
      <p v-else>从左侧选一个 agent 点「对话」，或点开一条历史会话继续聊。</p>
    </div>

    <template v-else>
      <div ref="msgBox" class="msgs">
        <div v-for="(m, mi) in chatState.messages" :key="mi" class="row" :class="m.role">
          <div class="bubble">
            <template v-for="(p, pi) in m.parts" :key="pi">
              <span v-if="p.type === 'text'" class="text">{{ p.text }}</span>
              <details v-else class="tool" :class="`tool-${p.status}`">
                <summary>{{ p.summary || p.name }}</summary>
                <pre>入参: {{ JSON.stringify(p.input) }}
结果: {{ p.output || '（无输出）' }}</pre>
              </details>
            </template>
            <span v-if="m.role === 'assistant' && m.status === 'streaming' && m.parts.length === 0" class="typing">…</span>
          </div>
        </div>
        <div v-if="turnActive" class="row assistant"><div class="thinking">思考中…</div></div>
      </div>

      <div class="status">
        <span v-if="chatState.error" class="err">{{ chatState.error }}</span>
        <span v-if="chatState.totals.inputTokens + chatState.totals.outputTokens > 0" class="usage">
          {{ chatState.totals.inputTokens }}↑ {{ chatState.totals.outputTokens }}↓ tokens
          <template v-if="chatState.totals.costUsd > 0"> · ${{ chatState.totals.costUsd.toFixed(4) }}</template>
        </span>
      </div>

      <div class="inputrow">
        <textarea
          v-model="input"
          :placeholder="turnActive ? 'turn 进行中——输入将作为插话引导（Enter 发送）' : '输入消息，Enter 发送（Shift+Enter 换行）'"
          @keydown="onKeydown"
        ></textarea>
        <div class="btns">
          <button v-if="turnActive" type="button" class="btn-danger" @click="interrupt()">中断</button>
          <button type="button" class="btn" @click="submit()">{{ turnActive ? '插话' : '发送' }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.notice { padding: 14px 20px; color: #6b7280; }
.notice.error { color: #dc2626; }
.empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #6b7280; gap: 8px; }
.empty-state h2 { color: #374151; }
.empty-state a { color: #2563eb; }
.msgs { flex: 1; overflow-y: auto; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; }
.row.user { justify-content: flex-end; }
.bubble {
  max-width: 72%; padding: 9px 13px; border-radius: 12px;
  white-space: pre-wrap; word-break: break-word; background: #fff; border: 1px solid #e5e7eb;
}
.user .bubble { background: #2563eb; border-color: #2563eb; color: #fff; border-bottom-right-radius: 4px; }
.assistant .bubble { border-bottom-left-radius: 4px; }
.typing { color: #9ca3af; }
.thinking { font-size: 12px; color: #9ca3af; padding: 2px 6px; }
details.tool { margin: 4px 0; font-size: 12px; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 4px 8px; background: #f8fafc; }
details.tool summary { cursor: pointer; color: #475569; }
details.tool pre { margin-top: 4px; white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow-y: auto; }
.tool-ok summary::before { content: "✓ "; color: #16a34a; }
.tool-error summary::before { content: "✗ "; color: #dc2626; }
.tool-running summary::before { content: "… "; color: #d97706; }
.status { min-height: 22px; padding: 0 22px; font-size: 12px; color: #9ca3af; display: flex; gap: 12px; }
.status .err { color: #dc2626; }
.inputrow { display: flex; gap: 10px; padding: 12px 22px 16px; background: #fff; border-top: 1px solid #e5e7eb; }
.inputrow textarea { flex: 1; height: 52px; padding: 9px 12px; border: 1px solid #d1d5db; border-radius: 10px; resize: none; }
.btns { display: flex; flex-direction: column; gap: 6px; justify-content: flex-end; }
</style>
