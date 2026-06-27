import { describe, it, expect } from 'vitest';
import { DefaultSubagentManager, WorkerSubagentRunner } from '@yo-agent/kernel';
import type { SubagentHost, SubagentRunSpec } from '@yo-agent/kernel';
import type { Id } from '@yo-agent/protocol';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

function spec(over: Partial<SubagentRunSpec> = {}): SubagentRunSpec {
  return {
    childSessionId: 'c1',
    parentSessionId: 'p1',
    profile: 'default',
    task: 'T',
    model: 'fake',
    maxTurns: 4,
    toolAllowlist: [],
    permissionMode: 'read-only',
    cwd: '/work',
    depth: 1,
    ...over,
  };
}

class NoopHost implements SubagentHost {
  results: Array<{ summary: string }> = [];
  async noteSubagentStarted(): Promise<void> {}
  async noteSubagentResult(_p: Id, info: { childSessionId: Id; summary: string }): Promise<void> {
    this.results.push({ summary: info.summary });
  }
}

describe('4C — WorkerSubagentRunner（worker_threads 隔离 + 崩溃围栏）', () => {
  it('正常路径：worker 回摘要 → resolve', async () => {
    const runner = new WorkerSubagentRunner({ entry: fixture('subagent-ok.mjs') });
    const r = await runner.run(spec({ task: 'hello' }));
    expect(r.summary).toBe('worker-ok:hello');
    expect(r.isError).toBe(false);
  });

  it('退出标准②：worker 内未捕获异常 → runner reject', async () => {
    const runner = new WorkerSubagentRunner({ entry: fixture('subagent-crash.mjs') });
    await expect(runner.run(spec())).rejects.toThrow(/boom from subagent worker/);
  });

  it('退出标准②：worker 主动退出（非0）→ runner reject', async () => {
    const runner = new WorkerSubagentRunner({ entry: fixture('subagent-exit.mjs') });
    await expect(runner.run(spec())).rejects.toThrow(/异常退出.*code=7/);
  });

  it('退出标准②（端到端）：崩溃 worker 经管理器围栏 → error 摘要、绝不上抛', async () => {
    const host = new NoopHost();
    const mgr = new DefaultSubagentManager({
      host,
      runner: new WorkerSubagentRunner({ entry: fixture('subagent-crash.mjs') }),
      parentToolsOf: () => [],
      parentModeOf: () => 'read-only',
    });
    const r = await mgr.run({ parentSessionId: 'p', profile: 'x', task: 'T', mode: 'foreground' });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('子 agent 失败');
    expect(host.results).toHaveLength(1); // 主循环存活、收到 Result
  });

  it('secret 不泄漏给 worker：默认 env 白名单剥离 *_SENTINEL，PATH 透传', async () => {
    process.env.YO_SECRET_SENTINEL = 'LEAK';
    try {
      const runner = new WorkerSubagentRunner({ entry: fixture('subagent-env.mjs') });
      const r = await runner.run(spec());
      const probe = JSON.parse(r.summary) as { hasSecret: boolean; hasPath: boolean };
      expect(probe.hasSecret).toBe(false); // secret 被剥离
      expect(probe.hasPath).toBe(true); // PATH 白名单透传
    } finally {
      delete process.env.YO_SECRET_SENTINEL;
    }
  });

  it('abort：已取消的 signal → 立即 reject、不起 worker', async () => {
    const runner = new WorkerSubagentRunner({ entry: fixture('subagent-ok.mjs') });
    const ac = new AbortController();
    ac.abort(new Error('pre-abort'));
    await expect(runner.run(spec(), ac.signal)).rejects.toThrow();
  });
});
