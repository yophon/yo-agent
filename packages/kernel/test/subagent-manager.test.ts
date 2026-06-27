import { describe, it, expect } from 'vitest';
import { DefaultSubagentManager } from '@yo-agent/kernel';
import type { Id } from '@yo-agent/protocol';
import type { SubagentHost, SubagentRunSpec, SubagentRunner } from '@yo-agent/kernel';

class FakeHost implements SubagentHost {
  started: Array<{ childSessionId: Id; label: string; model: string }> = [];
  results: Array<{ childSessionId: Id; summary: string; injectSteering?: boolean }> = [];
  async noteSubagentStarted(_p: Id, info: { childSessionId: Id; label: string; model: string }): Promise<void> {
    this.started.push(info);
  }
  async noteSubagentResult(
    _p: Id,
    info: { childSessionId: Id; summary: string },
    opts?: { injectSteering?: boolean },
  ): Promise<void> {
    this.results.push({ ...info, injectSteering: opts?.injectSteering });
  }
}

function mkManager(runner: SubagentRunner, extra: Partial<ConstructorParameters<typeof DefaultSubagentManager>[0]> = {}) {
  const host = new FakeHost();
  const mgr = new DefaultSubagentManager({
    host,
    runner,
    parentToolsOf: () => ['read', 'write', 'subagent_spawn'],
    parentModeOf: () => 'supervised',
    ...extra,
  });
  return { host, mgr };
}

describe('4C — DefaultSubagentManager', () => {
  it('foreground：阻塞取回摘要；host 先 Started 后 Result（前台不注入 steering）', async () => {
    const runner: SubagentRunner = { run: async (spec) => ({ summary: `done:${spec.task}` }) };
    const { host, mgr } = mkManager(runner);
    const r = await mgr.run({ parentSessionId: 'p', profile: 'x', task: 'T', mode: 'foreground' });
    expect(r.summary).toBe('done:T');
    expect(r.isError).toBe(false);
    expect(host.started).toHaveLength(1);
    expect(host.results).toHaveLength(1);
    expect(host.results[0]!.injectSteering).toBeFalsy();
  });

  it('派生策略收紧落到 runner：工具集 ⊆ parent 且剥离 subagent_spawn；depth=1', async () => {
    let captured: SubagentRunSpec | undefined;
    const runner: SubagentRunner = {
      run: async (spec) => {
        captured = spec;
        return { summary: 'ok' };
      },
    };
    const { mgr } = mkManager(runner);
    await mgr.run({ parentSessionId: 'p', profile: 'x', task: 'T', mode: 'foreground' });
    expect(captured?.toolAllowlist).toEqual(['read', 'write']);
    expect(captured?.permissionMode).toBe('supervised');
    expect(captured?.depth).toBe(1);
  });

  it('崩溃围栏（退出标准②）：runner 抛错 → 收敛为 error 摘要、绝不上抛；host 仍收 Result', async () => {
    const runner: SubagentRunner = {
      run: async () => {
        throw new Error('runner boom');
      },
    };
    const { host, mgr } = mkManager(runner);
    const r = await mgr.run({ parentSessionId: 'p', profile: 'x', task: 'T', mode: 'foreground' });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('子 agent 失败');
    expect(r.summary).toContain('runner boom');
    expect(host.results).toHaveLength(1);
  });

  it('background：spawn 发出即返回（不等 runner 完成）；完成后 host 收 Result 且 injectSteering=true', async () => {
    let release: (() => void) | undefined;
    const runner: SubagentRunner = {
      run: () => new Promise((res) => (release = () => res({ summary: 'bg done' }))),
    };
    const { host, mgr } = mkManager(runner);
    const { childSessionId } = await mgr.spawn({ parentSessionId: 'p', profile: 'x', task: 'T', mode: 'background' });
    expect(childSessionId).toBeTruthy();
    expect(host.started).toHaveLength(1); // Started 已发
    expect(host.results).toHaveLength(0); // 尚未完成，不阻塞
    release!();
    await new Promise((r) => setTimeout(r, 10));
    expect(host.results).toHaveLength(1);
    expect(host.results[0]!.injectSteering).toBe(true);
  });

  it('递归防护：超 maxDepth 的嵌套 spawn 被拒（不起子 agent、不 emit Started）', async () => {
    let mgr!: DefaultSubagentManager;
    const host = new FakeHost();
    const runner: SubagentRunner = {
      run: async (spec) => {
        // 子 agent 内再派生（parent = 自己 childSessionId）→ depth 2 > maxDepth(1) → 被拒
        const nested = await mgr.run({ parentSessionId: spec.childSessionId, profile: 'y', task: 'N', mode: 'foreground' });
        return { summary: nested.summary };
      },
    };
    mgr = new DefaultSubagentManager({ host, runner, parentToolsOf: () => ['read'], parentModeOf: () => 'supervised', maxDepth: 1 });
    const r = await mgr.run({ parentSessionId: 'p', profile: 'x', task: 'T', mode: 'foreground' });
    expect(r.summary).toContain('递归深度超限');
    expect(host.started).toHaveLength(1); // 只有外层起了子 agent，嵌套被拒不 emit
  });

  it('outputMaxTokens：超长摘要截断', async () => {
    const runner: SubagentRunner = { run: async () => ({ summary: 'a'.repeat(100) }) };
    const { mgr } = mkManager(runner);
    const r = await mgr.run({ parentSessionId: 'p', profile: 'x', task: 'T', mode: 'foreground', outputMaxTokens: 5 });
    expect(r.summary).toContain('已截断');
    expect(r.summary.length).toBeLessThan(100);
  });
});
