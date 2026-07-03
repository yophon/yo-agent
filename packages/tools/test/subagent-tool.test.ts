import { describe, expect, it } from 'vitest';
import { makeSubagentSpawnTool } from '../src/subagent-tool';
import type { SubagentSpawner } from '../src/subagent-tool';

const noopManager: SubagentSpawner = {
  run: async () => ({ childSessionId: 'c', summary: 's', isError: false }),
  spawn: async () => ({ childSessionId: 'c' }),
};

function fieldDesc(tool: ReturnType<typeof makeSubagentSpawnTool>, field: string): string {
  const props = (tool.descriptor.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  return props[field]?.description ?? '';
}

describe('4.9a subagent_spawn 描述富化（自知）', () => {
  it('schema 快照：带枚举时 model/profile 描述含「留空沿用」+ 可用清单', () => {
    const tool = makeSubagentSpawnTool(noopManager, {
      profiles: ['researcher', 'reviewer'],
      models: ['claude-opus-4-8', 'claude-haiku-4-5'],
    });
    expect(fieldDesc(tool, 'profile')).toMatchInlineSnapshot(
      `"子 agent 画像/recipe 名；留空沿用 default。可用："researcher", "reviewer""`,
    );
    expect(fieldDesc(tool, 'model')).toMatchInlineSnapshot(
      `"可指定更便宜的模型跑子任务；留空沿用主 agent 模型（推荐）。可用："claude-opus-4-8", "claude-haiku-4-5"。不要凭记忆猜模型名。"`,
    );
  });

  it('无枚举（缺省）：明示仅 default / 不要猜模型名，行为向后兼容', () => {
    const tool = makeSubagentSpawnTool(noopManager);
    expect(fieldDesc(tool, 'profile')).toContain('仅 default');
    expect(fieldDesc(tool, 'model')).toContain('不要凭记忆猜模型名');
    expect(tool.descriptor.name).toBe('subagent_spawn');
    expect(tool.descriptor.approval).toBe('risk-based');
  });

  it('4.10 并行提示：工具描述声明两条并发路径,mode 字段推荐 background(真机反馈 feedback/4.10)', () => {
    const tool = makeSubagentSpawnTool(noopManager);
    expect(tool.descriptor.description).toContain('同一条响应里一次发出多个');
    expect(tool.descriptor.description).toContain('没有单独的"并行包装器"工具');
    expect(fieldDesc(tool, 'mode')).toContain('并行多任务推荐 background');
  });
});
