import { describe, it, expect } from 'vitest';
import {
  fmtInt,
  fmtCost,
  shortPath,
  previewOutput,
  summarizeInput,
  toolIcon,
  riskColor,
  statusBar,
  parseSlash,
} from '@yo-agent/surface-cli';

describe('4.5 — tui-format 纯函数', () => {
  it('fmtInt：千/百万缩写', () => {
    expect(fmtInt(0)).toBe('0');
    expect(fmtInt(42)).toBe('42');
    expect(fmtInt(1234)).toBe('1.2k');
    expect(fmtInt(42_000)).toBe('42k');
    expect(fmtInt(2_500_000)).toBe('2.5M');
  });

  it('fmtCost：0/微额/常规', () => {
    expect(fmtCost(undefined)).toBe('$0');
    expect(fmtCost(0)).toBe('$0');
    expect(fmtCost(0.0012)).toBe('$0.0012');
    expect(fmtCost(1.234)).toBe('$1.23');
  });

  it('shortPath：家目录折叠为 ~', () => {
    expect(shortPath('/home/u/proj', '/home/u')).toBe('~/proj');
    expect(shortPath('/home/u', '/home/u')).toBe('~');
    expect(shortPath('/etc/x', '/home/u')).toBe('/etc/x');
  });

  it('previewOutput：取末 N 行 + 每行截断', () => {
    expect(previewOutput('')).toEqual([]);
    expect(previewOutput('a\nb\nc\n\n')).toEqual(['a', 'b', 'c']);
    expect(previewOutput('1\n2\n3\n4', 2)).toEqual(['3', '4']);
    expect(previewOutput('x'.repeat(10), 8, 5)).toEqual(['xxxx…']);
  });

  it('summarizeInput：字符串/对象/截断', () => {
    expect(summarizeInput(null)).toBe('');
    expect(summarizeInput('hi')).toBe('hi');
    expect(summarizeInput({ a: 1 })).toBe('{"a":1}');
    expect(summarizeInput('y'.repeat(200)).endsWith('…')).toBe(true);
  });

  it('toolIcon / riskColor', () => {
    expect(toolIcon(undefined)).toBe('·');
    expect(toolIcon('ok')).toBe('✓');
    expect(toolIcon('error')).toBe('✗');
    expect(riskColor('low')).toBe('green');
    expect(riskColor('high')).toBe('red');
    expect(riskColor('unknown')).toBe('magenta');
  });

  it('statusBar：含 model/模式/箭头计数/成本/cwd', () => {
    const s = statusBar({ model: 'gpt-5.5', mode: 'supervised', inTok: 1200, outTok: 300, cacheTok: 0, costUsd: 0.02, cwd: '/tmp/x' });
    expect(s).toContain('gpt-5.5');
    expect(s).toContain('supervised');
    expect(s).toContain('↑1.2k');
    expect(s).toContain('↓300');
    expect(s).toContain('$0.02');
    expect(s).toContain('/tmp/x');
    expect(s).not.toContain('cache'); // cacheTok=0 不显示
  });

  it('parseSlash：识别已知命令、忽略未知', () => {
    expect(parseSlash('/help')).toBe('/help');
    expect(parseSlash('/model anthropic')).toBe('/model');
    expect(parseSlash('/nope')).toBeNull();
    expect(parseSlash('hello')).toBeNull();
  });
});
