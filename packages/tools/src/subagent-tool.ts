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

/** tasks 扇出上限（feedback/4.10 候选 4）：防失控批量;超限回可行动错误提示分批。 */
export const MAX_SPAWN_FANOUT = 8;

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
 * - tasks 扇出（feedback/4.10）：一次调用并发派生 N 个（≤MAX_SPAWN_FANOUT），engine 内并行——
 *   真机定论「gpt-5.5 部署每响应至多 1 个 tool_call」后的工程侧绕行,一次审批覆盖一批。
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
        '派生独立上下文的子 agent 执行探索型/可并行的子任务，只回摘要（防主上下文污染）。单任务给 task；需要并行时推荐给 tasks 数组：一次调用即并发派生多个子 agent（引擎内并行，无需分多次调用，也没有单独的"并行包装器"工具）。mode=foreground 阻塞取回全部摘要；background 不阻塞、结果稍后注入。',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '交给子 agent 的任务描述（单任务；与 tasks 二选一，必给其一）' },
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description: `并行扇出（推荐）：多个任务描述，一次调用并发派生同数量子 agent（至多 ${MAX_SPAWN_FANOUT} 个）。给出本字段时忽略 task`,
          },
          profile: { type: 'string', description: profileDesc },
          mode: { type: 'string', enum: ['foreground', 'background'], description: '缺省 foreground（阻塞取回摘要）；background 不阻塞、结果自动注入。对 task/tasks 均适用。' },
          model: { type: 'string', description: modelDesc },
        },
        required: [],
      },
      owner: 'core',
      availability: { always: true },
      approval: 'risk-based',
    },
    executor: {
      async *execute(input, ctx: ToolContext) {
        // 4.9b 守卫收紧：空/空白 profile 归一为 default、空/空白 model 直接省略（不把空串传进管理器）。
        const profile = strField(input, 'profile', 'default').trim() || 'default';
        const mode = strField(input, 'mode', 'foreground') === 'background' ? 'background' : 'foreground';
        const modelRaw = (input as Record<string, unknown> | null)?.model;
        const model = modelRaw == null ? '' : String(modelRaw).trim();
        const baseReq = { parentSessionId: ctx.sessionId, profile, mode, ...(model ? { model } : {}) } as const;

        // tasks 扇出（feedback/4.10 候选 4）：一次调用并发派生 N 个,绕开「模型端每响应只发 1 个 tool_call」的上游限制。
        const rawTasks = (input as Record<string, unknown> | null)?.tasks;
        const tasks = Array.isArray(rawTasks) ? rawTasks.map((t) => String(t).trim()).filter(Boolean) : [];
        if (tasks.length > MAX_SPAWN_FANOUT) {
          throw new Error(`subagent_spawn：tasks 至多 ${MAX_SPAWN_FANOUT} 个（收到 ${tasks.length}）；请分批派生`);
        }
        if (tasks.length > 0) {
          const reqs: SubagentSpawnRequest[] = tasks.map((task) => ({ ...baseReq, task }));
          if (mode === 'background') {
            const ids = await Promise.all(reqs.map((r) => manager.spawn(r)));
            yield {
              kind: 'output',
              chunk: `已并发派生 ${ids.length} 个后台子 agent（「${profile}」）：${ids.map((x) => x.childSessionId).join('、')}。结果将在后续步骤自动注入，无需等待。`,
            };
            return;
          }
          const results = await Promise.all(reqs.map((r) => manager.run(r))); // run 有崩溃围栏,失败收敛为 isError 摘要不 reject
          yield {
            kind: 'output',
            chunk: results
              .map((r, i) => `[子任务 ${i + 1}/${results.length}]${r.isError ? '（失败）' : ''} ${tasks[i]}\n${r.summary}`)
              .join('\n\n'),
          };
          return;
        }

        const task = strField(input, 'task');
        if (!task.trim()) throw new Error('subagent_spawn：task 与 tasks 至少给其一（并行用 tasks 数组）');
        const req: SubagentSpawnRequest = { ...baseReq, task };
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
