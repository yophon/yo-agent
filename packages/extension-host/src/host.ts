/**
 * ExtensionHost（5.2b）——进程内可信扩展档宿主：聚合注册物 + 崩溃围栏 + 内核桥接。
 *
 * 与 plugin-host 分层并列：plugin-host = 跨进程不可信（Worker/IPC/仅 .mjs/贫 API），
 * extension-host = 进程内可信（主进程直载用户 TS/富 API/零 IPC 开销）。共享同一 ToolRegistry/HookBus。
 *
 * 围栏语义：
 *   - 单扩展 import/setup 抛错 → log + 跳过，不拖垮启动。setup 期注册物走 **staging 两段提交**
 *     （审查 5.2c HIGH-1）：hooks/system 段/命令/onEvent 暂存，setup 成功才生效、抛错即回滚——
 *     半初始化的 PreToolUse hook 若残留会 fail-closed deny 全部工具（坏扩展打死 agent）。
 *     工具注册不回滚：健康 flag（ext:<name>）仅授予成功加载者 → 失败扩展的工具自动从
 *     resolveAvailable 消失（复用 3C 熔断显隐，与 plugin-host 同构）。
 *   - hook 直通内核 HookBus（PreToolUse fail-closed / 观测型 fail-open，不另立语义）。
 *   - onEvent 回调抛错 → log，不影响其余监听者与事件流。
 */
import { pathToFileURL } from 'node:url';
import type { EventEnvelope, Id } from '@yo-agent/protocol';
import type { Hooks, SessionSelfInfo } from '@yo-agent/kernel';
import type { ExecBackend, RegisteredTool, ToolRegistry } from '@yo-agent/tools';
import type { ExecResult, ExtensionApi, ExtensionCommand } from './sdk';
import { extensionHealthFlag, isExtensionModule } from './sdk';
import type { ExtensionSpec } from './loader';

/** host 依赖的内核最小面（结构类型，AgentKernel 天然满足；测试可注 fake）。 */
export interface ExtensionKernel {
  registerHook(h: Hooks): () => void;
  subscribe(sessionId: Id, fromCursor: number | null, handler: (env: EventEnvelope) => void): () => void;
  steer(sessionId: Id, text: string): Promise<void>;
  submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<unknown>;
}

export interface ExtensionHostOpts {
  registry: ToolRegistry;
  /** 共享 exec 后端（5.2a 单例提升；与 bash 工具同一沙箱档/secret 剥离策略）。缺省 → api.exec 报错。 */
  execBackend?: ExecBackend;
  /** api.exec 的缺省 cwd（装配层传 workspace cwd）。 */
  defaultCwd: string;
  log?: (msg: string) => void;
}

export interface LoadExtensionsOpts {
  /** project 来源扩展的信任谓词（global 来源不问，默认信任）。缺省 → project 全部按未信任处理。 */
  isProjectExtensionTrusted?: (name: string) => boolean;
  /**
   * 未信任 project 扩展的交互确认（TTY 场景注入；确认方负责落盘 saveTrustedExtension）。
   * 缺省（headless）→ 直接跳过 + 告警。回调抛错按「拒绝」处理（fail-closed）。
   */
  confirmTrust?: (spec: ExtensionSpec) => Promise<boolean>;
  /** 信任门跳过回调（调用方收集名单可注入 system 自知，对齐 mcp onSkippedUntrusted）。 */
  onSkippedUntrusted?: (name: string) => void;
}

/** setup 期注册物暂存（审查 HIGH-1）：commit 前不生效，setup 抛错整体回滚。 */
interface Staging {
  committed: boolean;
  /** hooks 的反注册（已进 HookBus/pending，回滚时摘除）。 */
  disposers: Array<() => void>;
  sections: Array<{ ext: string; section: string | ((info: SessionSelfInfo) => string) }>;
  cmds: ExtensionCommand[];
  listeners: Array<{ ext: string; cb: (env: EventEnvelope) => void }>;
}

export class ExtensionHost {
  private readonly loaded: string[] = [];
  private readonly sections: Array<{ ext: string; section: string | ((info: SessionSelfInfo) => string) }> = [];
  private readonly cmds: ExtensionCommand[] = [];
  private readonly eventListeners: Array<{ ext: string; cb: (env: EventEnvelope) => void }> = [];
  private readonly pendingHooks: Hooks[] = [];
  private readonly followUpQueues = new Map<Id, string[]>();
  /** 会话订阅句柄（unsubscribe）。resubscribe 换挂新 SessionState（审查 MED-4）。 */
  private readonly sessionSubs = new Map<Id, () => void>();
  private kernel: ExtensionKernel | undefined;
  private followUpSeq = 0;

