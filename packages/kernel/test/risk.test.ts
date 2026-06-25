import { describe, it, expect } from 'vitest';
import { assessRisk } from '@yo-agent/kernel';
import type { ToolDescriptor } from '@yo-agent/tools';

const desc = (over: Partial<ToolDescriptor>): ToolDescriptor => ({
  name: 't',
  kind: 'other',
  description: '',
  inputSchema: {},
  owner: 'core',
  availability: { always: true },
  approval: 'risk-based',
  ...over,
});

describe('assessRisk（替换硬编码 unknown）', () => {
  it('undefined → unknown；approval never → low', () => {
    expect(assessRisk(undefined, {})).toBe('unknown');
    expect(assessRisk(desc({ approval: 'never' }), {})).toBe('low');
  });

  it('ToolKind 静态分级（内置）', () => {
    expect(assessRisk(desc({ kind: 'read' }), {})).toBe('low');
    expect(assessRisk(desc({ kind: 'search' }), {})).toBe('low');
    expect(assessRisk(desc({ kind: 'edit' }), {})).toBe('medium');
    expect(assessRisk(desc({ kind: 'move' }), {})).toBe('medium');
    expect(assessRisk(desc({ kind: 'delete' }), {})).toBe('high');
    expect(assessRisk(desc({ kind: 'execute' }), {})).toBe('high');
  });

  it('外部工具（owner!=core）读类基线也取 medium', () => {
    expect(assessRisk(desc({ kind: 'read', owner: 'mcp' }), {})).toBe('medium');
    expect(assessRisk(desc({ kind: 'other', owner: 'mcp' }), {})).toBe('medium');
  });

  it('保护路径命中 → high（覆盖 write 到 protected path）', () => {
    expect(assessRisk(desc({ kind: 'edit' }), { path: '.ssh/id_rsa' })).toBe('high');
    expect(assessRisk(desc({ kind: 'edit' }), { path: 'project/.git/config' })).toBe('high');
    expect(assessRisk(desc({ kind: 'edit' }), { path: 'deploy/secret.pem' })).toBe('high');
  });

  it('危险命令命中 → high', () => {
    expect(assessRisk(desc({ kind: 'execute' }), { command: 'rm -rf /' })).toBe('high');
    expect(assessRisk(desc({ kind: 'read', owner: 'mcp' }), { args: ['mkfs', '/dev/sda'] })).toBe('high');
  });

  it('普通路径不升级', () => {
    expect(assessRisk(desc({ kind: 'edit' }), { path: 'src/app.ts' })).toBe('medium');
  });
});
