import { describe, expect, it } from 'vitest';
import { parseHeaders, stringifyHeaders, validateAgent } from '../src/services/agent-form';
import { demoToolTemplates, newAgentRecord } from '../src/services/types';

function valid() {
  const r = newAgentRecord();
  r.name = '客服';
  r.connection.model = 'gpt-5.5';
  r.connection.baseUrl = 'http://localhost:8788/v1';
  return r;
}

describe('validateAgent（配置表单校验）', () => {
  it('合法配置零错误；模板工具可直接通过', () => {
    const r = valid();
    r.tools = demoToolTemplates();
    expect(validateAgent(r)).toEqual([]);
  });

  it('缺名称/模型/连接凭据 → 可行动错误', () => {
    const r = newAgentRecord();
    const errs = validateAgent(r);
    expect(errs.join()).toContain('名称必填');
    expect(errs.join()).toContain('模型必填');
    expect(errs.join()).toContain('API Key');
  });

  it('有 baseUrl 时 apiKey 可空（模式 A）；坏 baseUrl 报错', () => {
    const r = valid();
    expect(validateAgent(r)).toEqual([]);
    r.connection.baseUrl = 'localhost:8788';
    expect(validateAgent(r).join()).toContain('http(s)://');
  });

  it('工具校验：坏名/缺描述/坏 url/坏 schema/重名逐条报', () => {
    const r = valid();
    r.tools = [
      { name: '1bad', description: '', inputSchemaJson: '{', url: 'ftp://x', method: 'POST', headers: {} },
      ...demoToolTemplates(),
      demoToolTemplates()[0] as never,
    ];
    const errs = validateAgent(r);
    expect(errs.join()).toContain('名称须为字母开头');
    expect(errs.join()).toContain('description 必填');
    expect(errs.join()).toContain('http(s)://');
    expect(errs.join()).toContain('不是合法 JSON');
    expect(errs.join()).toContain('工具名重复：order_query');
  });
});

describe('headers 编辑态往返', () => {
  it('parse ⇆ stringify 保序往返，忽略坏行', () => {
    const text = 'x-demo-token: demo-123\nauthorization: Bearer abc:def\n没有冒号的行\n: 空键';
    const parsed = parseHeaders(text);
    expect(parsed).toEqual({ 'x-demo-token': 'demo-123', authorization: 'Bearer abc:def' });
    expect(parseHeaders(stringifyHeaders(parsed))).toEqual(parsed);
  });
});
