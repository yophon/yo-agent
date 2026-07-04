/**
 * <yo-chat> —— 原生可嵌入聊天挂件（PHASE-5 5D，demo 级样式）。
 * shadow DOM 隔离样式（可嵌任意宿主页面不外溢）；消费 ChatController 的 ChatState，
 * 消息流式渲染 / 工具调用折叠视图 / 中断 / 新对话。UI 无框架，纯 DOM。
 */
import type { ChatController, ChatMessage, ChatState } from '@yo-agent/surface-web';

const TEMPLATE = `
<style>
  :host { all: initial; display: block; font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #222; }
  .frame { border: 1px solid #ddd; border-radius: 12px; overflow: hidden; background: #fff; }
  .head { padding: 8px 14px; background: #f8fafc; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
  .head b { font-size: 13px; }
  .head button { border: none; background: transparent; color: #2563eb; cursor: pointer; font-size: 12px; }
  .msgs { height: 380px; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: #fafafa; }
  .row { display: flex; }
  .row.user { justify-content: flex-end; }
  .bubble { max-width: 78%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
  .user .bubble { background: #2563eb; color: #fff; border-bottom-right-radius: 4px; }
  .assistant .bubble { background: #fff; border: 1px solid #e5e7eb; border-bottom-left-radius: 4px; }
  .assistant .bubble:empty::after { content: "…"; color: #999; }
  details.tool { margin: 4px 0; font-size: 12px; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 4px 8px; background: #f8fafc; }
  details.tool summary { cursor: pointer; color: #475569; }
  details.tool pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto; color: #334155; }
  .tool-ok summary::before { content: "✓ "; color: #16a34a; }
  .tool-error summary::before { content: "✗ "; color: #dc2626; }
  .tool-running summary::before { content: "… "; color: #d97706; }
  .status { padding: 4px 14px; font-size: 12px; color: #888; min-height: 20px; display: flex; gap: 10px; align-items: center; }
  .status .err { color: #dc2626; }
  .status button { border: 1px solid #dc2626; background: #fff; color: #dc2626; border-radius: 6px; padding: 1px 10px; cursor: pointer; font-size: 12px; }
  .inputrow { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #eee; }
  .inputrow textarea { flex: 1; resize: none; height: 44px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px; font: inherit; }
  .inputrow button { padding: 0 18px; border: none; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
  .inputrow button:disabled { background: #93c5fd; cursor: not-allowed; }
</style>
<div class="frame">
  <div class="head"><b>智能客服（yo-agent 内核 · 浏览器内运行）</b><button id="new">新对话</button></div>
  <div class="msgs" id="msgs"><div class="row assistant"><div class="bubble">请先在上方「应用配置并开聊」。</div></div></div>
  <div class="status" id="status"></div>
  <div class="inputrow">
    <textarea id="input" placeholder="输入消息，Enter 发送（Shift+Enter 换行）"></textarea>
    <button id="send">发送</button>
  </div>
</div>`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMessage(m: ChatMessage): string {
  const parts = m.parts
    .map((p) => {
      if (p.type === 'text') return esc(p.text);
      const body = `<pre>入参: ${esc(JSON.stringify(p.input))}\n结果: ${esc(p.output || '（无输出）')}</pre>`;
      return `<details class="tool tool-${p.status}"><summary>${esc(p.summary || p.name)}</summary>${body}</details>`;
    })
    .join('');
  return `<div class="row ${m.role}"><div class="bubble">${parts}</div></div>`;
}

export class YoChatElement extends HTMLElement {
  #controller?: ChatController;
  #unsub?: () => void;
  #msgs!: HTMLElement;
  #status!: HTMLElement;
  #input!: HTMLTextAreaElement;
  #send!: HTMLButtonElement;

  connectedCallback(): void {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    this.#msgs = root.getElementById('msgs') as HTMLElement;
    this.#status = root.getElementById('status') as HTMLElement;
    this.#input = root.getElementById('input') as HTMLTextAreaElement;
    this.#send = root.getElementById('send') as HTMLButtonElement;
    this.#send.addEventListener('click', () => this.#submit());
    this.#input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.#submit();
      }
    });
    (root.getElementById('new') as HTMLButtonElement).addEventListener('click', () => {
      void this.#controller?.newSession();
    });
  }

  disconnectedCallback(): void {
    this.#unsub?.();
    this.#controller?.dispose();
  }

  /** 宿主注入 controller（可整体替换——设置面板「应用配置」时换新实例）。 */
  set controller(c: ChatController) {
    this.#unsub?.();
    this.#controller?.dispose();
    this.#controller = c;
    this.#unsub = c.onChange((s) => this.#render(s));
    this.#render(c.state);
  }

  #submit(): void {
    const text = this.#input.value.trim();
    if (!text || !this.#controller || this.#controller.state.turnActive) return;
    this.#input.value = '';
    void this.#controller.send(text); // turn 内失败落 state.error，经 onChange 呈现
  }

  #render(s: ChatState): void {
    this.#msgs.innerHTML =
      s.messages.map(renderMessage).join('') ||
      '<div class="row assistant"><div class="bubble">你好，我是智能客服，可以帮你查订单、建工单～</div></div>';
    this.#msgs.scrollTop = this.#msgs.scrollHeight;
    this.#send.disabled = s.turnActive;

    const bits: string[] = [];
    if (s.turnActive) bits.push('<span>思考中…</span><button id="stop">中断</button>');
    if (s.error) bits.push(`<span class="err">${esc(s.error)}</span>`);
    if (s.totals.inputTokens + s.totals.outputTokens > 0) {
      const cost = s.totals.costUsd > 0 ? ` · $${s.totals.costUsd.toFixed(4)}` : '';
      bits.push(`<span>${s.totals.inputTokens}↑ ${s.totals.outputTokens}↓ tokens${cost}</span>`);
    }
    this.#status.innerHTML = bits.join('');
    this.#status.querySelector('#stop')?.addEventListener('click', () => void this.#controller?.interrupt());
  }
}

customElements.define('yo-chat', YoChatElement);

declare global {
  interface HTMLElementTagNameMap {
    'yo-chat': YoChatElement;
  }
}
