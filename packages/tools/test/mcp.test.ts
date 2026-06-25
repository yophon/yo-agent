import { describe, it, expect } from 'vitest';
import {
  mcpToolName,
  sanitizeMcpServerName,
  isMcpToolName,
  clampMcpApproval,
  sanitizeMcpInputSchema,
} from '@yo-agent/tools';

describe('MCP host 命名护栏（§15.3）', () => {
  it('mcpToolName 强制 mcp__{server}__{tool} + server 规范化', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
    expect(mcpToolName('My Server!', 'do')).toBe('mcp__my_server__do');
    expect(mcpToolName('a.b/c', 'x')).toBe('mcp__a_b_c__x');
  });

  it('sanitizeMcpServerName 折叠/裁剪非法字符；全非法抛错', () => {
    expect(sanitizeMcpServerName('  Foo__Bar  ')).toBe('foo_bar');
    expect(() => sanitizeMcpServerName('***')).toThrow();
  });

  it('isMcpToolName 判定前缀', () => {
    expect(isMcpToolName('mcp__x__y')).toBe(true);
    expect(isMcpToolName('read')).toBe(false);
  });

  it('空 tool 名抛错', () => {
    expect(() => mcpToolName('s', '')).toThrow();
  });
});

describe('MCP 审批 clamp（外部工具永不 never）', () => {
  it('never / undefined → risk-based，其余保留', () => {
    expect(clampMcpApproval('never')).toBe('risk-based');
    expect(clampMcpApproval(undefined)).toBe('risk-based');
    expect(clampMcpApproval('always')).toBe('always');
    expect(clampMcpApproval('risk-based')).toBe('risk-based');
  });
});

describe('MCP schema 清洗（防供应链：超深/超大/注入式 description）', () => {
  it('顶层非对象 → {type:object}', () => {
    expect(sanitizeMcpInputSchema('nope')).toEqual({ type: 'object' });
    expect(sanitizeMcpInputSchema(null)).toEqual({ type: 'object' });
    expect(sanitizeMcpInputSchema([1, 2])).toEqual({ type: 'object' });
  });

  it('正常 schema 原样保留', () => {
    const s = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(sanitizeMcpInputSchema(s)).toEqual(s);
  });

  it('超长字符串（含 description）截断', () => {
    const long = 'x'.repeat(10_000);
    const out = sanitizeMcpInputSchema({ type: 'object', description: long }, { maxStringLen: 100 });
    expect((out.description as string).length).toBe(100);
  });

  it('超深嵌套降级为 {type:object} 且不抛、有界', () => {
    let deep: Record<string, unknown> = { type: 'object' };
    for (let i = 0; i < 50; i++) deep = { type: 'object', properties: { n: deep } };
    const out = sanitizeMcpInputSchema(deep, { maxDepth: 4 });
    expect(JSON.stringify(out)).toContain('"type":"object"');
    expect(JSON.stringify(out).length).toBeLessThan(500);
  });

  it('超多属性截断', () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) props['p' + i] = { type: 'string' };
    const out = sanitizeMcpInputSchema({ type: 'object', properties: props }, { maxProps: 10 });
    expect(Object.keys(out.properties as object).length).toBeLessThanOrEqual(10);
  });

  it('循环引用兜底不抛', () => {
    const a: Record<string, unknown> = { type: 'object' };
    a.self = a;
    expect(() => sanitizeMcpInputSchema(a)).not.toThrow();
  });
});
