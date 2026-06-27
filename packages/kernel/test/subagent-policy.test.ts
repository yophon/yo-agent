import { describe, it, expect } from 'vitest';
import { deriveSubagentPolicy } from '@yo-agent/kernel';

describe('4C — deriveSubagentPolicy（只收紧，绝不放宽）', () => {
  it('权限模式：取 requested 与 parent 中更严者（绝不放宽 parent）', () => {
    // 请求更宽（bypass）→ 仍夹到 parent（autonomous）
    expect(deriveSubagentPolicy({ parentMode: 'autonomous', parentTools: [], requestedMode: 'bypass' }).permissionMode).toBe('autonomous');
    // 请求更严（read-only）→ 采用更严者
    expect(deriveSubagentPolicy({ parentMode: 'supervised', parentTools: [], requestedMode: 'read-only' }).permissionMode).toBe('read-only');
    // 未请求 → 沿用 parent
    expect(deriveSubagentPolicy({ parentMode: 'accept-edits', parentTools: [] }).permissionMode).toBe('accept-edits');
    // parent 本就很严，请求更宽也无效
    expect(deriveSubagentPolicy({ parentMode: 'read-only', parentTools: [], requestedMode: 'autonomous' }).permissionMode).toBe('read-only');
  });

  it('工具集：⊆ parent，且恒剥离 subagent_spawn（防递归）', () => {
    const d = deriveSubagentPolicy({ parentMode: 'supervised', parentTools: ['read', 'write', 'subagent_spawn'] });
    expect(d.toolAllowlist).toEqual(['read', 'write']); // spawn 被剥离
  });

  it('请求白名单与 parent 取交集：parent 没有的工具拿不到', () => {
    const d = deriveSubagentPolicy({
      parentMode: 'supervised',
      parentTools: ['read', 'write'],
      requestedTools: ['read', 'net', 'subagent_spawn'],
    });
    expect(d.toolAllowlist).toEqual(['read']); // net 不在 parent、spawn 被剥离
  });

  it('去重且保序', () => {
    const d = deriveSubagentPolicy({ parentMode: 'supervised', parentTools: ['read', 'read', 'write'] });
    expect(d.toolAllowlist).toEqual(['read', 'write']);
  });
});
