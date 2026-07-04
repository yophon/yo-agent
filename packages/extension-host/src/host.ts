/**
 * ExtensionHost（5.2b）——进程内可信扩展档宿主：聚合注册物 + 崩溃围栏 + 内核桥接。
 *
 * 与 plugin-host 分层并列：plugin-host = 跨进程不可信（Worker/IPC/仅 .mjs/贫 API），
 * extension-host = 进程内可信（主进程直载用户 TS/富 API/零 IPC 开销）。共享同一 ToolRegistry/HookBus。
 *
 * 围栏语义：
 *   - 单扩展 import/setup 抛错 → log + 跳过，不拖垮启动；其已注册工具因健康 flag（ext:<name>）
 *     缺失自动从 resolveAvailable 消失（复用 3C 熔断显隐，与 plugin-host 同构）。
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

export class ExtensionHost {
  private readonly loaded: string[] = [];
  private readonly sections: Array<{ ext: string; section: string | ((info: SessionSelfInfo) => string) }> = [];
  private readonly cmds: ExtensionCommand[] = [];
  private readonly eventListeners: Array<{ ext: string; cb: (env: EventEnvelope) => void }> = [];
  private readonly pendingHooks: Hooks[] = [];
  private readonly followUpQueues = new Map<Id, string[]>();
  private readonly subscribed = new Set<Id>();
  private kernel: ExtensionKernel | undefined;
  private followUpSeq = 0;

  constructor(private readonly o: ExtensionHostOpts) {}

  private log(msg: string): void {
    this.o.log?.(msg);
  }

  /**
   * 绑定内核（装配：new AgentKernel 后、load 前调用）：暂存 hooks 入 HookBus + 挂内部
   * SessionStart hook（新会话自动接 onEvent/followUp 桥接订阅）。
   */
  bindKernel(kernel: ExtensionKernel): void {
    this.kernel = kernel;
    for (const h of this.pendingHooks.splice(0)) kernel.registerHook(h);
    kernel.registerHook({ onSessionStart: (ctx) => this.ensureSubscribed(ctx.sessionId) });
  }

  /**
   * 加载扩展：project 来源过信任门 → 主进程动态 import（CLI 全局 tsx loader 使 .ts 直载成立，
   * 见 bin/yoagent.mjs）→ 校验 default export 为 defineExtension 产物 → setup(api)。
   * 单扩展任何一步失败只 log + 跳过（崩溃围栏）。返回成功加载的扩展名。
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
          continue;
        }
      }
      try {
        const mod: unknown = await import(pathToFileURL(spec.modulePath).href);
        const m = (mod as { default?: unknown } | null)?.default;
        if (!isExtensionModule(m)) {
          this.log(`[ext] ${spec.name} 已跳过：default export 不是 defineExtension(...) 产物（${spec.modulePath}）`);
          continue;
        }
        await m.setup(this.makeApi(spec.name));
        this.loaded.push(spec.name);
      } catch (e) {
        // 围栏：import 语法错/依赖缺/setup 抛错——只跳过本扩展。其间已注册的工具因健康 flag
        // 不含 ext:<name>（loaded 未收录）而自动不可见，不需回滚反注册。
        this.log(`[ext] ${spec.name} 加载失败（已跳过）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.loaded.length > 0) this.log(`[ext] 已加载 ${this.loaded.length}/${specs.length} 扩展：${this.loaded.join(', ')}`);
    return [...this.loaded];
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

  // ───────────────────────── ExtensionApi 实现（每扩展一实例，闭包携带扩展名）─────────────────────────

  private makeApi(ext: string): ExtensionApi {
    const host = this;
    return {
      name: ext,
      registerTool(tool: RegisteredTool): void {
        host.registerTool(ext, tool);
      },
      registerCommand(cmd: ExtensionCommand): void {
        host.registerCommand(ext, cmd);
      },
      addSystemSection(section): void {
        host.sections.push({ ext, section });
      },
      on(hooks: Hooks): void {
        if (host.kernel) host.kernel.registerHook(hooks);
        else host.pendingHooks.push(hooks);
      },
      onEvent(cb): void {
        host.eventListeners.push({ ext, cb });
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

  private registerCommand(ext: string, cmd: ExtensionCommand): void {
    const name = cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`;
    if (this.cmds.some((c) => c.name === name)) {
      this.log(`[ext:${ext}] 命令「${name}」与其他扩展撞名，已跳过（先注册者优先）`);
      return;
    }
    this.cmds.push({ ...cmd, name });
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

  /** 幂等订阅一个会话（SessionStart hook 自动触发；followUp 对 resume 会话手动兜底）。 */
  private ensureSubscribed(sessionId: Id): void {
    if (!this.kernel || this.subscribed.has(sessionId)) return;
    // 无监听需求（无 onEvent 且无 followUp 队列）时也订阅——订阅是幂等轻量的（内存 set 分发），
    // 换取「扩展在任意回调里晚注册 onEvent 也能收到后续事件」的确定性。
    this.subscribed.add(sessionId);
    this.kernel.subscribe(sessionId, null, (env) => this.onEnvelope(env));
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
      .catch((e) => this.log(`[ext] followUp 提交失败：${e instanceof Error ? e.message : String(e)}`));
  }
}
