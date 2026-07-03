import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentKernel,
  HistoryLoopBreaker,
  NoopCondenser,
  composeSystemSections,
  readGitBranch,
  renderEnvBlock,
  renderMcpSection,
  renderMemoryPreamble,
  renderModelSection,
  renderProfileSection,
} from '@yo-agent/kernel';
import type { CanonMessage } from '@yo-agent/provider';
import { FakeProvider } from '@yo-agent/provider';
import { MemoryEventStore } from '@yo-agent/store';
import { InMemoryToolRegistry } from '@yo-agent/tools';

describe('4.9a 静态自知渲染（纯函数）', () => {
  it('renderEnvBlock：cwd/workspaceRoot/OS/日期/git 分支/模型/权限模式齐全', () => {
    const s = renderEnvBlock({
      cwd: '/w/sub',
      workspaceRoot: '/w',
      os: 'darwin 25.5.0',
      date: '2026-07-02',
      gitBranch: 'main',
      model: 'claude-opus-4-8',
      permissionMode: 'supervised',
    });
    expect(s).toContain('cwd：/w/sub');
    expect(s).toContain('workspaceRoot：/w');
    expect(s).toContain('OS：darwin 25.5.0');
    expect(s).toContain('日期：2026-07-02');
    expect(s).toContain('git 分支：main');
    expect(s).toContain('当前模型：claude-opus-4-8');
    expect(s).toContain('权限模式：supervised');
  });

  it('renderEnvBlock：无 git 分支则省略该行', () => {
    const s = renderEnvBlock({
      cwd: '/w',
      workspaceRoot: '/w',
      os: 'linux',
      date: '2026-07-02',
      model: 'm',
      permissionMode: 'ci',
    });
    expect(s).not.toContain('git 分支');
  });

  it('renderModelSection：枚举可用模型并标注当前 + 禁猜指引', () => {
    const s = renderModelSection('claude-haiku-4-5', [
      { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', contextWindow: 1_000_000 },
      { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', contextWindow: 200_000 },
    ]);
    expect(s).toContain('`claude-opus-4-8`');
    expect(s).toContain('←当前');
    expect(s).toContain('不要凭记忆猜模型名');
  });

  it('renderModelSection：目录未收录 → 明示留空沿用、不要猜', () => {
    const s = renderModelSection('local-mystery', []);
    expect(s).toContain('local-mystery');
    expect(s).toContain('留空 model 沿用当前模型');
    expect(s).toContain('不要凭记忆猜模型名');
  });

  it('renderMemoryPreamble：落盘路径 + 隔离说明 + 写入手段（含/不含工具）', () => {
    const noTool = renderMemoryPreamble({ workspaceRoot: '/w' });
    expect(noTool).toContain('/w/MEMORY.md');
    expect(noTool).toContain('#remember');
    expect(noTool).not.toContain('memory_write');
    const withTool = renderMemoryPreamble({ workspaceRoot: '/w', writeTool: 'memory_write' });
    expect(withTool).toContain('`memory_write`');
  });

  it('renderProfileSection：default 恒在 + recipe 枚举', () => {
    const s = renderProfileSection([{ name: 'researcher', description: '只读调研' }]);
    expect(s).toContain('`default`');
    expect(s).toContain('`researcher`：只读调研');
  });

  it('renderMcpSection：已连接 + 信任门跳过名单 + opt-in 指引；两空 → 空串', () => {
    const s = renderMcpSection([{ server: 'fs', status: 'connected', toolCount: 3 }], ['github']);
    expect(s).toContain('`fs`：connected（3 个工具');
    expect(s).toContain('`github`');
    expect(s).toContain('mcp-trust.json');
    expect(renderMcpSection([], [])).toBe('');
  });

  it('composeSystemSections：跳过空段、空行分隔', () => {
    expect(composeSystemSections('a', '', undefined, 'b')).toBe('a\n\nb');
  });
});

describe('readGitBranch', () => {
  it('ref 形态 → 分支名；detached → 短 hash；非 git → undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yo-git-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    expect(await readGitBranch(dir)).toBe('feature/x');
    await writeFile(join(dir, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(await readGitBranch(dir)).toBe('0123456789ab');
    const empty = await mkdtemp(join(tmpdir(), 'yo-nogit-'));
    expect(await readGitBranch(empty)).toBeUndefined();
  });
});

describe('4.9a kernel systemSuffix 函数形态', () => {
  it('startSession 求值并喂入会话真实起点（model/cwd/permissionMode），落 system 消息', async () => {
    const store = new MemoryEventStore();
    const seen: Array<{ model: string; cwd: string; permissionMode: string }> = [];
    const kernel = new AgentKernel({
      store,
      provider: new FakeProvider(),
      tools: new InMemoryToolRegistry(),
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      systemSuffix: (info) => {
        seen.push(info);
        return `[自知] 模型=${info.model} 模式=${info.permissionMode}`;
      },
    });
    const sid = await kernel.startSession({ model: 'm-x', cwd: '/w', permissionMode: 'read-only', system: '基础' });
    expect(seen).toEqual([{ model: 'm-x', cwd: '/w', permissionMode: 'read-only' }]);
    const row = await store.getSession(sid);
    const sys = (row?.messages as CanonMessage[])[0]!;
    expect(sys.role).toBe('system');
    expect(sys.content).toBe('基础\n\n[自知] 模型=m-x 模式=read-only');
  });

  it('suffix 求值抛错不阻断开会话（自知是增强非关键路径）', async () => {
    const store = new MemoryEventStore();
    const kernel = new AgentKernel({
      store,
      provider: new FakeProvider(),
      tools: new InMemoryToolRegistry(),
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      systemSuffix: () => {
        throw new Error('boom');
      },
    });
    const sid = await kernel.startSession({ system: '基础' });
    const row = await store.getSession(sid);
    expect(((row?.messages as CanonMessage[])[0]!).content).toBe('基础');
  });

  it('五段组合 dump：env/模型/记忆/画像/MCP 全部进 system prompt（复刻 main.ts 组装）', async () => {
    const store = new MemoryEventStore();
    const kernel = new AgentKernel({
      store,
      provider: new FakeProvider(),
      tools: new InMemoryToolRegistry(),
      loopBreaker: new HistoryLoopBreaker(),
      condenser: new NoopCondenser(),
      systemSuffix: (info) =>
        composeSystemSections(
          renderEnvBlock({
            cwd: info.cwd,
            workspaceRoot: '/w',
            os: 'darwin 25',
            date: '2026-07-02',
            gitBranch: 'main',
            model: info.model,
            permissionMode: info.permissionMode,
          }),
          renderModelSection(info.model, [{ id: info.model }]),
          renderMemoryPreamble({ workspaceRoot: '/w' }),
          renderProfileSection([{ name: 'researcher' }]),
          renderMcpSection([{ server: 'fs', status: 'connected', toolCount: 2 }], ['github']),
        ),
    });
    const sid = await kernel.startSession({ model: 'm-1', cwd: '/w' });
    const row = await store.getSession(sid);
    const sys = String(((row?.messages as CanonMessage[])[0]!).content);
    for (const marker of ['# 环境', '# 可用模型', '# 长期记忆', '# 子代理画像', '# MCP server']) {
      expect(sys).toContain(marker);
    }
  });
});
