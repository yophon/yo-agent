/**
 * word-count —— 注册面示例：自定义工具 + slash 命令 + system prompt 段三件套。
 * 工具进主 ToolRegistry（LLM 可调，owner/approval 被 host 钳制）；命令进 TUI（/exthello，
 * 补全与 /help 自动带上）；system 段让 LLM 知道新能力的存在。
 */
import { defineExtension } from '@yo-agent/extension-host';

export default defineExtension((yo) => {
  yo.registerTool({
    descriptor: {
      name: 'word_count',
      kind: 'read',
      description: '统计一段文本的字符数与词数',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '待统计文本' } },
        required: ['text'],
      },
      owner: 'plugin',
      availability: { always: true },
      approval: 'risk-based',
    },
    executor: {
      async *execute(input) {
        const t = String((input as { text?: unknown } | null)?.text ?? '');
        const words = t.trim() ? t.trim().split(/\s+/).length : 0;
        yield { kind: 'output', chunk: `字符数 ${[...t].length}，词数 ${words}` };
      },
    },
  });
  yo.registerCommand({
    name: 'exthello',
    desc: '扩展示例命令（word-count 扩展注入）',
    run: async (ctx, args) => ctx.notice(`来自 word-count 扩展的问候${args ? `：${args}` : ''}`),
  });
  yo.addSystemSection('# 扩展能力（word-count）\n- `word_count` 工具可统计文本字符数/词数。');
});
