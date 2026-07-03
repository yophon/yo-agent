import { describe, expect, it } from 'vitest';
import { DefaultSubagentManager, loadRecipes, loadSkills } from '@yo-agent/kernel';
import type { Recipe, SubagentHost, SubagentRunSpec, SubagentRunner } from '@yo-agent/kernel';
import type { Id } from '@yo-agent/protocol';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class NoopHost implements SubagentHost {
  async noteSubagentStarted(): Promise<void> {}
  async noteSubagentResult(): Promise<void> {}
}

function makeMgr(opts: {
  recipes?: Map<string, Recipe>;
  knownModels?: string[];
  onSpec?: (s: SubagentRunSpec) => void;
}) {
  const runner: SubagentRunner = {
    run: async (spec) => {
      opts.onSpec?.(spec);
      return { summary: 'ok' };
    },
  };
  return new DefaultSubagentManager({
    host: new NoopHost(),
    runner,
    parentToolsOf: () => ['read'],
    parentModeOf: () => 'supervised',
    defaultModel: 'main-model',
    ...(opts.recipes ? { recipeFor: (p: string) => opts.recipes!.get(p), profileNames: () => [...opts.recipes!.keys()] } : {}),
    ...(opts.knownModels ? { knownModels: () => opts.knownModels! } : {}),
  });
}

describe('4.9b — 子代理解析加固（早失败可行动）', () => {
  it('空串/空白 model 归一化：不透传 provider，沿用 defaultModel', async () => {
    const specs: SubagentRunSpec[] = [];
    const mgr = makeMgr({ knownModels: ['main-model', 'cheap'], onSpec: (s) => specs.push(s) });
    await mgr.run({ parentSessionId: 'p' as Id, profile: 'default', task: 'T', mode: 'foreground', model: '' });
    await mgr.run({ parentSessionId: 'p' as Id, profile: 'default', task: 'T', mode: 'foreground', model: '   ' });
    expect(specs.map((s) => s.model)).toEqual(['main-model', 'main-model']);
  });

  it('未知模型早失败：错误摘要列可用清单 + 留空指引，不起子 agent', async () => {
    let ran = false;
    const mgr = makeMgr({ knownModels: ['main-model', 'cheap'], onSpec: () => (ran = true) });
    const r = await mgr.run({ parentSessionId: 'p' as Id, profile: 'default', task: 'T', mode: 'foreground', model: 'clade-opus-99' });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('未知模型「clade-opus-99」');
    expect(r.summary).toContain('main-model, cheap');
    expect(r.summary).toContain('留空沿用主 agent 模型');
    expect(ran).toBe(false);
  });

  it('recipe 内的手误模型同样早失败', async () => {
    const recipes = new Map<string, Recipe>([['r', { name: 'r', model: 'typo-model', prompt: 'P' }]]);
    const mgr = makeMgr({ recipes, knownModels: ['main-model'] });
    const r = await mgr.run({ parentSessionId: 'p' as Id, profile: 'r', task: 'T', mode: 'foreground' });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('未知模型「typo-model」');
  });

  it('knownModels 空/缺省 → 不校验（目录未收录当前 provider 不误伤）', async () => {
    const specs: SubagentRunSpec[] = [];
    const mgr = makeMgr({ knownModels: [], onSpec: (s) => specs.push(s) });
    const r = await mgr.run({ parentSessionId: 'p' as Id, profile: 'default', task: 'T', mode: 'foreground', model: 'anything' });
    expect(r.isError).toBe(false);
    expect(specs[0]?.model).toBe('anything');
  });

  it('未知画像早失败（recipeFor 已接线）：列 default + 可用画像，不静默降级', async () => {
    const recipes = new Map<string, Recipe>([['researcher', { name: 'researcher', prompt: 'P' }]]);
    let ran = false;
    const mgr = makeMgr({ recipes, onSpec: () => (ran = true) });
    const r = await mgr.run({ parentSessionId: 'p' as Id, profile: 'reseacher', task: 'T', mode: 'foreground' });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('未知画像「reseacher」');
    expect(r.summary).toContain('default, researcher');
    expect(ran).toBe(false);
  });

  it('画像系统未接线（无 recipeFor）→ 保持宽容（profile 仅作 label），向后兼容', async () => {
    const mgr = makeMgr({});
    const r = await mgr.run({ parentSessionId: 'p' as Id, profile: 'x', task: 'T', mode: 'foreground' });
    expect(r.isError).toBe(false);
  });
});

describe('4.9b — 加载失败可见（onWarn）', () => {
  it('坏 SKILL.md（空文件）与超限 recipe 出告警不静默', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yo-warn-'));
    const skillsDir = join(dir, 'skills');
    const agentsDir = join(dir, 'agents');
    await mkdir(join(skillsDir, 'broken'), { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(skillsDir, 'broken', 'SKILL.md'), '   \n  ');
    await writeFile(join(skillsDir, 'good.md'), '---\nname: good\ndescription: ok\n---\nbody');
    await writeFile(join(agentsDir, 'huge.md'), `---\nname: huge\n---\n${'x'.repeat(1024 * 1024 + 1)}`);
    await writeFile(join(agentsDir, 'badmode.md'), '---\nname: badmode\npermissionMode: yolo\n---\nP');

    const warns: string[] = [];
    const skills = await loadSkills([{ dir: skillsDir }], (m) => warns.push(m));
    const recipes = await loadRecipes([{ dir: agentsDir }], (m) => warns.push(m));

    expect(skills.map((s) => s.name)).toEqual(['good']); // 坏的跳过、好的照常
    expect(recipes.has('badmode')).toBe(true); // 非法 mode 只丢字段不丢 recipe
    expect(recipes.get('badmode')?.permissionMode).toBeUndefined();
    expect(recipes.has('huge')).toBe(false);
    expect(warns.some((w) => w.includes('内容为空'))).toBe(true);
    expect(warns.some((w) => w.includes('超过') && w.includes('huge.md'))).toBe(true);
    expect(warns.some((w) => w.includes('permissionMode「yolo」非法'))).toBe(true);
  });
});
