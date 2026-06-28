import { describe, it, expect } from 'vitest';
import { DefaultPolicyEngine } from '@yo-agent/kernel';
import type { PermissionMode, RiskLevel, ToolKind } from '@yo-agent/protocol';
import type { ToolApproval } from '@yo-agent/tools';

const engine = new DefaultPolicyEngine();
const decide = (
  mode: PermissionMode,
  kind: ToolKind,
  risk: RiskLevel = 'medium',
  approval: ToolApproval = 'risk-based',
) => engine.decide({ permissionMode: mode, kind, risk, approval, toolName: 't' });

const ALL_MODES: PermissionMode[] = ['read-only', 'supervised', 'accept-edits', 'autonomous', 'ci', 'bypass'];
const ALL_KINDS: ToolKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'];

describe('4A — DefaultPolicyEngine 权限闸门决策矩阵', () => {
  it('approval:never 恒放行（任何模式 / 任何 kind / 任何 risk，不可被升级为审批或拒）', () => {
    for (const mode of ALL_MODES) {
      for (const kind of ALL_KINDS) {
        expect(decide(mode, kind, 'high', 'never')).toBe('allow');
      }
    }
  });

  it('supervised（默认档）：所有非 never 工具 → ask（逐字等价既有行为，4A 不改运行时行为的基石）', () => {
    for (const kind of ALL_KINDS) {
      expect(decide('supervised', kind, 'low')).toBe('ask');
      expect(decide('supervised', kind, 'high')).toBe('ask');
    }
  });

  it('bypass：全放行（明示危险）', () => {
    for (const kind of ALL_KINDS) expect(decide('bypass', kind, 'high')).toBe('allow');
  });

  it('read-only：仅放行读类（read/search/think），编辑/执行/删除/网络/其它一律拒（不弹审批）', () => {
    expect(decide('read-only', 'read')).toBe('allow');
    expect(decide('read-only', 'search')).toBe('allow');
    expect(decide('read-only', 'think')).toBe('allow');
    for (const kind of ['edit', 'move', 'delete', 'execute', 'fetch', 'other'] as ToolKind[]) {
      expect(decide('read-only', kind)).toBe('deny');
    }
  });

  it('accept-edits：读类 + 编辑类放行；危险类/网络/其它走审批', () => {
    for (const kind of ['read', 'search', 'think', 'edit', 'move'] as ToolKind[]) {
      expect(decide('accept-edits', kind)).toBe('allow');
    }
    for (const kind of ['execute', 'delete', 'fetch', 'other'] as ToolKind[]) {
      expect(decide('accept-edits', kind)).toBe('ask');
    }
  });

  it('autonomous：高/未知风险 → ask；低/中风险 → allow', () => {
    expect(decide('autonomous', 'execute', 'high')).toBe('ask');
    expect(decide('autonomous', 'other', 'unknown')).toBe('ask');
    expect(decide('autonomous', 'edit', 'medium')).toBe('allow');
    expect(decide('autonomous', 'read', 'low')).toBe('allow');
  });

  it('ci（非交互）：危险类恒拒；高/未知风险拒；低/中风险非危险类放行', () => {
    expect(decide('ci', 'execute', 'low')).toBe('deny'); // 危险类即便低风险也拒
    expect(decide('ci', 'delete', 'low')).toBe('deny');
    expect(decide('ci', 'edit', 'high')).toBe('deny'); // 高风险拒
    expect(decide('ci', 'fetch', 'unknown')).toBe('deny'); // 未知拒
    expect(decide('ci', 'read', 'low')).toBe('allow');
    expect(decide('ci', 'edit', 'medium')).toBe('allow');
  });

  it('read-only 下危险/编辑工具直接 deny，绝不返回 ask（不可被绕过弹审批）', () => {
    for (const kind of ['edit', 'execute', 'delete'] as ToolKind[]) {
      const d = decide('read-only', kind, 'high');
      expect(d).toBe('deny');
      expect(d).not.toBe('ask');
      expect(d).not.toBe('allow');
    }
  });

  // ───── 收口安全修复回归 ─────

  it('收口 4A-H：accept-edits 对高/未知风险编辑类 → ask（不无视风险放行 Protected Path 写入）', () => {
    expect(decide('accept-edits', 'edit', 'high')).toBe('ask');
    expect(decide('accept-edits', 'move', 'unknown')).toBe('ask');
    // 低/中风险编辑仍自动放行（accept-edits 本意）
    expect(decide('accept-edits', 'edit', 'medium')).toBe('allow');
    expect(decide('accept-edits', 'edit', 'low')).toBe('allow');
    // 读类不受影响
    expect(decide('accept-edits', 'read', 'high')).toBe('allow');
  });

  it("收口 4A-MED：approval:'always' 在非 bypass 档恒 ask（必经审批契约不被自动放行软化）", () => {
    for (const mode of ['accept-edits', 'autonomous', 'ci'] as PermissionMode[]) {
      expect(decide(mode, 'edit', 'low', 'always')).toBe('ask'); // 低风险也强制审批
      expect(decide(mode, 'read', 'low', 'always')).toBe('ask');
    }
    expect(decide('supervised', 'read', 'low', 'always')).toBe('ask');
    // bypass 明示 opt-out：always 也放行
    expect(decide('bypass', 'edit', 'high', 'always')).toBe('allow');
    // read-only 优先于 always：非读类恒 deny（最严档不被 always 软化成 ask）
    expect(decide('read-only', 'edit', 'low', 'always')).toBe('deny');
    // never 优先于一切（含 always 语义不冲突——never 工具不会同时是 always）
  });
});
