/**
 * 离线 token 估算（DESIGN §5.1 / §15.1 "预估 > 0.9×窗口先触发 Condenser"）。
 * 无 tokenizer 依赖：ASCII 约 1 token ≈ 4 字符，CJK 约 0.6 token/字（更密）。
 * 仅用于压缩触发判断，不要求精确，宁可略高估以更早压缩。
 */
import type { CanonMessage, ContentBlock } from '@yo-agent/provider';

const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0x2e80) cjk++;
    else ascii++;
  }
  return Math.ceil(ascii / 4 + cjk * 0.6);
}

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
    case 'thinking':
      return b.text;
    case 'tool_use':
      return `${b.name} ${stringify(b.input)}`;
    case 'tool_result':
      return b.content;
  }
}

export function estimateMessageTokens(m: CanonMessage): number {
  const body =
    typeof m.content === 'string' ? estimateTokens(m.content) : m.content.reduce((n, b) => n + estimateTokens(blockText(b)), 0);
  return body + PER_MESSAGE_OVERHEAD;
}

export function estimateMessagesTokens(messages: CanonMessage[]): number {
  return messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
