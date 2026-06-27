import type { Id } from '@yo-agent/protocol';
import type { RegisteredTool, ToolContext } from './index';

/** 子 agent 派生工具名（4C）；deriveSubagentPolicy 据此恒从子 agent 工具集剥离（防无限递归 spawn）。 */
export const SUBAGENT_SPAWN_TOOL = 'subagent_spawn';

/** 派生子 agent 的最小请求（tools 层不依赖 kernel.SubagentSpawnOpts，避免 tools→kernel 反向依赖）。 */
export interface SubagentSpawnRequest {
  parentSessionId: Id;
  profile: string;
  task: string;
  mode: 'foreground' | 'background';
  model?: string;
}

/**
 * 子 agent 管理器契约（tools 侧最小面）：kernel.DefaultSubagentManager 结构化满足。
 * - run：foreground 用——await 至子 agent 完成并取回摘要（同时由内核 emit SubagentStarted/Result）。
 * - spawn：background 用——发出即返回 childSessionId，结果经 steering 在 parent 下一 step 注入。
 */
export interface SubagentSpawner {
  run(req: SubagentSpawnRequest): Promise<{ childSessionId: Id; summary: string; isError: boolean }>;
  spawn(req: SubagentSpawnRequest): Promise<{ childSessionId: Id }>;
}

function strField(input: unknown, key: string, fallback = ''): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  return v == null ? fallback : String(v);
}

/**
 * `subagent_spawn` 工具（4C / DESIGN §2.5）：派生独立上下文的子 agent 跑探索型任务，**只回摘要**防主上下文污染。
 *
 * - foreground：阻塞至子 agent 完成，摘要作为本工具的 tool_result 回灌给 LLM。
 * - background：发出即返回 ack，子 agent 结果在 parent 下一 step 经 steering 注入（不阻塞主 turn）。
 *
 * 安全：`approval:'risk-based'`（绝不 never，必经权限闸门/审批）；kind=other。子 agent 的工具/权限由
 * 管理器侧 deriveSubagentPolicy「只收紧」派生（含恒剥离本工具防递归），本工具不直接放权。
 */
export function makeSubagentSpawnTool(manager: SubagentSpawner): RegisteredTool {
  return {
    descriptor: {
      name: SUBAGENT_SPAWN_TOOL,
      kind: 'other',
      description:
        '派生一个独立上下文的子 agent 执行探索型/可并行的子任务，只回摘要（防主上下文污染）。mode=foreground 阻塞取回摘要；background 不阻塞、结果稍后注入。',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '交给子 agent 的任务描述' },
          profile: { type: 'string', description: '子 agent 画像/recipe 名（缺省 default）' },
          mode: { type: 'string', enum: ['foreground', 'background'], description: '缺省 foreground' },
          model: { type: 'string', description: '可指定更便宜的模型跑子任务' },
        },
        required: ['task'],
      },
      owner: 'core',
      availability: { always: true },
      approval: 'risk-based',
    },
    executor: {
      async *execute(input, ctx: ToolContext) {
        const task = strField(input, 'task');
        if (!task.trim()) throw new Error('subagent_spawn：task 不能为空');
        const profile = strField(input, 'profile', 'default');
        const mode = strField(input, 'mode', 'foreground') === 'background' ? 'background' : 'foreground';
        const model = (input as Record<string, unknown> | null)?.model;
        const req: SubagentSpawnRequest = {
          parentSessionId: ctx.sessionId,
          profile,
          task,
          mode,
          ...(model != null ? { model: String(model) } : {}),
        };
        if (mode === 'background') {
          const { childSessionId } = await manager.spawn(req);
          yield {
            kind: 'output',
            chunk: `已派生后台子 agent（${childSessionId}）：「${profile}」。结果将在后续步骤自动注入，无需等待。`,
          };
          return;
        }
        const r = await manager.run(req);
        yield { kind: 'output', chunk: r.summary };
      },
    },
  };
}
