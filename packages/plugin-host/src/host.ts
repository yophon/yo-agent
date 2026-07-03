import type { RegisteredTool, ToolContext, ToolEvent, ToolExecutorRef, ToolRegistry } from '@yo-agent/tools';
import type {
  HookContext,
  Hooks,
  PreToolUseDecision,
  PreToolUsePayload,
  PreToolUseResult,
} from '@yo-agent/kernel';
import type { PluginManifest, PluginToolDecl } from './protocol';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  PLUGIN_PROTOCOL_VERSION,
  pluginHealthFlag,
} from './protocol';
import type { PluginTransport, PluginTransportEvents } from './transport';

/**
 * PluginHost（4E / ADR-18）：让第三方插件（不可信代码）注册工具/消费 hook，但**在 Worker 内 IPC 隔离运行，
 * 崩溃不拖垮主进程（退出标准③）**。
 *
 * 三条安全不变量（针对性安全单测兜底）：
 *   1. **崩溃围栏 + 心跳降级**：Worker 崩溃（'error'/非 0 'exit'）或心跳看门狗判死 → 主进程存活 + 撤健康标志
 *      （工具经 availability configFlag 从 resolveAvailable 消失，复用 3C 范式）+ 拒在飞调用 + 重连恢复。
 *   2. **不绕审批**：插件工具以 owner:'plugin'、approval 恒非 'never' 注册进主 registry，经 kernel
 *      PreToolUse→PolicyEngine→approval 把关**之后**才下发 invoke 给 Worker。
 *   3. **secret 隔离**：Worker env 由 transport 按白名单剥离（插件读不到主进程 API key/设备私钥/OAuth）。
 *
 * host 只依赖 {@link PluginTransport} 抽象——生产用 WorkerPluginTransport（真 worker_threads），
 * 测试用内存假传输确定性模拟崩溃/心跳丢失。
 */

export interface PluginSpec {
  id: string;
}

export interface PluginHostOpts {
  registry: ToolRegistry;
  /** 按 spec + 重连次数造传输（生产 = WorkerPluginTransport，测试 = 假传输）。 */
  transportFor: (spec: PluginSpec, attempt: number) => PluginTransport;
  log?: (msg: string) => void;
  /** 时钟（心跳看门狗判活基准）；缺省 Date.now，测试可注入。 */
  now?: () => number;
  heartbeatTimeoutMs?: number;
  callTimeoutMs?: number;
  hookTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** 崩溃后最多自动重连次数（每插件）；默认 3。0 = 不重连。 */
  maxReconnect?: number;
}

type PendingTool = {
  kind: 'tool';
  push(chunk: string): void;
  finish(err?: Error): void;
};
type PendingHook = {
  kind: 'hook';
  resolve(decision: PreToolUseDecision | undefined): void;
  timer: ReturnType<typeof setTimeout>;
};
type Pending = PendingTool | PendingHook;

interface PluginRuntime {
  spec: PluginSpec;
  transport: PluginTransport;
  manifest?: PluginManifest;
  healthy: boolean;
  lastHeartbeatAt: number;
  attempt: number;
  /** 是否已为本次崩溃排程重连（去重，审查 4E-MED：替代易截断重连链的 attempt>0 启发式）。 */
  reconnecting: boolean;
  /** 已注册进 registry 的工具名（closeAll/reconnect 调和用）。 */
  registeredTools: Set<string>;
  pending: Map<number, Pending>;
  hookPoints: Set<string>;
}

export class DefaultPluginHost {
  private readonly o: Required<Omit<PluginHostOpts, 'log'>> & Pick<PluginHostOpts, 'log'>;
  private readonly plugins = new Map<string, PluginRuntime>();
  private callSeq = 0;
  private watchdog?: ReturnType<typeof setInterval>;
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private closing = false;

  constructor(opts: PluginHostOpts) {
    this.o = {
      registry: opts.registry,
      transportFor: opts.transportFor,
      now: opts.now ?? (() => Date.now()),
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      callTimeoutMs: opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      hookTimeoutMs: opts.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      maxReconnect: opts.maxReconnect ?? 3,
      log: opts.log,
    };
  }

