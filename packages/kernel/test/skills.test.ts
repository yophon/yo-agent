import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentKernel, HistoryLoopBreaker, NodeFileSystem, NoopCondenser, loadSkills, parseFrontmatter, parseList, parseSkill, renderSkillSummaries } from '@yo-agent/kernel';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';
import { FakeProvider, textTurn } from '@yo-agent/provider';

// 5.2a EnvAdapter：既有 4D 用例喂 NodeFileSystem 原样跑（行为等价重构的回归门）。
const nfs = new NodeFileSystem();

describe('4D — frontmatter / list 解析', () => {
  it('parseFrontmatter：--- 包裹的 key:value + 正文', () => {
    const r = parseFrontmatter('---\nname: foo\ndescription: 一个技能\n---\nhello\nworld');
    expect(r.attrs.name).toBe('foo');
    expect(r.attrs.description).toBe('一个技能');
    expect(r.body).toBe('hello\nworld');
  });

  it('parseFrontmatter：无 frontmatter → attrs 空、body 原文', () => {
    const r = parseFrontmatter('just text');
    expect(r.attrs).toEqual({});
    expect(r.body).toBe('just text');
  });

  it('parseList：逗号 / 方括号 / 空', () => {
    expect(parseList('a, b, c')).toEqual(['a', 'b', 'c']);
    expect(parseList('[x, y]')).toEqual(['x', 'y']);
    expect(parseList(undefined)).toEqual([]);
  });

  it('parseSkill：name 缺省回退文件名', () => {
    const s = parseSkill('---\ndescription: d\n---\nbody', 'fallback-name');
    expect(s.name).toBe('fallback-name');
    expect(s.description).toBe('d');
    expect(s.body).toBe('body');
  });
});

describe('4D — loadSkills', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yo-skills-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('加载单文件 <name>.md 与目录式 <name>/SKILL.md', async () => {
    await writeFile(join(dir, 'foo.md'), '---\nname: foo\ndescription: 单文件\n---\nFOO 全文');
    await mkdir(join(dir, 'bar'), { recursive: true });
    await writeFile(join(dir, 'bar', 'SKILL.md'), '---\ndescription: 目录式\n---\nBAR 全文');
    const skills = await loadSkills(nfs, [{ dir, source: 'project' }]);
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get('foo')?.body).toBe('FOO 全文');
    expect(byName.get('bar')?.body).toBe('BAR 全文'); // 目录名作回退 name
    expect(byName.get('bar')?.description).toBe('目录式');
  });

  it('project 同名覆盖 global（后目录优先）', async () => {
    const g = await mkdtemp(join(tmpdir(), 'yo-skills-g-'));
    await writeFile(join(g, 'k.md'), '---\nname: k\n---\nGLOBAL');
    await writeFile(join(dir, 'k.md'), '---\nname: k\n---\nPROJECT');
    const skills = await loadSkills(nfs, [
      { dir: g, source: 'global' },
      { dir, source: 'project' },
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.body).toBe('PROJECT');
    await rm(g, { recursive: true, force: true });
  });

  it('目录不存在 → 跳过不抛', async () => {
    const skills = await loadSkills(nfs, [{ dir: join(dir, 'nope') }]);
    expect(skills).toEqual([]);
  });

  it('收口 4D-LOW：超大 .md（>1MiB）被跳过，防 OOM DoS', async () => {
    await writeFile(join(dir, 'huge.md'), `---\nname: huge\n---\n${'x'.repeat(1024 * 1024 + 10)}`);
    await writeFile(join(dir, 'ok.md'), '---\nname: ok\ndescription: 正常\n---\n正文');
    const skills = await loadSkills(nfs, [{ dir, source: 'project' }]);
    const names = skills.map((s) => s.name);
    expect(names).toContain('ok'); // 正常技能加载
    expect(names).not.toContain('huge'); // 超大文件跳过
  });

  it('renderSkillSummaries：摘要段含名与描述；空 → 空串', () => {
    expect(renderSkillSummaries([])).toBe('');
    const out = renderSkillSummaries([{ name: 'foo', description: '描述', body: 'x' }]);
    expect(out).toContain('可用技能');
    expect(out).toContain('`foo`');
    expect(out).toContain('描述');
    expect(out).not.toContain('x'); // 全文不进摘要
  });
});

describe('4D — systemSuffix 注入（技能摘要进 system，跨 surface 统一）', () => {
  it('startSession 把 systemSuffix 拼进 system 消息，随首次推理送达 provider', async () => {
    const provider = new FakeProvider();
    provider.script(textTurn('ok'));
    const kernel = new AgentKernel({
      store: new MemoryEventStore(),
      provider,
      tools: new InMemoryToolRegistry(),
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      model: 'fake',
      systemSuffix: '# 可用技能\n- `foo`：描述',
    });
    const sid = await kernel.startSession({ system: 'BASE 约定' });
    await kernel.submitInput(sid, 'go', 'k1');
    const sys = provider.seen[0]!.messages[0]!;
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('BASE 约定'); // 原 system 保留
    expect(sys.content).toContain('可用技能'); // 技能摘要追加
    expect(sys.content).toContain('`foo`');
  });
});
