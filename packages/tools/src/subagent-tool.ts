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

/** subagent_spawn 描述富化数据（4.9a 自知）：可用画像/模型枚举，注册时点值（与 system prompt 目录同源）。 */
export interface SubagentSpawnToolOpts {
  /** 可用画像名（不含 default；default 恒可用）。 */
  profiles?: string[];
  /** 可用模型 id（模型目录同 provider 清单）；缺省不枚举。 */
  models?: string[];
}

/**
 * `subagent_spawn` 工具（4C / DESIGN §2.5）：派生独立上下文的子 agent 跑探索型任务，**只回摘要**防主上下文污染。
 *
 * - foreground：阻塞至子 agent 完成，摘要作为本工具的 tool_result 回灌给 LLM。
 * - background：发出即返回 ack，子 agent 结果在 parent 下一 step 经 steering 注入（不阻塞主 turn）。
 *
 * 安全：`approval:'risk-based'`（绝不 never，必经权限闸门/审批）；kind=other。子 agent 的工具/权限由
 * 管理器侧 deriveSubagentPolicy「只收紧」派生（含恒剥离本工具防递归），本工具不直接放权。
 * 4.9a：model/profile 字段描述明确「留空沿用」并枚举可用值——LLM 不再裸猜模型名/画像名（feedback/4.8①）。
 */
export function makeSubagentSpawnTool(manager: SubagentSpawner, opts: SubagentSpawnToolOpts = {}): RegisteredTool {
  const profileDesc = `子 agent 画像/recipe 名；留空沿用 default。可用：${
    opts.profiles?.length ? opts.profiles.map((p) => `"${p}"`).join(', ') : '（无自定义画像，仅 default）'
  }`;
  const modelDesc = `可指定更便宜的模型跑子任务；留空沿用主 agent 模型（推荐）。${
    opts.models?.length ? `可用：${opts.models.map((m) => `"${m}"`).join(', ')}。不要凭记忆猜模型名。` : '不要凭记忆猜模型名。'
  }`;
  return {
    descriptor: {
      name: SUBAGENT_SPAWN_TOOL,
      kind: 'other',
      description:
        '派生一个独立上下文的子 agent 执行探索型/可并行的子任务，只回摘要（防主上下文污染）。mode=foreground 阻塞取回摘要；background 不阻塞、结果稍后注入。需要并行时：可在同一条响应里一次发出多个本工具调用（引擎会并发执行），或用 mode:"background" 逐个派生——发出即返回，多个子 agent 同样并发运行。没有单独的"并行包装器"工具。',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '交给子 agent 的任务描述' },
          profile: { type: 'string', description: profileDesc },
          mode: { type: 'string', enum: ['foreground', 'background'], description: '缺省 foreground（阻塞取回摘要）。并行多任务推荐 background：不阻塞、可连发多个并发跑，结果自动注入。' },
          model: { type: 'string', description: modelDesc },
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
        // 4.9b 守卫收紧：空/空白 profile 归一为 default、空/空白 model 直接省略（不把空串传进管理器）。
        const profile = strField(input, 'profile', 'default').trim() || 'default';
        const mode = strField(input, 'mode', 'foreground') === 'background' ? 'background' : 'foreground';
        const modelRaw = (input as Record<string, unknown> | null)?.model;
        const model = modelRaw == null ? '' : String(modelRaw).trim();
        const req: SubagentSpawnRequest = {
          parentSessionId: ctx.sessionId,
          profile,
          task,
          mode,
          ...(model ? { model } : {}),
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
