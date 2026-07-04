import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '@yo-agent/kernel/core';
import { FakeProvider, textTurn, toolCallTurn } from '@yo-agent/provider';
import { createWebAgent } from '@yo-agent/surface-web';

/**
 * 5.2a contextFs 最小演示：MemoryFileSystem 装 skill → 浏览器面装配把技能摘要拼进 system、
 * skill_activate 注册可被 LLM 调用、约定文件链同 CLI 语义——浏览器场景解锁 skills 能力。
 */
describe('createWebAgent contextFs（5.2a EnvAdapter）', () => {
  const fsWith = (): MemoryFileSystem =>
    new MemoryFileSystem({
      '/yo.md': 'WEB 约定规则',
      '/.yo-agent/skills/greeting.md': '---\nname: greeting\ndescription: 问候话术\n---\n问候全文指令',
    });

  it('技能摘要 + 约定文件进 system；skill_activate 注册且全文可激活', async () => {
    const provider = new FakeProvider()
      .script(toolCallTurn('skill_activate', 't1', { name: 'greeting' }))
      .script(textTurn('已按话术问候'));
    const agent = createWebAgent({
      connection: { provider: 'anthropic', model: 'fake-model', baseUrl: 'https://api.example.com/llm' },
      providerOverride: provider,
      system: '你是客服',
      contextFs: fsWith(),
    });
    const sid = await agent.startSession();
    await agent.kernel.submitInput(sid, '打个招呼', 'idem-1');

    const system = JSON.stringify(provider.seen[0]?.messages?.[0] ?? '');
    expect(system).toContain('你是客服'); // 宿主 system 保留
    expect(system).toContain('WEB 约定规则'); // 约定文件链
    expect(system).toContain('greeting'); // 技能摘要（懒加载提示）
    expect(system).toContain('问候话术');
    expect(system).not.toContain('问候全文指令'); // 全文不常驻，激活才注入
    // skill_activate 激活出的全文以 tool_result 进第二轮消息窗口
    expect(provider.seen.length).toBe(2);
    expect(JSON.stringify(provider.seen[1]?.messages ?? [])).toContain('问候全文指令');
  });

  it('无 contextFs → 行为不变（不注册 skill_activate）', async () => {
    const provider = new FakeProvider().script(textTurn('好的'));
    const agent = createWebAgent({
      connection: { provider: 'anthropic', model: 'fake-model', baseUrl: 'https://api.example.com/llm' },
      providerOverride: provider,
    });
    await agent.startSession();
    expect(agent.tools.executor('skill_activate')).toBeUndefined();
  });
});
