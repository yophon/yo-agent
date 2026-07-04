<script setup lang="ts">
import Sidebar from './components/Sidebar.vue';
import ApprovalDialog from './components/ApprovalDialog.vue';
import { app } from './services/app-state';

const persistent = app.state.persistent;
</script>

<template>
  <div class="shell">
    <Sidebar class="side" />
    <main class="main">
      <div v-if="!persistent" class="volatile-banner">
        ⚠️ 当前环境无 IndexedDB（隐私模式？）——本次会话不持久，刷新即失。
      </div>
      <router-view />
    </main>
    <ApprovalDialog />
  </div>
</template>

<style scoped>
.shell { display: flex; height: 100%; }
.side { width: 280px; flex: none; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.volatile-banner {
  padding: 6px 16px; background: #fef3c7; color: #92400e; font-size: 12px;
  border-bottom: 1px solid #fde68a;
}
</style>
