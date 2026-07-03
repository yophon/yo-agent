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

  it('4.10 并行提示：工具描述推荐 tasks 扇出、明示无「并行包装器」(真机反馈 feedback/4.10)', () => {
    const tool = makeSubagentSpawnTool(noopManager);
    expect(tool.descriptor.description).toContain('推荐给 tasks 数组');
    expect(tool.descriptor.description).toContain('没有单独的"并行包装器"工具');
    expect(fieldDesc(tool, 'tasks')).toContain('并行扇出');
  });
});

// ── 4.10 tasks 扇出(feedback/4.10 候选 4:一次调用引擎内并发派生 N 个)──────

async function drain(tool: ReturnType<typeof makeSubagentSpawnTool>, input: unknown): Promise<string> {
  let out = '';
  for await (const e of tool.executor.execute(input, { sessionId: 'p', cwd: '/tmp' })) {
    if (e.kind === 'output') out += e.chunk;
  }
  return out;
}

describe('4.10 subagent_spawn tasks 扇出', () => {
  it('foreground 扇出:N 个任务真并发(高水位=N),摘要按任务序合并,失败项标注', async () => {
    let active = 0;
    let maxActive = 0;
    const mgr: SubagentSpawner = {
      run: async (req) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20)); // 并发窗口
        active--;
        return req.task === 'bad'
          ? { childSessionId: `c-${req.task}`, summary: '[子 agent 失败] 炸了', isError: true }
          : { childSessionId: `c-${req.task}`, summary: `done:${req.task}`, isError: false };
      },
      spawn: async () => ({ childSessionId: 'x' }),
    };
    const tool = makeSubagentSpawnTool(mgr);
    const out = await drain(tool, { tasks: ['a', 'bad', 'c'] });
    expect(maxActive).toBe(3);
    expect(out).toContain('[子任务 1/3] a\ndone:a');
    expect(out).toContain('[子任务 2/3]（失败） bad\n[子 agent 失败] 炸了');
    expect(out).toContain('[子任务 3/3] c\ndone:c');
  });

  it('background 扇出:一次 ack 列出全部 childSessionId', async () => {
    const spawned: string[] = [];
    const mgr: SubagentSpawner = {
      run: async () => ({ childSessionId: 'x', summary: 's', isError: false }),
      spawn: async (req) => {
        spawned.push(req.task);
        return { childSessionId: `bg-${req.task}` };
      },
    };
    const tool = makeSubagentSpawnTool(mgr);
    const out = await drain(tool, { tasks: ['t1', 't2'], mode: 'background' });
    expect(spawned).toEqual(['t1', 't2']);
    expect(out).toContain('已并发派生 2 个后台子 agent');
    expect(out).toContain('bg-t1');
    expect(out).toContain('bg-t2');
  });

  it('tasks 优先于 task;空白项过滤;超上限/两者皆缺回可行动错误', async () => {
    const ran: string[] = [];
    const mgr: SubagentSpawner = {
      run: async (req) => {
        ran.push(req.task);
        return { childSessionId: 'c', summary: 'ok', isError: false };
      },
      spawn: async () => ({ childSessionId: 'x' }),
    };
    const tool = makeSubagentSpawnTool(mgr);
    await drain(tool, { task: '被忽略', tasks: ['只跑我', ' ', ''] });
    expect(ran).toEqual(['只跑我']);
    await expect(drain(tool, { tasks: Array.from({ length: 9 }, (_, i) => `t${i}`) })).rejects.toThrow('至多 8 个');
    await expect(drain(tool, {})).rejects.toThrow('task 与 tasks 至少给其一');
  });
});
