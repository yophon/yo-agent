import type { ApprovalDecision, Id, PermissionMode, RiskLevel, StopReason, ToolKind } from '@yo-agent/protocol';

/**
 * 生命周期 Hook 矩阵（DESIGN §8 / §11，对齐 Claude Code hook 范式）。
 *
 * 本期（Phase 4A）只做**进程内同步/异步 hook**——注册表 + turn 循环确定性调用点。
 * 不可信插件的跨进程 Worker 隔离在 4E（HookBus 形态不变，调用经 IPC 中转）。
 *
 * 用途分层（§8 决策矩阵）：确定性强制 → Hook（如 PreToolUse 拦命令）；知识/规范 → yo.md/skill。
 */
export type HookPoint =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'OnApproval';

export interface HookContext {
  sessionId: Id;
  cwd: string;
  permissionMode: PermissionMode;
}

export interface PreToolUsePayload {
  tool: string;
  kind: ToolKind;
  input: unknown;
}

/** PreToolUse 裁决：allow（可带 input 改写）/ deny（带原因）。 */
export type PreToolUseDecision = { decision: 'allow'; input?: unknown } | { decision: 'deny'; reason?: string };

/** 内核侧拿到的归一结果：input 恒为「经各 hook 链式改写后的最终值」。 */
export type PreToolUseResult = { decision: 'allow' | 'deny'; input: unknown; reason?: string };

export interface PostToolUsePayload {
  tool: string;
  kind: ToolKind;
  input: unknown;
  output: string;
  isError: boolean;
}

export interface ApprovalHookPayload {
  tool: string;
  risk: RiskLevel;
  decision: ApprovalDecision;
}

/**
 * Hook 集合（全部可选）。注册多个 Hooks 对象，按注册序触发。
 * PreToolUse 可返回裁决；其余为观测型（返回值忽略）。
 */
export interface Hooks {
  onSessionStart?(ctx: HookContext): void | Promise<void>;
  onUserPromptSubmit?(ctx: HookContext, prompt: string): void | Promise<void>;
  onPreToolUse?(
    ctx: HookContext,
    payload: PreToolUsePayload,
  ): PreToolUseDecision | void | Promise<PreToolUseDecision | void>;
  onPostToolUse?(ctx: HookContext, payload: PostToolUsePayload): void | Promise<void>;
  onPreCompact?(ctx: HookContext): void | Promise<void>;
  onStop?(ctx: HookContext, stopReason: StopReason): void | Promise<void>;
  onSubagentStart?(ctx: HookContext, label: string): void | Promise<void>;
  onSubagentStop?(ctx: HookContext, summary: string): void | Promise<void>;
  onApproval?(ctx: HookContext, payload: ApprovalHookPayload): void | Promise<void>;
}

/** 观测型 hook 异常的去向（内核接 → emit Error 事件，「不吞掉」）。可 async，runEach 会 await。 */
export type HookErrorSink = (point: HookPoint, err: unknown) => void | Promise<void>;

/**
 * Hook 总线：注册 + 确定性触发。
 *
 * 异常语义：
 *   - **PreToolUse（安全闸门）fail-closed**：hook 抛错 → 视为 deny（reason 带错误信息）——既不吞错（reason 可见，
 *     内核回 tool_result error），又不拖垮 turn。
 *   - **观测型 hook fail-open**：单个 hook 抛错经 onError sink 上报（内核 emit Error），不影响其余 hook 与 turn。
 */
export class HookBus {
  private readonly hooks: Hooks[] = [];

  register(h: Hooks): () => void {
    this.hooks.push(h);
    return () => {
      const i = this.hooks.indexOf(h);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** 已注册 hooks 数（测试/可观测用）。 */
  get size(): number {
    return this.hooks.length;
  }

  /**
   * PreToolUse：链式三态。任一 hook deny → 立即短路返回 deny；allow{input} → 链式改写后续 hook 见改写值。
   * fail-closed：hook 抛错 → deny（reason=错误信息）。返回的 input 恒为最终（可能被改写的）值。
   */
  async firePreToolUse(ctx: HookContext, payload: PreToolUsePayload): Promise<PreToolUseResult> {
    let input = payload.input;
    for (const h of this.hooks) {
      if (!h.onPreToolUse) continue;
      let r: PreToolUseDecision | void;
      try {
        r = await h.onPreToolUse(ctx, { ...payload, input });
      } catch (e) {
        return { decision: 'deny', input, reason: e instanceof Error ? e.message : String(e) };
      }
      if (!r) continue;
      if (r.decision === 'deny') return { decision: 'deny', input, reason: r.reason };
      if (r.input !== undefined) input = r.input;
    }
    return { decision: 'allow', input };
  }

  fireSessionStart(ctx: HookContext, onError?: HookErrorSink): Promise<void> {
    return this.runEach('SessionStart', (h) => h.onSessionStart?.(ctx), onError);
  }

  fireUserPromptSubmit(ctx: HookContext, prompt: string, onError?: HookErrorSink): Promise<void> {
    return this.runEach('UserPromptSubmit', (h) => h.onUserPromptSubmit?.(ctx, prompt), onError);
  }

  firePostToolUse(ctx: HookContext, payload: PostToolUsePayload, onError?: HookErrorSink): Promise<void> {
    return this.runEach('PostToolUse', (h) => h.onPostToolUse?.(ctx, payload), onError);
  }

  firePreCompact(ctx: HookContext, onError?: HookErrorSink): Promise<void> {
    return this.runEach('PreCompact', (h) => h.onPreCompact?.(ctx), onError);
  }

  fireStop(ctx: HookContext, stopReason: StopReason, onError?: HookErrorSink): Promise<void> {
    return this.runEach('Stop', (h) => h.onStop?.(ctx, stopReason), onError);
  }

  fireSubagentStart(ctx: HookContext, label: string, onError?: HookErrorSink): Promise<void> {
    return this.runEach('SubagentStart', (h) => h.onSubagentStart?.(ctx, label), onError);
  }

  fireSubagentStop(ctx: HookContext, summary: string, onError?: HookErrorSink): Promise<void> {
    return this.runEach('SubagentStop', (h) => h.onSubagentStop?.(ctx, summary), onError);
  }

  fireApproval(ctx: HookContext, payload: ApprovalHookPayload, onError?: HookErrorSink): Promise<void> {
    return this.runEach('OnApproval', (h) => h.onApproval?.(ctx, payload), onError);
  }

  /** 逐 hook 触发观测型回调；单个抛错经 onError 上报后继续（不吞、不拖垮）。 */
  private async runEach(
    point: HookPoint,
    run: (h: Hooks) => void | Promise<void>,
    onError?: HookErrorSink,
  ): Promise<void> {
    for (const h of this.hooks) {
      try {
        await run(h);
      } catch (e) {
        await onError?.(point, e);
      }
    }
  }
}
