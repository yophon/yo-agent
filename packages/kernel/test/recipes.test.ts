import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultSubagentManager, loadRecipes, parseRecipe } from '@yo-agent/kernel';
import type { Id } from '@yo-agent/protocol';
import type { Recipe, SubagentHost, SubagentRunSpec, SubagentRunner } from '@yo-agent/kernel';

class NoopHost implements SubagentHost {
  async noteSubagentStarted(): Promise<void> {}
  async noteSubagentResult(): Promise<void> {}
}

describe('4D — parseRecipe', () => {
  it('解析 name/tools/model/permissionMode/prompt', () => {
    const r = parseRecipe(
      '---\nname: researcher\ndescription: 只读探索\ntools: read, grep, glob\nmodel: cheap\npermissionMode: read-only\n---\n你是研究子 agent',
      'fallback',
    );
    expect(r.name).toBe('researcher');
    expect(r.tools).toEqual(['read', 'grep', 'glob']);
    expect(r.model).toBe('cheap');
    expect(r.permissionMode).toBe('read-only');
    expect(r.prompt).toBe('你是研究子 agent');
  });

  it('非法 permissionMode 静默忽略；name 缺省回退文件名', () => {
    const r = parseRecipe('---\npermissionMode: bogus\n---\nbody', 'myfile');
    expect(r.permissionMode).toBeUndefined();
    expect(r.name).toBe('myfile');
    expect(r.prompt).toBe('body');
  });
});

describe('4D — loadRecipes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yo-recipes-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('从目录加载并按 name 建表', async () => {
    await writeFile(join(dir, 'r.md'), '---\nname: researcher\ntools: read\n---\nPROMPT');
    const recipes = await loadRecipes([{ dir, source: 'project' }]);
    expect(recipes.get('researcher')?.tools).toEqual(['read']);
  });
});

describe('4D — recipe 驱动子 agent（仍经 deriveSubagentPolicy 只收紧）', () => {
  it('recipe 的工具/权限/model/prompt 落到 spec，但工具 ∩ parent、权限取更严者', async () => {
    const recipes = new Map<string, Recipe>([
      ['researcher', { name: 'researcher', tools: ['read', 'net'], permissionMode: 'read-only', model: 'cheap', prompt: 'RECIPE PROMPT' }],
    ]);
    let captured: SubagentRunSpec | undefined;
    const runner: SubagentRunner = {
      run: async (spec) => {
        captured = spec;
        return { summary: 'ok' };
      },
    };
    const mgr = new DefaultSubagentManager({
      host: new NoopHost(),
      runner,
      parentToolsOf: () => ['read', 'write', 'subagent_spawn'],
      parentModeOf: () => 'autonomous',
      recipeFor: (p) => recipes.get(p),
    });

    await mgr.run({ parentSessionId: 'p' as Id, profile: 'researcher', task: 'T', mode: 'foreground' });
    expect(captured?.toolAllowlist).toEqual(['read']); // recipe[read,net] ∩ parent[read,write] = [read]（net 拿不到）
    expect(captured?.permissionMode).toBe('read-only'); // read-only 比 parent autonomous 更严 → 采用
    expect(captured?.model).toBe('cheap');
    expect(captured?.systemPrompt).toBe('RECIPE PROMPT');

    // 4.9b：画像系统已接线（recipeFor 存在）时，未知 profile 不再静默降级 → 可行动错误（见 subagent-validate.test.ts）；
    // default/空串仍从 parent 派生（spawn 剥离）。
    await mgr.run({ parentSessionId: 'p' as Id, profile: 'default', task: 'T', mode: 'foreground' });
    expect(captured?.toolAllowlist).toEqual(['read', 'write']);
    expect(captured?.permissionMode).toBe('autonomous');
    expect(captured?.systemPrompt).toBeUndefined();
  });
});