  /** 启动一批插件（各自握手 ready 后注册工具）；单个失败不影响其余。返回成功握手的插件 id。 */
  async start(specs: PluginSpec[]): Promise<string[]> {
    if (this.watchdog === undefined) {
      this.watchdog = setInterval(() => this.checkHeartbeats(), Math.max(250, this.o.heartbeatTimeoutMs / 2));
      this.watchdog.unref?.();
    }
    const ok: string[] = [];
    await Promise.all(
      specs.map(async (spec) => {
        try {
          await this.launch(spec, 0);
          ok.push(spec.id);
        } catch (e) {
          this.log(`[plugin] ${spec.id} 启动失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
    return ok;
  }

  /** 健康插件的 availability 标志集（喂 kernel.toolFlags）；崩溃/未就绪插件不在内 → 其工具不可见。 */
  flags(): string[] {
    const out: string[] = [];
    for (const p of this.plugins.values()) if (p.healthy) out.push(pluginHealthFlag(p.spec.id));
    return out;
  }

  isHealthy(id: string): boolean {
    return this.plugins.get(id)?.healthy ?? false;
  }

  /**
   * 聚合 Hooks 对象：注册进 kernel HookBus 一次，按插件订阅 fan-out 经 IPC。
   * **关键不变量**：插件不可用/超时/崩溃时**绝不抛错**——返回 void（PreToolUse 视为放行）。
   * 否则 HookBus 的 PreToolUse fail-closed 会因一个挂掉的插件拒掉主循环所有工具（违背退出标准③）。
   */
  hooks(): Hooks {
    return {
      onPreToolUse: (ctx, payload) => this.firePreToolUse(ctx, payload),
      onPostToolUse: (ctx, payload) => this.fireObservational('PostToolUse', ctx, payload),
      onSessionStart: (ctx) => this.fireObservational('SessionStart', ctx, {}),
      onUserPromptSubmit: (ctx, prompt) => this.fireObservational('UserPromptSubmit', ctx, { prompt }),
      onPreCompact: (ctx) => this.fireObservational('PreCompact', ctx, {}),
      onStop: (ctx, stopReason) => this.fireObservational('Stop', ctx, { stopReason }),
      onSubagentStart: (ctx, label) => this.fireObservational('SubagentStart', ctx, { label }),
      onSubagentStop: (ctx, summary) => this.fireObservational('SubagentStop', ctx, { summary }),
      onApproval: (ctx, payload) => this.fireObservational('OnApproval', ctx, payload),
    };
  }

  /** 看门狗：心跳超时未达 → 判死 → 降级 + 重连。生产由 setInterval 驱动，测试可直接调。 */
  checkHeartbeats(): void {
    const now = this.o.now();
    for (const p of this.plugins.values()) {
      if (p.healthy && now - p.lastHeartbeatAt > this.o.heartbeatTimeoutMs) {
        this.degrade(p, `心跳超时（${now - p.lastHeartbeatAt}ms 未收）`);
      }
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    for (const t of this.reconnectTimers) clearTimeout(t);
    this.reconnectTimers.clear();
    const all = [...this.plugins.values()];
    this.plugins.clear();
    await Promise.all(
      all.map(async (p) => {
        for (const [, pend] of p.pending) this.settlePending(pend, new Error('插件 host 关闭'));
        p.pending.clear();
        for (const name of p.registeredTools) this.o.registry.unregister(name);
        try {
          p.transport.send({ type: 'shutdown' });
        } catch {
          /* 已死 */
        }
        await p.transport.terminate().catch(() => {});
      }),
    );
  }

  // ───────────────────────── 启动 / 握手 ─────────────────────────

  private launch(spec: PluginSpec, attempt: number): Promise<void> {
    const transport = this.o.transportFor(spec, attempt);
    const existing = this.plugins.get(spec.id);
    const rt: PluginRuntime = existing ?? {
      spec,
      transport,
      healthy: false,
      lastHeartbeatAt: this.o.now(),
      attempt,
      reconnecting: false,
      registeredTools: new Set(),
      pending: new Map(),
      hookPoints: new Set(),
    };
    rt.transport = transport;
    rt.attempt = attempt;
    rt.healthy = false;
    rt.reconnecting = false; // 本次（重）启动进行中 → 清重连去重标志
    this.plugins.set(spec.id, rt);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.degrade(rt, 'ready 握手超时');
        reject(new Error(`插件 ${spec.id} ready 握手超时`));
      }, this.o.readyTimeoutMs);
      readyTimer.unref?.();

      const events: PluginTransportEvents = {
        onReady: (manifest) => {
          if (manifest.name && manifest.name !== spec.id) {
            this.log(`[plugin] ${spec.id} 清单名「${manifest.name}」与 id 不一致（以 id 为准）`);
          }
          rt.manifest = manifest;
          rt.lastHeartbeatAt = this.o.now();
          rt.healthy = true;
          rt.attempt = 0;
          this.registerTools(rt, manifest.tools ?? []);
          rt.hookPoints = new Set(manifest.hooks ?? []);
          if (!settled) {
            settled = true;
            clearTimeout(readyTimer);
            resolve();
          }
          this.log(`[plugin] ${spec.id} 就绪（${rt.registeredTools.size} 工具，${rt.hookPoints.size} hook）`);
        },
        onChunk: (callId, chunk) => {
          const pend = rt.pending.get(callId);
          if (pend?.kind === 'tool') pend.push(chunk);
        },
        onDone: (callId, isError, error) => {
          const pend = rt.pending.get(callId);
          if (pend?.kind === 'tool') {
            rt.pending.delete(callId);
            pend.finish(isError ? new Error(error ?? '插件工具执行失败') : undefined);
          }
        },
        onHookResult: (callId, decision) => {
          const pend = rt.pending.get(callId);
          if (pend?.kind === 'hook') {
            rt.pending.delete(callId);
            clearTimeout(pend.timer);
            pend.resolve(decision);
          }
        },
        onHeartbeat: () => {
          rt.lastHeartbeatAt = this.o.now();
        },
        onLog: (level, msg) => this.log(`[plugin:${spec.id}] ${level}: ${msg}`),
        onCrash: (reason) => {
          if (!settled) {
            settled = true;
            clearTimeout(readyTimer);
            reject(new Error(`插件 ${spec.id} 崩溃：${reason}`));
          }
          this.degrade(rt, reason);
        },
      };
      transport.start(events);
    });
  }

  private registerTools(rt: PluginRuntime, decls: PluginToolDecl[]): void {
    for (const decl of decls) {
      if (rt.registeredTools.has(decl.name)) continue; // 重连：已注册过（configFlag 已随 healthy 恢复可见）
      // 审查 4E-MED：插件工具名不得冒用 MCP 保留命名空间 mcp__server__tool（否则恶意插件可冒名顶替/遮蔽
      // 后注册的 MCP 工具 → confused deputy + 撞名 DoS 掉合法 MCP 工具，因插件先于 MCP 引导注册）。
      if (decl.name.startsWith('mcp__')) {
        this.log(`[plugin] ${rt.spec.id} 工具「${decl.name}」被拒：禁用 MCP 保留前缀 mcp__`);
        continue;
      }
      const tool: RegisteredTool = {
        descriptor: {
          name: decl.name,
          kind: decl.kind,
          description: decl.description,
          inputSchema: decl.inputSchema,
          owner: 'plugin',
          // 绑健康标志：插件崩溃/未就绪 → flag 撤 → 工具从 resolveAvailable 消失（复用 3C 熔断接缝）。
          availability: { configFlag: pluginHealthFlag(rt.spec.id) },
          // 钳制：插件工具绝不可 'never'（不能绕审批）；至多 'always'，缺省 'risk-based'。
          approval: decl.approval === 'always' ? 'always' : 'risk-based',
        },
        executor: this.makeProxyExecutor(rt, decl.name),
      };
      try {
        this.o.registry.register(tool);
        rt.registeredTools.add(decl.name);
      } catch (e) {
        this.log(`[plugin] ${rt.spec.id} 工具「${decl.name}」注册失败（撞名？）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ───────────────────────── 工具代理（经审批后才下发 invoke）─────────────────────────

  private makeProxyExecutor(rt: PluginRuntime, tool: string): ToolExecutorRef {
    const host = this;
    return {
      execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        return host.invokeTool(rt, tool, input, ctx);
      },
    };
  }

  private async *invokeTool(rt: PluginRuntime, tool: string, input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    if (!rt.healthy) throw new Error(`插件 ${rt.spec.id} 不可用（已崩溃/未就绪），工具「${tool}」拒绝执行`);
    const id = ++this.callSeq;
    const queue: string[] = [];
    let finished = false;
    let failure: Error | undefined;
    let wake: (() => void) | null = null;
    const bump = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    const timer = setTimeout(() => {
      if (finished) return;
      failure = new Error(`插件 ${rt.spec.id} 工具「${tool}」超时（${this.o.callTimeoutMs}ms）`);
      finished = true;
      rt.pending.delete(id);
      bump();
    }, this.o.callTimeoutMs);
    timer.unref?.();

    rt.pending.set(id, {
      kind: 'tool',
      push: (chunk) => {
        queue.push(chunk);
        bump();
      },
      finish: (err) => {
        if (err) failure = err;
        finished = true;
        clearTimeout(timer);
        bump();
      },
    });

    // abort（turn 中断）→ 拒该调用（Worker 侧由其自身逻辑感知，本进程不再等待）。
    const onAbort = (): void => {
      if (finished) return;
      failure = new Error('工具调用已取消');
      finished = true;
      rt.pending.delete(id);
      clearTimeout(timer);
      bump();
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      rt.transport.send({ type: 'invoke', id, tool, input, ctx: { sessionId: ctx.sessionId, cwd: ctx.cwd } });
    } catch (e) {
      clearTimeout(timer);
      rt.pending.delete(id);
      ctx.signal?.removeEventListener('abort', onAbort);
      throw e instanceof Error ? e : new Error(String(e));
    }

    try {
      while (true) {
        if (queue.length) {
          yield { kind: 'output', chunk: queue.shift()! };
          continue;
        }
        if (finished) break;
        await new Promise<void>((r) => {
          wake = r;
          if (queue.length || finished) {
            wake = null;
            r();
          }
        });
      }
      if (failure) throw failure;
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
      rt.pending.delete(id);
      clearTimeout(timer);
    }
  }

  // ───────────────────────── Hook 跨进程兑现 ─────────────────────────

  // biome-ignore lint/suspicious/noConfusingVoidType: 与 kernel Hooks.onPreToolUse 的 void 契约对齐
  private async firePreToolUse(ctx: HookContext, payload: PreToolUsePayload): Promise<PreToolUseDecision | void> {
    let input = payload.input;
    let rewritten = false;
    for (const rt of this.plugins.values()) {
      if (!rt.healthy || !rt.hookPoints.has('PreToolUse')) continue;
      const decision = await this.sendHook(rt, 'PreToolUse', ctx, { ...payload, input });
      if (!decision) continue; // 超时/崩溃/无裁决 → 放行（绝不因挂掉的插件拒主循环工具）
      if (decision.decision === 'deny') return { decision: 'deny', reason: decision.reason };
      if (decision.input !== undefined) {
        input = decision.input;
        rewritten = true;
      }
    }
    return rewritten ? { decision: 'allow', input } : undefined;
  }

  private async fireObservational(point: string, ctx: HookContext, payload: unknown): Promise<void> {
    for (const rt of this.plugins.values()) {
      if (!rt.healthy || !rt.hookPoints.has(point)) continue;
      // 观测型：等结果（带超时）但忽略裁决；绝不抛（不拖垮 turn）。
      await this.sendHook(rt, point, ctx, payload).catch(() => undefined);
    }
  }

  /** 发一条 hook IPC，等 hook-result（带超时）。超时/崩溃 → resolve undefined（绝不抛、不拖垮主 turn）。 */
  private sendHook(
    rt: PluginRuntime,
    point: string,
    ctx: HookContext,
    payload: unknown,
  ): Promise<PreToolUseDecision | undefined> {
    if (!rt.healthy) return Promise.resolve(undefined);
    const id = ++this.callSeq;
    return new Promise<PreToolUseDecision | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (rt.pending.delete(id)) resolve(undefined);
      }, this.o.hookTimeoutMs);
      timer.unref?.();
      rt.pending.set(id, { kind: 'hook', resolve, timer });
      try {
        rt.transport.send({
          type: 'hook',
          id,
          point: point as never,
          ctx: { sessionId: ctx.sessionId, cwd: ctx.cwd, permissionMode: ctx.permissionMode },
          payload,
        });
      } catch {
        if (rt.pending.delete(id)) {
          clearTimeout(timer);
          resolve(undefined);
        }
      }
    });
  }

  // ───────────────────────── 降级 / 重连 ─────────────────────────

  /** 判死：撤健康标志（工具消失）→ 拒在飞调用 → 终止 Worker → 排程重连。绝不抛（主进程存活）。 */
  private degrade(rt: PluginRuntime, reason: string): void {
    // 降级动作（撤标志 + 拒在飞 + 终止 Worker）每次崩溃信号都执行（'error'/'exit'/心跳超时可重复触发，幂等）。
    const wasHealthy = rt.healthy;
    rt.healthy = false; // flags() 立即撤下 plugin:<id> → resolveAvailable 不再含其工具
    for (const [, pend] of rt.pending) this.settlePending(pend, new Error(`插件已崩溃：${reason}`));
    rt.pending.clear();
    if (wasHealthy) this.log(`[plugin] ${rt.spec.id} 降级：${reason}`);
    void rt.transport.terminate().catch(() => {}); // 始终终止（即便不再重连也不泄漏 Worker）
    if (this.closing) return;
    // 重连排程去重：用显式 reconnecting 标志（审查 4E-MED：旧 attempt>0 启发式在首次重连后会截断重连链 + 漏 terminate）。
    if (rt.reconnecting) return;
    if (rt.attempt >= this.o.maxReconnect) {
      this.log(`[plugin] ${rt.spec.id} 超重连上限（${this.o.maxReconnect}），放弃`);
      return;
    }
    rt.reconnecting = true;
    const nextAttempt = rt.attempt + 1;
    const backoff = Math.min(30_000, 500 * 2 ** (nextAttempt - 1));
    const t = setTimeout(() => {
      this.reconnectTimers.delete(t);
      if (this.closing || !this.plugins.has(rt.spec.id)) return;
      this.log(`[plugin] ${rt.spec.id} 重连（第 ${nextAttempt} 次）`);
      void this.launch(rt.spec, nextAttempt).catch((e) =>
        this.log(`[plugin] ${rt.spec.id} 重连失败：${e instanceof Error ? e.message : String(e)}`),
      );
    }, backoff);
    t.unref?.();
    this.reconnectTimers.add(t);
  }

  private settlePending(pend: Pending, err: Error): void {
    if (pend.kind === 'tool') pend.finish(err);
    else {
      clearTimeout(pend.timer);
      pend.resolve(undefined);
    }
  }

  private log(msg: string): void {
    this.o.log?.(msg);
  }
}

/** 协议版本对齐校验（host 可在 onReady 前调；当前 worker-entry.mjs 恒发 v1）。 */
export function isProtocolCompatible(version: number): boolean {
  return version === PLUGIN_PROTOCOL_VERSION;
}

export type { PreToolUseResult };
