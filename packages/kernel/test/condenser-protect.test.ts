import { describe, it, expect } from 'vitest';
import { SummarizingCondenser } from '@yo-agent/kernel';
import type { CanonMessage } from '@yo-agent/provider';

const SKILL_BODY = '【技能全文】SKILLBODYMARKER 必须逐字保留的长内容';

/** 构造一段含 skill_activate（tool_use+tool_result）的中段 + 若干填充对，长到可压缩。 */
function buildMessages(): CanonMessage[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '任务' },
    // 中段起点：skill_activate 激活对
    { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'skill_activate', input: { name: 'foo' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 's1', name: 'skill_activate', content: SKILL_BODY }] },
    // 中段其余（应被摘要）
    { role: 'assistant', content: 'step a' },
    { role: 'user', content: 'obs a' },
    // 尾段（keepTail=6）
    { role: 'assistant', content: 'step b' },
    { role: 'user', content: 'obs b' },
    { role: 'assistant', content: 'step c' },
    { role: 'user', content: 'obs c' },
    { role: 'assistant', content: 'step d' },
    { role: 'user', content: 'obs d' },
  ];
}

describe('4D — 压缩保护（protectedToolNames）', () => {
  it('保护命中：skill_activate 激活的全文压缩后逐字保留', async () => {
    const condenser = new SummarizingCondenser({
      summarize: async () => 'SUMMARY（不含技能全文）',
      protectedToolNames: new Set(['skill_activate']),
    });
    const out = await condenser.condense(buildMessages());
    const json = JSON.stringify(out);
    expect(json).toContain('SKILLBODYMARKER'); // 技能全文未被截断
    expect(json).toContain('SUMMARY'); // 其余中段已摘要
    // 配对完整：保留段含 skill_activate 的 tool_use 与 tool_result
    expect(json).toContain('"tool_use"');
    expect(json).toContain('"tool_result"');
  });

  it('未开启保护：同一中段技能全文被摘要吞掉（对照）', async () => {
    const condenser = new SummarizingCondenser({
      summarize: async () => 'SUMMARY（不含技能全文）',
    });
    const out = await condenser.condense(buildMessages());
    expect(JSON.stringify(out)).not.toContain('SKILLBODYMARKER');
  });
});
