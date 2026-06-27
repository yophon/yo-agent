import { describe, it, expect } from 'vitest';
import { UnconfiguredExecBackend } from '@yo-agent/tools';
import type { ExecBackend } from '@yo-agent/tools';

describe('4A — ExecBackend 抽象（接口先行，实现在 4B）', () => {
  it('UnconfiguredExecBackend 默认 kind=local-subprocess，可指定其它档', () => {
    expect(new UnconfiguredExecBackend().kind).toBe('local-subprocess');
    expect(new UnconfiguredExecBackend('docker').kind).toBe('docker');
    expect(new UnconfiguredExecBackend('ssh-remote').kind).toBe('ssh-remote');
  });

  it('占位被误调即抛（接口已就位但真实执行未到，4B 落地）', async () => {
    const be: ExecBackend = new UnconfiguredExecBackend();
    await expect(async () => {
      for await (const _ of be.exec('echo hi', { cwd: '/tmp' })) void _;
    }).rejects.toThrow(/未配置/);
  });
});
