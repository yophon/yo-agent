import type { RegisteredTool, ToolContext } from './index';

/** memory_write 工具名（4.9e）：LLM 侧写长期记忆的唯一手段（兑现 DESIGN §5.3「agent 可读写」）。 */
export const MEMORY_WRITE_TOOL = 'memory_write';

/**
 * 记忆写入器（tools 层不依赖 kernel 的 appendMemoryLine；app 注入闭包，内含 workspaceRoot 与幂等查重）。
 * 抛错时应携带可行动信息（写权限/磁盘空间/路径），本工具原样上抛给 LLM。
 */
export type MemoryWriter = (content: string) => Promise<{ line: string; deduped: boolean }>;

/**
 * `memory_write` 工具（4.9e / DESIGN §5.3）：把一条事实写入 workspace 私有长期记忆（MEMORY.md），
 * 跨会话由约定文件加载路读回。幂等——同内容重复写不堆行（由注入的 writer 查重）。
 * `kind:'edit'` + `approval:'risk-based'`：写盘操作走权限闸门（read-only 档拒、supervised 档问、
 * accept-edits 起自动放行），不因「只是记忆」绕过审批面。
 */
export function makeMemoryWriteTool(writer: MemoryWriter): RegisteredTool {
  return {
    descriptor: {
      name: MEMORY_WRITE_TOOL,
      kind: 'edit',
      description:
        '写入一条跨会话长期记忆（落盘 workspace 根的 MEMORY.md，按 workspace 隔离）。用于用户偏好、项目约定、重要事实等值得下次会话记住的内容；一条一个事实、精炼成单句。重复内容幂等（不重复堆行）。',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的事实（单句、自包含；避免只在本会话有意义的指代）' },
        },
        required: ['content'],
      },
      owner: 'core',
      availability: { always: true },
      approval: 'risk-based',
    },
    executor: {
      async *execute(input, _ctx: ToolContext) {
        const raw = (input as Record<string, unknown> | null)?.content;
        const content = raw == null ? '' : String(raw).trim();
        if (!content) throw new Error('memory_write：content 不能为空');
        const r = await writer(content);
        yield {
          kind: 'output',
          chunk: r.deduped ? `已存在同内容记忆，跳过（幂等）：${r.line}` : `已写入长期记忆：${r.line}`,
        };
      },
    },
  };
}
