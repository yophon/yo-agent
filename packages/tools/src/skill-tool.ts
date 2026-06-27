import type { RegisteredTool, ToolContext } from './index';

/**
 * skill_activate 工具名（4D）。condenser 据此把激活后的技能全文（tool_result name=此）保护不被压缩截断
 * （opencode PRUNE_PROTECTED_TOOLS）—— app 用此常量构造 condenser 的 protectedToolNames。
 */
export const SKILL_ACTIVATE_TOOL = 'skill_activate';

/** 技能正文解析器（tools 层不依赖 kernel.Skill 加载；app 注入已加载技能的查表）。 */
export type SkillBodyResolver = (name: string) => { name: string; body: string } | undefined;

function strField(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key];
  return v == null ? '' : String(v);
}

/**
 * `skill_activate` 工具（4D / DESIGN §5.4）：按名加载技能**全文**注入上下文（懒加载——平时只有摘要在上下文）。
 * `approval:'never'`（纯读本地已声明技能、无副作用）；kind=read。激活内容受压缩保护（见 SKILL_ACTIVATE_TOOL）。
 */
export function makeSkillActivateTool(resolve: SkillBodyResolver, knownNames: () => string[] = () => []): RegisteredTool {
  return {
    descriptor: {
      name: SKILL_ACTIVATE_TOOL,
      kind: 'read',
      description: '按名加载一个技能的全文指令到上下文（技能摘要常驻、全文按需激活）。',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名（见上下文「可用技能」摘要）' } },
        required: ['name'],
      },
      owner: 'core',
      availability: { always: true },
      approval: 'never',
    },
    executor: {
      async *execute(input, _ctx: ToolContext) {
        const name = strField(input, 'name').trim();
        if (!name) throw new Error('skill_activate：name 不能为空');
        const skill = resolve(name);
        if (!skill) {
          const known = knownNames();
          throw new Error(`skill_activate：未找到技能「${name}」${known.length ? `（可用：${known.join(', ')}）` : ''}`);
        }
        yield { kind: 'output', chunk: `# 技能：${skill.name}\n\n${skill.body}` };
      },
    },
  };
}
