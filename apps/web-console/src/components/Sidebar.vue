<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { activeSessionId, disposeChat, startChat } from '../composables/use-chat';
import { app } from '../services/app-state';
import { formatRelativeTime } from '../services/session-list';
import type { AgentConfigRecord } from '../services/types';

const router = useRouter();
const route = useRoute();

const filterAgentId = ref<string | null>(null);
const agents = computed(() => app.state.agents);
const sessions = computed(() =>
  filterAgentId.value ? app.state.sessions.filter((s) => s.agentId === filterAgentId.value) : app.state.sessions,
);
const currentSid = computed(() => String(route.params.sessionId ?? ''));

function toggleFilter(id: string): void {
  filterAgentId.value = filterAgentId.value === id ? null : id;
}

async function newChat(rec: AgentConfigRecord): Promise<void> {
  const sid = await startChat(rec);
  void router.push(`/chat/${sid}`);
}

async function removeSession(sessionId: string): Promise<void> {
  if (!window.confirm('删除这条会话？事件记录将从本机清除。')) return;
  if (activeSessionId() === sessionId) {
    disposeChat();
    void router.push('/');
  }
  await app.removeSession(sessionId);
}
</script>

<template>
  <aside class="bar">
    <div class="brand">yo-agent 控制台</div>

    <div class="section">
      <div class="section-head">
        <span>Agents</span>
        <router-link class="add" to="/agents/new">＋ 新增</router-link>
      </div>
      <p v-if="agents.length === 0" class="empty">还没有 agent——先<router-link to="/agents/new">新增一个</router-link></p>
      <div
        v-for="a in agents"
        :key="a.id"
        class="agent"
        :class="{ filtered: filterAgentId === a.id }"
        @click="toggleFilter(a.id)"
      >
        <span class="dot" :style="{ background: a.color }"></span>
        <span class="name">{{ a.name || '（未命名）' }}</span>
        <button type="button" class="mini" title="新对话" @click.stop="newChat(a)">对话</button>
        <router-link class="mini gear" :to="`/agents/${a.id}`" title="配置" @click.stop>⚙</router-link>
      </div>
    </div>

    <div class="section grow">
      <div class="section-head">
        <span>会话历史{{ filterAgentId ? '（已过滤）' : '' }}</span>
      </div>
      <p v-if="sessions.length === 0" class="empty">暂无会话</p>
      <div
        v-for="s in sessions"
        :key="s.sessionId"
        class="session"
        :class="{ active: s.sessionId === currentSid }"
        @click="router.push(`/chat/${s.sessionId}`)"
      >
        <span class="dot" :style="{ background: s.agentColor }" :title="s.agentName"></span>
        <span class="title" :class="{ orphan: s.orphaned }">{{ s.title }}</span>
        <span class="time">{{ formatRelativeTime(s.lastActiveAt) }}</span>
        <button type="button" class="del" title="删除会话" @click.stop="removeSession(s.sessionId)">✕</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.bar {
  height: 100%; display: flex; flex-direction: column;
  background: #111827; color: #e5e7eb; padding: 12px 10px; overflow: hidden;
}
.brand { font-weight: 700; padding: 4px 8px 12px; font-size: 15px; }
.section { margin-bottom: 10px; min-height: 0; }
.section.grow { flex: 1; overflow-y: auto; }
.section-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 12px; color: #9ca3af; padding: 4px 8px;
}
.add { color: #60a5fa; text-decoration: none; }
.empty { font-size: 12px; color: #6b7280; padding: 4px 8px; }
.empty a { color: #60a5fa; }
.agent, .session {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 8px; cursor: pointer; font-size: 13px;
}
.agent:hover, .session:hover { background: #1f2937; }
.agent.filtered { background: #1e3a5f; }
.session.active { background: #1f2937; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.name, .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title.orphan { color: #6b7280; font-style: italic; }
.time { font-size: 11px; color: #6b7280; flex: none; }
.mini {
  border: 1px solid #374151; background: transparent; color: #9ca3af;
  border-radius: 6px; font-size: 11px; padding: 1px 6px; text-decoration: none;
}
.mini:hover { color: #e5e7eb; border-color: #6b7280; }
.del {
  border: none; background: transparent; color: #4b5563; font-size: 11px; padding: 0 2px; visibility: hidden;
}
.session:hover .del { visibility: visible; }
.del:hover { color: #f87171; }
</style>