  constructor(private readonly o: ExtensionHostOpts) {}

  private log(msg: string): void {
    this.o.log?.(msg);
  }

  /**
   * 绑定内核（装配：new AgentKernel 后、load 前调用）：暂存 hooks 入 HookBus + 挂内部桥接 hook。
   * 订阅接入点（审查 MED-4）：SessionStart（新会话）+ UserPromptSubmit（每次提交都 fire，
   * kernel.ts:328）——resume 会话不 fire SessionStart，首条续聊输入即接上；且 resubscribe 换挂
   * 使「endSession 后同 id resumeSession 重建 SessionState」的旧死订阅得到刷新。
   */
  bindKernel(kernel: ExtensionKernel): void {
    this.kernel = kernel;
    for (const h of this.pendingHooks.splice(0)) kernel.registerHook(h);
    kernel.registerHook({
      onSessionStart: (ctx) => this.resubscribe(ctx.sessionId),
      onUserPromptSubmit: (ctx) => this.resubscribe(ctx.sessionId),
    });
  }

  /**
   * 加载扩展：project 来源过信任门 → 主进程动态 import（CLI 全局 tsx loader 使 .ts 直载成立，
   * 见 bin/yoagent.mjs）→ 校验 default export 为 defineExtension 产物 → setup(api)（staging 两段提交）。
   * 单扩展任何一步失败只 log + 跳过（崩溃围栏）。未信任 project 扩展若同名遮蔽了 global 版，
   * 回落加载 global 版（审查 MED-3：恶意仓库放同名空壳不能零确认拆掉用户的 global 守卫扩展）。
   * 返回成功加载的扩展名。
   */
  async load(specs: ExtensionSpec[], opts: LoadExtensionsOpts = {}): Promise<string[]> {
    const trusted = opts.isProjectExtensionTrusted ?? (() => false);
    for (const spec of specs) {
      if (spec.source === 'project' && !trusted(spec.name)) {
        let ok = false;
        if (opts.confirmTrust) {
          try {
            ok = await opts.confirmTrust(spec);
          } catch (e) {
            this.log(`[ext] ${spec.name} 信任确认失败（按拒绝处理）：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (!ok) {
          this.log(`[ext] project 扩展「${spec.name}」未 opt-in 信任，已跳过（主进程跑任意代码，供应链防护；信任后启用）`);
          opts.onSkippedUntrusted?.(spec.name);
          if (spec.shadowedGlobal) {
            this.log(`[ext] 回落加载被其遮蔽的 global 版「${spec.name}」（${spec.shadowedGlobal.modulePath}）`);
            await this.loadOne(spec.shadowedGlobal);
          }
          continue;
        }
      }
      await this.loadOne(spec);
    }
    if (this.loaded.length > 0) this.log(`[ext] 已加载 ${this.loaded.length}/${specs.length} 扩展：${this.loaded.join(', ')}`);
    return [...this.loaded];
  }

  /** import + 校验 + staging setup + 提交；任何一步失败 → 回滚 staging + log（围栏）。 */
  private async loadOne(spec: ExtensionSpec): Promise<void> {
    const staging: Staging = { committed: false, disposers: [], sections: [], cmds: [], listeners: [] };
    try {
      const mod: unknown = await import(pathToFileURL(spec.modulePath).href);
      const m = (mod as { default?: unknown } | null)?.default;
      if (!isExtensionModule(m)) {
        this.log(`[ext] ${spec.name} 已跳过：default export 不是 defineExtension(...) 产物（${spec.modulePath}）`);
        return;
      }
      await m.setup(this.makeApi(spec.name, staging));
      // 提交：暂存注册物生效；此后 api 的注册调用（如事件回调里晚注册）直写。
      staging.committed = true;
      this.sections.push(...staging.sections);
      this.cmds.push(...staging.cmds);
      this.eventListeners.push(...staging.listeners);
      this.loaded.push(spec.name);
    } catch (e) {
      // 围栏 + 回滚（审查 HIGH-1）：半初始化的 hooks 从 HookBus 摘除（残留的坏 PreToolUse 闭包会
      // fail-closed deny 一切）、sections/cmds/listeners 随 staging 丢弃。工具不回滚——健康 flag
      // 不含 ext:<name>（loaded 未收录）→ 自动不可见。
      for (const dispose of staging.disposers) dispose();
      this.log(`[ext] ${spec.name} 加载失败（已跳过）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 健康 flag 集（喂 kernel.toolFlags 合并；加载成功才有 → 崩溃扩展的工具自动不可见）。 */
  flags(): Set<string> {
    return new Set(this.loaded.map(extensionHealthFlag));
  }

  /** 扩展 slash 命令（main.ts 适配成 SlashCommand 喂 TUI extraCommands）。 */
  commands(): ExtensionCommand[] {
    return [...this.cmds];
  }

  /**
   * 渲染全部扩展 system 段（装配层 systemSuffix 闭包调用）。逐段独立求值围栏：
   * 单个函数段抛错只 log + 略过该段，不毁掉其余自知注入（kernel 对整个 suffix 的 try/catch 太粗）。
   */
  renderSystemSections(info: SessionSelfInfo): string[] {
    const out: string[] = [];
    for (const { ext, section } of this.sections) {
      try {
        const text = typeof section === 'function' ? section(info) : section;
        if (text) out.push(text);
      } catch (e) {
        this.log(`[ext:${ext}] system 段求值失败（已略过）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  // ───────────────────────── ExtensionApi 实现（每扩展一实例，闭包携带扩展名 + staging）─────────────────────────

  private makeApi(ext: string, staging: Staging): ExtensionApi {
    const host = this;
    // setup 期写 staging（commit 后直写宿主）——见 loadOne 的两段提交围栏。
    const live = (): boolean => staging.committed;
    return {
      name: ext,
      registerTool(tool: RegisteredTool): void {
        host.registerTool(ext, tool); // 不 staging：健康 flag 显隐已罩住失败扩展的工具
      },
      registerCommand(cmd: ExtensionCommand): void {
        host.registerCommand(ext, cmd, live() ? undefined : staging);
      },
      addSystemSection(section): void {
        (live() ? host.sections : staging.sections).push({ ext, section });
      },
      on(hooks: Hooks): void {
        const dispose = host.registerHooks(hooks);
        if (!live()) staging.disposers.push(dispose);
      },
      onEvent(cb): void {
        (live() ? host.eventListeners : staging.listeners).push({ ext, cb });
      },
      exec(cmd, opts): Promise<ExecResult> {
        return host.exec(cmd, opts);
      },
      steer(sessionId, text): Promise<void> {
        return host.requireKernel().steer(sessionId, text);
      },
      followUp(sessionId, text): void {
        host.followUp(sessionId, text);
      },
      log(msg: string): void {
        host.log(`[ext:${ext}] ${msg}`);
      },
    };
  }

  private registerTool(ext: string, tool: RegisteredTool): void {
    const name = tool.descriptor.name;
    // 照 plugin-host 范式：禁冒用 MCP 保留命名空间（confused deputy / 撞名 DoS 防护）。
    if (name.startsWith('mcp__')) {
      this.log(`[ext:${ext}] 工具「${name}」被拒：禁用 MCP 保留前缀 mcp__`);
      return;
    }
    const clamped: RegisteredTool = {
      descriptor: {
        ...tool.descriptor,
        owner: 'plugin',
        // 钳制：扩展工具绝不可 'never'（不能绕审批）；至多 'always'，其余一律 'risk-based'。
        approval: tool.descriptor.approval === 'always' ? 'always' : 'risk-based',
        // 绑健康 flag：扩展加载失败/未收录 → 工具从 resolveAvailable 消失（复用 3C 熔断显隐接缝）。
        availability: { configFlag: extensionHealthFlag(ext) },
      },
      executor: tool.executor,
    };
    try {
      this.o.registry.register(clamped);
    } catch (e) {
      this.log(`[ext:${ext}] 工具「${name}」注册失败（撞名？）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** hooks 注册（含 bindKernel 前暂存），返回反注册（staging 回滚用）。 */
  private registerHooks(h: Hooks): () => void {
    if (this.kernel) return this.kernel.registerHook(h);
    this.pendingHooks.push(h);
    return () => {
      const i = this.pendingHooks.indexOf(h);
      if (i >= 0) this.pendingHooks.splice(i, 1);
    };
  }

  private registerCommand(ext: string, cmd: ExtensionCommand, staging?: Staging): void {
    const name = cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`;
    // 撞名对「已提交 + 本扩展暂存中」联合检查（先注册者优先）。
    if (this.cmds.some((c) => c.name === name) || staging?.cmds.some((c) => c.name === name)) {
      this.log(`[ext:${ext}] 命令「${name}」与其他扩展撞名，已跳过（先注册者优先）`);
      return;
    }
    (staging ? staging.cmds : this.cmds).push({ ...cmd, name });
  }

  private async exec(
    cmd: string,
    opts?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ExecResult> {
    const backend = this.o.execBackend;
    if (!backend) throw new Error('extension exec 不可用：装配层未注入 ExecBackend');
    // timeoutMs / 外部 signal 组合成一个 AbortSignal（超时或外部中断任一触发即杀）。
    const ac = new AbortController();
    const onOuterAbort = (): void => ac.abort(opts?.signal?.reason);
    if (opts?.signal) {
      if (opts.signal.aborted) ac.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = opts?.timeoutMs ? setTimeout(() => ac.abort(new Error(`exec 超时（${opts.timeoutMs}ms）`)), opts.timeoutMs) : undefined;
    try {
      const chunks: string[] = [];
      let exitCode = 0;
      for await (const ch of backend.exec(cmd, { cwd: opts?.cwd ?? this.o.defaultCwd, signal: ac.signal })) {
        if (ch.chunk) chunks.push(ch.chunk);
        if (ch.exitCode !== undefined) exitCode = ch.exitCode;
      }
      return { output: chunks.join(''), exitCode };
    } finally {
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  // ───────────────────────── 事件桥接 + followUp 队列 ─────────────────────────

  private requireKernel(): ExtensionKernel {
    if (!this.kernel) throw new Error('extension-host 尚未 bindKernel（装配缺失）');
    return this.kernel;
  }

  /**
   * 换挂订阅（SessionStart/UserPromptSubmit hook 触发）：先摘旧再订新——同 id 会话被 endSession
   * 后 resumeSession 会重建 SessionState（旧 handler 挂在已弃 subscribers 集上永久死亡，审查 MED-4），
   * 每次 prompt 提交时换挂保证 handler 落在当前活 SessionState。unsub+sub 皆 O(1) set 操作。
   */
  private resubscribe(sessionId: Id): void {
    if (!this.kernel) return;
    this.sessionSubs.get(sessionId)?.();
    this.sessionSubs.set(
      sessionId,
      this.kernel.subscribe(sessionId, null, (env) => this.onEnvelope(env)),
    );
  }

  /** 幂等订阅（followUp 兜底：resume 会话在首条续聊输入前 followUp 也能接上）。 */
  private ensureSubscribed(sessionId: Id): void {
    if (!this.kernel || this.sessionSubs.has(sessionId)) return;
    this.resubscribe(sessionId);
  }

  private onEnvelope(env: EventEnvelope): void {
    for (const { ext, cb } of this.eventListeners) {
      try {
        cb(env);
      } catch (e) {
        this.log(`[ext:${ext}] onEvent 回调抛错（已忽略）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // followUp 出队判据与 TUI 本地队列一致（app.ts：lastStop==='end_turn' 才出队），两队列相互独立。
    if (env.event.kind === 'TurnCompleted' && env.event.stopReason === 'end_turn') {
      this.dequeueFollowUp(env.sessionId);
    }
  }

  private followUp(sessionId: Id, text: string): void {
    this.requireKernel(); // 早失败：未装配时直接抛（被 setup 围栏/调用方接住）
    const q = this.followUpQueues.get(sessionId) ?? [];
    q.push(text);
    this.followUpQueues.set(sessionId, q);
    this.ensureSubscribed(sessionId); // resume 的会话没有 SessionStart hook，这里兜底接上
  }

  private dequeueFollowUp(sessionId: Id): void {
    const q = this.followUpQueues.get(sessionId);
    const next = q?.shift();
    if (next === undefined) return;
    void this.requireKernel()
      .submitInput(sessionId, next, `ext-followup-${++this.followUpSeq}`)
      .catch((e) => {
        // reject 只发生在「turn 未运行」路径（内核排队被 interrupt/endSession 取消、启动期落库失败、会话不存在）——
        // runTurn 异常被内核 TurnFailed 兜底吞掉不走此处。回队无双跑风险，下一次 end_turn 再试。
        const cur = this.followUpQueues.get(sessionId) ?? [];
        cur.unshift(next);
        this.followUpQueues.set(sessionId, cur);
        this.log(`[ext] followUp 提交失败（已回队）：${e instanceof Error ? e.message : String(e)}`);
      });
  }
}
