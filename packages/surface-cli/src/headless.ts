/**
 * headless 文本渲染（DESIGN §7.2）：非 TUI、非 jsonl 时的人读输出（流式拼接）。
 * Reasoning 默认折叠（§2.2）；ApprovalRequested 提示 headless 默认拒绝。
 */
import type { EventEnvelope } from '@yo-agent/protocol';

export function formatHeadless(env: EventEnvelope): string | null {
  const e = env.event;
  switch (e.kind) {
    case 'AssistantText':
      return e.delta ?? null;
    case 'ToolCallStarted':
      return `\n[tool ${e.name}] `;
    case 'ToolCallOutput':
      return e.chunk;
    case 'ToolCallCompleted':
      return e.status === 'error' ? ' [✗]' : ' [✓]';
    case 'ContextCompacted':
      return `\n[上下文压缩：省 ${e.tokensSaved} tokens]\n`;
    case 'ApprovalRequested':
      return `\n[审批] ${e.tool}（headless 默认拒绝；交互审批用 TUI）`;
    case 'TurnCompleted':
      return `\n[完成: ${e.stopReason}]\n`;
    case 'TurnFailed':
      return `\n[失败: ${e.error.message}]\n`;
    default:
      return null; // Reasoning / Usage 等默认折叠
  }
}

export class HeadlessRenderer {
  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}
  render(env: EventEnvelope): void {
    const s = formatHeadless(env);
    if (s !== null) this.out.write(s);
  }
}
