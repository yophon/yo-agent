import { describe, it, expect } from 'vitest';
import {
  RpcMethod,
  RpcServerMethod,
  TurnStartParamsSchema,
  ApprovalDecideParamsSchema,
  SessionResumeParamsSchema,
} from '@yo-agent/protocol';

describe('JSON-RPC 方法表', () => {
  it('方法名与 codex app-server / yo-aichat 对齐', () => {
    expect(RpcMethod.TurnStart).toBe('turn/start');
    expect(RpcMethod.SessionResume).toBe('session/resume');
    expect(RpcServerMethod.ApprovalRequest).toBe('approval/request');
  });

  it('turn/start 需要 idemKey（防双计费）', () => {
    expect(TurnStartParamsSchema.safeParse({ sessionId: 's', prompt: 'hi', idemKey: 'k' }).success).toBe(true);
    expect(TurnStartParamsSchema.safeParse({ sessionId: 's', prompt: 'hi' }).success).toBe(false);
  });

  it('approval/decide 仅接受四选项', () => {
    expect(ApprovalDecideParamsSchema.safeParse({ requestId: 'r', decision: 'allow_once' }).success).toBe(true);
    expect(ApprovalDecideParamsSchema.safeParse({ requestId: 'r', decision: 'maybe' }).success).toBe(false);
  });

  it('session/resume 接受 "last" 续接最近会话', () => {
    expect(SessionResumeParamsSchema.safeParse({ sessionId: 'last' }).success).toBe(true);
  });
});
