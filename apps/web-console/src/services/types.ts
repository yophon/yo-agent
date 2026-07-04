/**
 * 控制台配置域类型（Phase 5.1d）——全部可序列化（IndexedDB 直存 / 将来后端同步）。
 * DeclarativeHttpTool 是 defineHttpTool 的声明式子集：函数式字段（headers()/request/mapResponse）
 * 不进配置面，需要时走代码集成。
 */
import type { WebProviderKind } from '@yo-agent/surface-web';

export interface DeclarativeHttpTool {
  name: string;
  /** 给 LLM 的用途描述。 */
  description: string;
  /** JSON Schema 7 文本（编辑态存文本，保存/物化时 parse 校验）。 */
  inputSchemaJson: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  credentials?: 'omit' | 'same-origin' | 'include';
}

export interface AgentConnectionConfig {
  provider: WebProviderKind;
  model: string;
  /** 自建代理 / 中转站；空 = 官方端点（此时 apiKey 必填）。 */
  baseUrl?: string;
  apiKey?: string;
  headers: Record<string, string>;
}

export interface AgentConfigRecord {
  id: string;
  name: string;
  /** 侧栏色点/头像底色。 */
  color: string;
  connection: AgentConnectionConfig;
  system: string;
  /** auto=全自动放行（防线在后端工具 API）；confirm=控制台弹窗真人确认。 */
  approvalMode: 'auto' | 'confirm';
  compaction: boolean;
  loopBreakerMode: 'off' | 'loose' | 'strict';
  tools: DeclarativeHttpTool[];
  createdAt: number;
  updatedAt: number;
}

/** 会话元数据（控制台自有，补 SessionRow 之外的展示信息）。 */
export interface SessionMeta {
  sessionId: string;
  /** 手动改名；缺省用首条 UserMessage 截断。 */
  title?: string;
}

export const AGENT_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'] as const;

export function newAgentRecord(): AgentConfigRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: '',
    color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)] as string,
    connection: { provider: 'openai', model: '', baseUrl: '', apiKey: '', headers: {} },
    system: '',
    approvalMode: 'auto',
    compaction: false,
    loopBreakerMode: 'loose',
    tools: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 客服工具模板（一键填入，对接 apps/demo-backend）。 */
export function demoToolTemplates(base = 'http://localhost:8788', token = 'demo-123'): DeclarativeHttpTool[] {
  return [
    {
      name: 'order_query',
      description: '按订单号查询订单状态、物流与预计送达时间。',
      inputSchemaJson: JSON.stringify(
        { type: 'object', properties: { orderId: { type: 'string', description: '订单号' } }, required: ['orderId'] },
        null,
        2,
      ),
      url: `${base}/api/tools/order_query`,
      method: 'POST',
      headers: { 'x-demo-token': token },
    },
    {
      name: 'ticket_create',
      description: '为用户创建售后/人工跟进工单，返回工单号。',
      inputSchemaJson: JSON.stringify(
        {
          type: 'object',
          properties: { title: { type: 'string', description: '一句话概括' }, detail: { type: 'string' } },
          required: ['title'],
        },
        null,
        2,
      ),
      url: `${base}/api/tools/ticket_create`,
      method: 'POST',
      headers: { 'x-demo-token': token },
    },
  ];
}
