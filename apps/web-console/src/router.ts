import { createRouter, createWebHashHistory } from 'vue-router';
import AgentConfigView from './views/AgentConfigView.vue';
import ChatView from './views/ChatView.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: ChatView },
    { path: '/chat/:sessionId', component: ChatView },
    { path: '/agents/new', component: AgentConfigView },
    { path: '/agents/:id', component: AgentConfigView },
  ],
});
