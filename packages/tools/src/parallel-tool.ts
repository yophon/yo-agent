import type { RegisteredTool } from './index';

/**
 * `parallel` 批量调用工具名(feedback/4.10「一劳永逸」):内核在 tool 循环内联展开——
 * 每个子调用逐一走完整准入链(熔断/PreToolUse/权限闸门/审批,不可绕),再进 4.10b 波次并发执行。
 * 背景:真机定论「gpt-5.5 部署每响应至多发 1 个 tool_call」,模型端同批多发不可得;
 * 本工具把「一批调用」装进单个 tool_use,引擎侧补齐并发。模型幻觉的 multi_tool_use.parallel 由此成真。
 */
export const PARALLEL_TOOL = 'parallel';

/** 单次 parallel 的子调用上限(与 subagent_spawn tasks 扇出同值):防失控批量,超限回可行动错误。 */
export const MAX_PARALLEL_CALLS = 8;

/**
 * 声明与占位执行器:真正的展开在 AgentKernel tool 循环(见 kernel.ts parallel 展开段)。
 * 占位 executor 只在「宿主未接线」(非 AgentKernel 直调 registry)时兜底报错,不承担任何执行。
 */
export const parallelTool: RegisteredTool = {
  descriptor: {
    name: PARALLEL_TOOL,
    kind: 'other',
    description:
      `并行执行多个工具调用(引擎内并发;每个子调用仍逐一经过策略与审批,与单独调用完全等价)。当你想一步同时调用多个工具时用它——例如同时读多个文件、同时跑多个检索。calls 每项 {tool, input};至多 ${MAX_PARALLEL_CALLS} 个;不可嵌套 parallel。结果按 calls 顺序编号合并返回。`,
    inputSchema: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          description: `要并行执行的调用列表(至多 ${MAX_PARALLEL_CALLS} 个)`,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: '工具名(须是当前可用工具)' },
              input: { type: 'object', description: '该工具的入参对象' },
            },
            required: ['tool'],
          },
        },
      },
      required: ['calls'],
    },
    owner: 'core',
    availability: { always: true },
    // 包装器自身免审批:安全语义全部落在子调用上(每个子调用按其自身 kind/approval 走闸门与审批)。
    approval: 'never',
  },
  executor: {
    // biome-ignore lint/correctness/useYield: 占位执行器,先抛错(内核内联展开,不会走到这里)。
    async *execute() {
      throw new Error('parallel 工具由 AgentKernel 在 tool 循环内联展开;当前宿主未接线该机制');
    },
  },
};
