/**
 * useChat（Phase 5.1e）：ChatController ⇆ Vue 响应式桥。
 * 同一时刻至多一个活 controller（打开/切换/删除前先 dispose——防同一会话被两个 kernel
 * 驱动撞 cursor 单调校验）；onChange → version 自增驱动模板重渲（state 内部可变，浅桥即可）。
 */
import type { ChatController } from '@yo-agent/surface-web';
import { ChatController as Controller } from '@yo-agent/surface-web';
import { computed, ref, shallowRef } from 'vue';
import { app } from '../services/app-state';
import type { AgentConfigRecord } from '../services/types';

const controller = shallowRef<ChatController | null>(null);
const version = ref(0);
const activeAgentId = ref<string | null>(null);
let unsub: (() => void) | undefined;

function attach(c: ChatController, agentId: string): void {
  disposeChat();
  controller.value = c;
  activeAgentId.value = agentId;
  unsub = c.onChange(() => {
    version.value++;
  });
  version.value++;
}

export function disposeChat(): void {
  unsub?.();
  unsub = undefined;
  controller.value?.dispose();
  controller.value = null;
  activeAgentId.value = null;
  version.value++;
}

/** 为 agent 开新会话，返回 sessionId（路由跳 /chat/:sid）。 */
export async function startChat(rec: AgentConfigRecord): Promise<string> {
  const c = new Controller(app.runtime.agentFor(rec));
  attach(c, rec.id);
  const sid = await c.start();
  await app.refreshSessions();
  return sid;
}

/** 打开历史会话（resume + 回放）；已是当前会话则复用。 */
export async function openChat(rec: AgentConfigRecord, sessionId: string): Promise<void> {
  if (controller.value?.state.sessionId === sessionId) return;
  const c = new Controller(app.runtime.agentFor(rec));
  attach(c, rec.id);
  await c.open(sessionId);
  version.value++;
}

export function useChat() {
  const chatState = computed(() => {
    void version.value; // 依赖 version：controller.state 内部可变，靠它触发
    return controller.value?.state ?? null;
  });
  return {
    chatState,
    activeAgentId,
    send: async (text: string) => {
      await controller.value?.send(text);
      await app.refreshSessions(); // turn 结束刷新侧栏（标题/时间）
    },
    steer: (text: string) => controller.value?.steer(text) ?? Promise.resolve(),
    interrupt: () => controller.value?.interrupt() ?? Promise.resolve(),
  };
}

/** 当前活会话 id（删除会话时判断是否需先 dispose）。 */
export function activeSessionId(): string | undefined {
  return controller.value?.state.sessionId;
}

/**
 * agent 配置变更/删除后调用：若当前活 controller 属于该 agent，dispose 它——
 * 否则 openChat 会因 sessionId 相同而复用旧 controller（旧 kernel/旧配置），新配置直到切走再切回才生效。
 */
export function notifyAgentChanged(agentId: string): void {
  if (activeAgentId.value === agentId) disposeChat();
}
