<script setup lang="ts">
import { computed } from 'vue';
import { app } from '../services/app-state';

const current = computed(() => app.approval.queue[0] ?? null);
const inputJson = computed(() => JSON.stringify(current.value?.input ?? {}, null, 2));
</script>

<template>
  <div v-if="current" class="overlay">
    <div class="dialog">
      <h3>工具调用确认</h3>
      <p>agent 请求调用工具 <b>{{ current.tool }}</b>（风险评估：{{ current.risk }}）</p>
      <pre>{{ inputJson }}</pre>
      <div class="row">
        <button type="button" class="btn-danger" @click="app.decideApproval(false)">拒绝</button>
        <button type="button" class="btn" @click="app.decideApproval(true)">允许本次</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.dialog { background: #fff; border-radius: 12px; padding: 18px 20px; width: 420px; max-width: 90vw; }
.dialog h3 { font-size: 15px; margin-bottom: 8px; }
.dialog pre {
  background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px;
  max-height: 200px; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all;
}
.row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
