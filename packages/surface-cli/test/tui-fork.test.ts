import { describe, it, expect, vi } from 'vitest';
import type { Id } from '@yo-agent/protocol';
import { buildCommands } from '../src/tui/commands';
import type { CommandDeps } from '../src/tui/commands';
import type { TuiKernel } from '../src/tui/types';
import type { UiState } from '../src/tui/model';

function makeDeps(kernel: Partial<TuiKernel>): { deps: CommandDeps; notices: string[]; switched: string[] } {
  const notices: string[] = [];
  const switched: string[] = [];
  const deps: CommandDeps = {
    kernel: kernel as TuiKernel,
    sessionId: () => 'cur' as Id,
    model: 'm',
    mode: 'supervised',
    cwd: '/ws',
    getState: () => ({}) as UiState,
    notice: (_tone, text) => notices.push(text),
    clear: () => {},
    exit: () => {},
    openPicker: () => {},
    setModelUi: () => {},
    setModeUi: () => {},
    switchSession: (id) => switched.push(String(id)),
    toggleReasoning: () => false,
  };
  return { deps, notices, switched };
}

const find = (name: string) => buildCommands().find((c) => c.name === name)!;

describe('5.3c /fork', () => {
  it('缺省最近边界：forkSession(atCursor=undefined) + switchSession 切到新会话', async () => {
    const forkSession = vi.fn(async () => 'new-id' as Id);
    const { deps, notices, switched } = makeDeps({ forkSession, listForkPoints: async () => [3, 7] });
    await find('/fork').run(deps, '');
    expect(forkSession).toHaveBeenCalledWith('cur', undefined);
    expect(switched).toEqual(['new-id']);
    expect(notices.join('\n')).toContain('fork');
  });

  it('/fork <序号>：1-based 序号映射到 fork 点 cursor；越界报错不 fork', async () => {
    const forkSession = vi.fn(async () => 'new-id' as Id);
    const { deps, notices, switched } = makeDeps({ forkSession, listForkPoints: async () => [3, 7] });
    await find('/fork').run(deps, '1');
    expect(forkSession).toHaveBeenCalledWith('cur', 3);

    await find('/fork').run(deps, '9');
    expect(forkSession).toHaveBeenCalledTimes(1); // 越界未再调
    expect(notices.join('\n')).toContain('无效 turn 序号');
    expect(switched).toEqual(['new-id']);
  });

  it('无边界/接缝缺失降级提示', async () => {
    const noPoints = makeDeps({ forkSession: async () => 'x' as Id, listForkPoints: async () => [] });
    await find('/fork').run(noPoints.deps, '');
    expect(noPoints.notices.join('\n')).toContain('没有可 fork 的边界');

    const noSeam = makeDeps({});
    await find('/fork').run(noSeam.deps, '');
    expect(noSeam.notices.join('\n')).toContain('不可用');
  });
});

describe('5.3c /tree', () => {
  it('谱系树：分支缩进挂源下、标注来源与当前会话；孤儿分支按根保留', async () => {
    const rows = [
      { sessionId: 'root-aaa' as Id, model: 'm1', workspacePath: '/w', lastActiveAt: 100 },
      { sessionId: 'cur' as Id, model: 'm1', workspacePath: '/w', lastActiveAt: 200, forkedFrom: { sessionId: 'root-aaa' as Id, cursor: 5 } },
      { sessionId: 'orphan-x' as Id, model: 'm2', workspacePath: '/w', lastActiveAt: 50, forkedFrom: { sessionId: 'gone' as Id, cursor: 2 } },
    ];
    const { deps, notices } = makeDeps({ listPersistedSessions: async () => rows });
    await find('/tree').run(deps, '');
    const out = notices.join('\n');
    const lines = out.split('\n');
    expect(out).toContain('会话谱系');
    expect(lines.findIndex((l) => l.includes('root-aaa'))).toBeLessThan(lines.findIndex((l) => l.includes('cur ')));
    expect(out).toContain('└─ cur');
    expect(out).toContain('← 当前');
    expect(out).toContain('(自 root-aaa@5)');
    expect(out).toContain('orphan-x'); // 源已删仍展示
    expect(out).toContain('(自 gone@2)');
  });
});
