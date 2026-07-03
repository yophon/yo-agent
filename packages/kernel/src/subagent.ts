import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { Id, PermissionMode, RiskLevel } from '@yo-agent/protocol';
import type { Provider } from '@yo-agent/provider';
import type { ToolRegistry } from '@yo-agent/tools';
import { AllowlistToolRegistry, SUBAGENT_SPAWN_TOOL } from '@yo-agent/tools';
import type { EventStore } from '@yo-agent/store';
import { AgentKernel } from './kernel';
import type { ApprovalOutcome, Condenser, LoopBreaker, SubagentManager, SubagentSpawnOpts } from './index';
import type { Recipe } from './recipes';

/**
 * 子代理审批上浮接缝（4.9c）：子内核/worker 的审批请求转调父内核（kernel.relayApproval），
 * 在父会话弹审批面板；无人可批时由父内核带 noninteractive 归因默认拒。
 */
export type SubagentApprovalRelay = (
  parentSessionId: Id,
  req: { tool: string; input: unknown; risk: RiskLevel },
) => Promise<ApprovalOutcome>;

/**
 * 子 agent（DESIGN §2.5 / ADR-17）：派生独立上下文的探索型 agent，**只回 SubagentResult{summary}** 防主上下文污染，
 * 且**崩溃不拖垮主循环**（退出标准②）。三层职责分离：
 *   - {@link SubagentRunner}：执行/隔离档（worker_threads / in-process），可换（仿 ExecBackend / ADR-19）。
 *   - {@link DefaultSubagentManager}：编排——派生策略收紧、递归防护、崩溃围栏、前/后台 + steering。
 *   - {@link SubagentHost}：内核侧 emit 接缝（内核仍是唯一 AgentEvent 写入者，§0.3）。
 */

/** 子 agent 运行规格（已派生收紧后的不可变快照，可序列化以喂 worker）。 */
export interface SubagentRunSpec {
  childSessionId: Id;
  parentSessionId: Id;
  profile: string;
  task: string;
  model: string;
  maxTurns: number;
  /** deriveSubagentPolicy 收紧后的工具白名单（⊆ parent，已剥离 subagent_spawn）。 */
  toolAllowlist: string[];
  /** deriveSubagentPolicy 收紧后的权限模式（不宽于 parent）。 */
  permissionMode: PermissionMode;
  cwd: string;
  /** 递归深度（顶层 spawn=1）；递归防护硬上限判据。 */
  depth: number;
  outputMaxTokens?: number;
  /** 子 agent system prompt（4D：由 recipe.prompt 解析；可序列化喂 worker）。 */
  systemPrompt?: string;
}

export interface SubagentRunResult {
  summary: string;
  isError?: boolean;
}

/** 子 agent 执行后端（隔离档可换；run 抛错由管理器围栏兜底，见 runWithContainment）。 */
export interface SubagentRunner {
  run(spec: SubagentRunSpec, signal?: AbortSignal): Promise<SubagentRunResult>;
}

/**
 * 内核侧子 agent emit 接缝：管理器经此让**父会话**落 SubagentStarted/SubagentResult（内核仍是唯一写入者）。
 * 实现见 AgentKernel.noteSubagentStarted/noteSubagentResult。
 */
export interface SubagentHost {
  noteSubagentStarted(parentSessionId: Id, info: { childSessionId: Id; label: string; model: string }): Promise<void>;
  noteSubagentResult(
    parentSessionId: Id,
    info: { childSessionId: Id; summary: string },
    opts?: { injectSteering?: boolean },
  ): Promise<void>;
}

// ───────────────────────── deriveSubagentPolicy（只收紧）─────────────────────────

/** 权限模式宽松度（rank 越大越宽）；deriveSubagentPolicy 取「更严者」（rank 更小）防放宽。 */
const MODE_RANK: Record<PermissionMode, number> = {
  'read-only': 0,
  ci: 1,
  supervised: 2,
  'accept-edits': 3,
  autonomous: 4,
  bypass: 5,
};

/** 恒从子 agent 工具集剥离的工具（防无限递归 spawn 烧 token）。 */
const RECURSION_DENY: ReadonlySet<string> = new Set([SUBAGENT_SPAWN_TOOL]);

export interface DerivePolicyInput {
  parentMode: PermissionMode;
  /** 父会话当前可见工具名（子 agent 工具集 ⊆ 此集）。 */
  parentTools: string[];
  /** profile/recipe 请求的子 agent 模式；默认沿用 parent（再取更严者，绝不放宽）。 */
  requestedMode?: PermissionMode;
  /** profile/recipe 请求的工具白名单；默认 = parentTools（再与 parent 取交集）。 */
  requestedTools?: string[];
}

export interface DerivedPolicy {
  permissionMode: PermissionMode;
  toolAllowlist: string[];
}

/**
 * 派生子 agent 策略（DESIGN §2.5，opencode「只收紧」范式）：
 *   - 权限模式取 `requested` 与 `parent` 中**更严者**（绝不放宽 parent）。
 *   - 工具集 = `requested ∩ parent`，并**恒剥离 subagent_spawn**（防递归）。
 * 纯函数、可单测。
 */
export function deriveSubagentPolicy(input: DerivePolicyInput): DerivedPolicy {
  const requestedMode = input.requestedMode ?? input.parentMode;
  const permissionMode = MODE_RANK[requestedMode] <= MODE_RANK[input.parentMode] ? requestedMode : input.parentMode;
  const parentSet = new Set(input.parentTools);
  const base = input.requestedTools ?? input.parentTools;
  const seen = new Set<string>();
  const toolAllowlist: string[] = [];
  for (const t of base) {
    if (seen.has(t)) continue; // 去重，稳定序
    seen.add(t);
    if (parentSet.has(t) && !RECURSION_DENY.has(t)) toolAllowlist.push(t);
  }
  return { permissionMode, toolAllowlist };
}

// ───────────────────────── DefaultSubagentManager ─────────────────────────

export interface SubagentManagerOpts {
  host: SubagentHost;
  runner: SubagentRunner;
  /** 父会话当前可见工具名（deriveSubagentPolicy 收紧基准）；缺省空集（不放任何工具给子 agent）。 */
  parentToolsOf?: (parentSessionId: Id) => string[];
  /** 父会话权限模式（收紧基准）；缺省 supervised。 */
  parentModeOf?: (parentSessionId: Id) => PermissionMode;
  /** 父会话 cwd（子 agent 工作区起点）；缺省 process.cwd()。 */
  cwdOf?: (parentSessionId: Id) => string;
  /** 递归 spawn 硬上限（depth 超此即拒，不起子 agent）；默认 1（即顶层可派生、子 agent 不可再派生）。 */
  maxDepth?: number;
  /** 子 agent 缺省模型（opts.model 未指定时）。 */
  defaultModel?: string;
  /** 子 agent 缺省 maxTurns。 */
  defaultMaxTurns?: number;
  /** profile → recipe（4D）：提供工具白名单/权限模式/model/prompt 请求，仍经 deriveSubagentPolicy 收紧。 */
  recipeFor?: (profile: string) => Recipe | undefined;
  /** 可用画像名枚举（4.9b）：未知 profile 的可行动错误据此列清单（仅 recipeFor 已接线时校验）。 */
  profileNames?: () => string[];
  /**
   * 已知模型 id 枚举（4.9b，ModelCatalog 同 provider 清单）：非空且不含解析后的模型 → **早失败**回
   * 可行动错误，不透传给上游烧一次 404。空/缺省 → 不校验（目录未收录当前 provider 时不误伤）。
   */
  knownModels?: () => string[];
}

/**
 * 默认子 agent 管理器（ADR-17）：
 *   - **崩溃围栏**（退出标准②）：runner.run 任何抛错/拒绝 → 收敛为 SubagentResult{error 摘要}，**绝不向上抛**；
 *     主 turn 收摘要继续、主循环存活。
 *   - **递归防护**：深度超 maxDepth 直接拒（叠加 deriveSubagentPolicy 恒剥离 subagent_spawn 的双保险）。
 *   - **前/后台**：foreground 阻塞取回摘要（tool_result 回灌）；background 发出即返回，结果经 host steering 在
 *     parent 下一 step 注入（不阻塞主 turn，§2.5）。
 */
export class DefaultSubagentManager implements SubagentManager {
  private readonly o: SubagentManagerOpts;
  private readonly maxDepth: number;
  /** sessionId → 深度（仅管理器派生的会话有记录；顶层父会话不在表内 → 深度按 0 计）。 */
  private readonly depthOf = new Map<Id, number>();
  /** childSessionId → { 取消控制器, 父会话 }（供 abort 按父会话作用域回收，审查 likely#4/gap#2）。 */
  private readonly inflight = new Map<Id, { ac: AbortController; parentSessionId: Id }>();

  constructor(opts: SubagentManagerOpts) {
    this.o = opts;
    this.maxDepth = opts.maxDepth ?? 1;
  }

  /** 冻结接口：foreground 阻塞至完成后返回；background 发出即返回。 */
  async spawn(opts: SubagentSpawnOpts): Promise<{ childSessionId: Id }> {
    const launched = this.launch(opts);
    if (opts.mode === 'foreground') await launched.done;
    return { childSessionId: launched.childSessionId };
  }

  /** 工具用（foreground 取摘要）：阻塞至完成，返回 childSessionId + 摘要 + 是否错误。 */
  async run(opts: SubagentSpawnOpts): Promise<{ childSessionId: Id; summary: string; isError: boolean }> {
    const launched = this.launch(opts);
    const r = await launched.done;
    return { childSessionId: launched.childSessionId, summary: r.summary, isError: r.isError ?? false };
  }

  /**
   * 取消在飞背景子 agent（会话结束/中断时回收，审查 gap#2 接 kernel.sessionReaper）。
   * 传 parentSessionId → 仅取消该父会话派生的（不误杀其他会话的背景子 agent）；省略 → 取消全部。
   */
  abortInflight(parentSessionId?: Id): void {
    for (const [childId, rec] of this.inflight) {
      if (parentSessionId !== undefined && rec.parentSessionId !== parentSessionId) continue;
      rec.ac.abort(new Error('子 agent 已取消'));
      this.inflight.delete(childId); // 取消即移除（done 的 finally 再删一次为幂等 no-op）
    }
  }

  private launch(opts: SubagentSpawnOpts): { childSessionId: Id; done: Promise<SubagentRunResult> } {
    const childSessionId = randomUUID();
    const depth = (this.depthOf.get(opts.parentSessionId) ?? 0) + 1;

    // 递归防护硬上限：超深度直接拒，不起子 agent、不 emit Started（与 deriveSubagentPolicy 剥离 spawn 双保险）。
    if (depth > this.maxDepth) {
      const summary = `[子 agent 拒绝] 递归深度超限（depth=${depth} > 上限 ${this.maxDepth}）`;
      return { childSessionId, done: Promise.resolve({ summary, isError: true }) };
    }

    // recipe（4D）：请求工具白名单/权限模式/model/prompt —— 仍经 deriveSubagentPolicy 与 parent 取交集/更严者（只收紧）。
    const recipe = this.o.recipeFor?.(opts.profile);
    // 4.9b 未知画像早失败（对齐 skill_activate 可行动错误范式）：仅画像系统已接线（recipeFor 存在）时校验；
    // 空串/default 恒放行（沿用父会话派生）。不再静默降级成无画像子 agent（feedback/4.8 病根 2）。
    if (this.o.recipeFor && recipe === undefined && opts.profile && opts.profile !== 'default') {
      const known = ['default', ...(this.o.profileNames?.() ?? [])];
      const summary = `[子 agent 拒绝] 未知画像「${opts.profile}」（可用：${known.join(', ')}；留空沿用 default）`;
      return { childSessionId, done: Promise.resolve({ summary, isError: true }) };
    }
    // 4.9b 空串归一化：空/空白 model 不再穿透 ?? 兜底直达 provider 400。
    const model = (opts.model?.trim() || undefined) ?? (recipe?.model?.trim() || undefined) ?? this.o.defaultModel ?? 'fake-model';
    // 4.9b 未知模型早失败：目录清单非空且不含解析后的模型（含 recipe 里的手误）→ 可行动错误，不烧上游 404。
    const knownModels = this.o.knownModels?.() ?? [];
    if (knownModels.length > 0 && !knownModels.includes(model)) {
      const summary = `[子 agent 拒绝] 未知模型「${model}」（可用：${knownModels.join(', ')}；留空沿用主 agent 模型）`;
      return { childSessionId, done: Promise.resolve({ summary, isError: true }) };
    }

    this.depthOf.set(childSessionId, depth);
    const parentMode = this.o.parentModeOf?.(opts.parentSessionId) ?? 'supervised';
    const parentTools = this.o.parentToolsOf?.(opts.parentSessionId) ?? [];
    const derived = deriveSubagentPolicy({
      parentMode,
      parentTools,
      ...(recipe?.permissionMode ? { requestedMode: recipe.permissionMode } : {}),
      ...(recipe?.tools ? { requestedTools: recipe.tools } : {}),
    });
    const spec: SubagentRunSpec = {
      childSessionId,
      parentSessionId: opts.parentSessionId,
      profile: opts.profile,
      task: opts.task,
      model,
      maxTurns: opts.maxTurns ?? this.o.defaultMaxTurns ?? 8,
      toolAllowlist: derived.toolAllowlist,
      permissionMode: derived.permissionMode,
      cwd: this.o.cwdOf?.(opts.parentSessionId) ?? process.cwd(),
      depth,
      ...(opts.outputMaxTokens != null ? { outputMaxTokens: opts.outputMaxTokens } : {}),
      ...(recipe?.prompt ? { systemPrompt: recipe.prompt } : {}),
    };
    const label = opts.profile || 'subagent';
    const background = opts.mode === 'background';
    const ac = new AbortController();
    if (background) this.inflight.set(childSessionId, { ac, parentSessionId: opts.parentSessionId });

    const done = (async (): Promise<SubagentRunResult> => {
      try {
        await this.o.host.noteSubagentStarted(opts.parentSessionId, { childSessionId, label, model });
        const result = await this.runWithContainment(spec, ac.signal);
        await this.o.host.noteSubagentResult(
          opts.parentSessionId,
          { childSessionId, summary: result.summary },
          { injectSteering: background },
        );
        return result;
      } finally {
        if (background) this.inflight.delete(childSessionId);
        this.depthOf.delete(childSessionId);
      }
    })();

    // 背景任务：丢弃 done 句柄，需自吞 rejection（host emit 万一抛）防 unhandledRejection 击垮常驻进程。
    if (background) void done.catch(() => {});
    return { childSessionId, done };
  }

  /**
   * 崩溃围栏（退出标准②核心）：runner.run 任何抛错/拒绝 → 收敛为 error 摘要，**绝不向上抛**。
   * 摘要按 outputMaxTokens 截断（防超长子结果污染主上下文）。
   */
  private async runWithContainment(spec: SubagentRunSpec, signal: AbortSignal): Promise<SubagentRunResult> {
    try {
      const r = await this.o.runner.run(spec, signal);
      return { summary: truncateSummary(r.summary, spec.outputMaxTokens), isError: r.isError ?? false };
    } catch (e) {
      return { summary: `[子 agent 失败] ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  }
}

/** 摘要截断（按 outputMaxTokens≈4 字节/token 粗估；未给则不截）。 */
function truncateSummary(summary: string, outputMaxTokens?: number): string {
  if (!outputMaxTokens || outputMaxTokens <= 0) return summary;
  const cap = outputMaxTokens * 4;
  if (summary.length <= cap) return summary;
  return `${summary.slice(0, cap)}\n[…摘要超 ${outputMaxTokens} token 已截断]`;
}

// ───────────────────────── In-process 执行档（默认）─────────────────────────

export interface ChildAgentDeps {
  store: EventStore;
  provider: Provider;
  /** 父注册表（in-process 档据 spec.toolAllowlist 经 AllowlistToolRegistry 收紧后喂子内核）。 */
  registry: ToolRegistry;
  /** 每个子 agent 用全新实例（熔断/压缩状态不串）。 */
  loopBreaker: () => LoopBreaker;
  condenser: () => Condenser;
  usableContextTokens?: number;
  /** profile → 子 agent system prompt（4D recipe 接入点）。 */
  systemFor?: (profile: string) => string | undefined;
  /**
   * 审批上浮（4.9c）：提供则子内核挂代理 ApprovalGate，ask 档审批转到父会话弹面板（不再写死默认拒）。
   * 缺省 → 旧行为：子 agent 非交互默认拒（带 noninteractive 归因文案）。
   */
  parentApproval?: SubagentApprovalRelay;
}

/**
 * In-process 子 agent 执行档（默认）：在**同线程**跑一个独立 childSessionId 的子内核——
 * 独立上下文 + 收紧工具集 + 派生权限模式 + 独立 EventLog 子树（主 session 不被子任务工具历史污染，§5.4）。
 * 上下文隔离在此达成；崩溃围栏由管理器 runWithContainment 兜底（同线程异常被 catch）。
 * OS 线程级隔离见 {@link WorkerSubagentRunner}（worker_threads，ADR-17 默认隔离档）。
 */
export function createInProcessRunner(deps: ChildAgentDeps): SubagentRunner {
  return { run: (spec, signal) => runChildAgent(deps, spec, signal) };
}

export async function runChildAgent(
  deps: ChildAgentDeps,
  spec: SubagentRunSpec,
  signal?: AbortSignal,
): Promise<SubagentRunResult> {
  const childTools = new AllowlistToolRegistry(deps.registry, spec.toolAllowlist);
  // 4.9c 审批上浮：子内核 ask 档审批经代理 gate 转调父内核（父会话弹面板，批完 resolve 回来）——
  // 不再写死默认拒（feedback/4.8 反馈②：子代理无权限静默失败）。无 relay → 父内核侧 noninteractive 归因默认拒。
  const gate = deps.parentApproval
    ? {
        request: (req: { sessionId: Id; tool: string; input: unknown; risk: RiskLevel }) =>
          deps.parentApproval!(spec.parentSessionId, { tool: req.tool, input: req.input, risk: req.risk }),
      }
    : undefined;
  const kernel = new AgentKernel({
    store: deps.store,
    provider: deps.provider,
    tools: childTools,
    loopBreaker: deps.loopBreaker(),
    condenser: deps.condenser(),
    model: spec.model,
    cwd: spec.cwd,
    maxStepsPerTurn: spec.maxTurns,
    ...(deps.usableContextTokens != null ? { usableContextTokens: deps.usableContextTokens } : {}),
    // 子内核自身不挂起等审批（interactiveApproval:false）：ask 档经上面的代理 gate 上浮父会话；
    // 无 gate 时默认拒（带归因），派生权限不被「无人值守」放大成静默放行。
    interactiveApproval: false,
    ...(gate ? { approvalGate: gate } : {}),
  });
  const system = spec.systemPrompt ?? deps.systemFor?.(spec.profile);
  await kernel.startSession({
    sessionId: spec.childSessionId,
    model: spec.model,
    cwd: spec.cwd,
    permissionMode: spec.permissionMode,
    ...(system ? { system } : {}),
  });

  // 收集子 agent 末态文本 + 失败态（只取摘要回主 session，子工具细节留子树）。
  let text = '';
  let failed: string | undefined;
  const unsub = kernel.subscribe(spec.childSessionId, null, (env) => {
    const e = env.event;
    if (e.kind === 'AssistantText') text += e.delta;
    else if (e.kind === 'TurnFailed') failed = e.error.message;
  });
  try {
    await kernel.submitInput(spec.childSessionId, spec.task, `sub-${spec.childSessionId}`);
  } finally {
    unsub();
    kernel.endSession(spec.childSessionId); // 一次性子会话：用毕驱逐，防常驻进程内存泄漏
  }

  if (signal?.aborted) return { summary: '[子 agent 已取消]', isError: true };
  if (failed) return { summary: `[子 agent 失败] ${failed}`, isError: true };
  return { summary: text.trim() || '(子 agent 无文本输出)', isError: false };
}

// ───────────────────────── worker_threads 隔离档（ADR-17 默认隔离）─────────────────────────

/** 子 agent worker 默认环境白名单（剥离 yo-agent 自身 secret，与 exec L1 同理）。 */
const WORKER_ENV_WHITELIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ', 'PWD'];

export interface WorkerRunnerOpts {
  /** worker 入口脚本（生产指向自洽重建子内核的入口；测试可传 .mjs fixture）。 */
  entry: string | URL;
  /** 传给 worker 的环境；缺省按白名单从 process.env 过滤（剥离 secret）。传 null 则给空环境。 */
  env?: NodeJS.ProcessEnv | null;
  /**
   * 跨线程审批 relay（4.9c）：worker 内子内核无法直连父 pendingApprovals，经消息协议
   * （{@link SubagentWorkerApprovalRequest} / {@link SubagentWorkerApprovalDecision}）往返——
   * worker 发 approval_request，本 runner 调此 relay（生产接 kernel.relayApproval，超时语义与主循环一致），
   * 把结果 postMessage 回 worker。缺省 → 一律回 noninteractive 拒。
   */
  approval?: (req: { tool: string; input: unknown; risk: RiskLevel }) => Promise<ApprovalOutcome>;
}

/** worker → 主线程的审批请求帧（4.9c 跨线程审批 RPC）。 */
export interface SubagentWorkerApprovalRequest {
  type: 'approval_request';
  /** worker 侧生成的关联 id（decision 帧原样带回）。 */
  id: string;
  tool: string;
  input: unknown;
  risk: RiskLevel;
}

/** 主线程 → worker 的审批结果帧。 */
export interface SubagentWorkerApprovalDecision extends ApprovalOutcome {
  type: 'approval_decision';
  id: string;
}

function isApprovalRequest(msg: unknown): msg is SubagentWorkerApprovalRequest {
  const m = msg as { type?: unknown; id?: unknown; tool?: unknown } | null;
  return !!m && m.type === 'approval_request' && typeof m.id === 'string' && typeof m.tool === 'string';
}

/**
 * worker_threads 隔离档（ADR-17 默认隔离）：子 agent 跑在独立 Worker 线程——
 * **崩溃围栏的硬隔离形态**：worker 内未捕获异常（'error'）/ 主动退出（'exit' code≠0）/ 取消（terminate）
 * 全部经本 runner 转成 rejected promise，再由管理器 runWithContainment 收敛为 error 摘要（退出标准②）。
 * worker env 默认按白名单剥离 secret（子 agent 代码读不到主进程 API key/设备私钥/OAuth token）。
 */
export class WorkerSubagentRunner implements SubagentRunner {
  constructor(private readonly opts: WorkerRunnerOpts) {}

  run(spec: SubagentRunSpec, signal?: AbortSignal): Promise<SubagentRunResult> {
    return new Promise<SubagentRunResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('子 agent 已取消'));
        return;
      }
      const env = this.opts.env === undefined ? filterEnv(process.env) : this.opts.env ?? {};
      const worker = new Worker(this.opts.entry, { workerData: spec, env });
      let settled = false;
      let result: SubagentRunResult | undefined;
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        act();
      };
      const onAbort = (): void => {
        void worker.terminate();
        finish(() => reject(new Error('子 agent 已取消')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (msg) => {
        // 4.9c 跨线程审批 RPC：approval_request 帧不当结果——转 relay，把决定 postMessage 回 worker。
        if (isApprovalRequest(msg)) {
          const reply = (outcome: ApprovalOutcome): void => {
            const frame: SubagentWorkerApprovalDecision = { type: 'approval_decision', id: msg.id, ...outcome };
            try {
              worker.postMessage(frame);
            } catch {
              /* worker 已退出 → 决定无处送达，静默（worker 生命周期兜底在 exit 分支） */
            }
          };
          if (!this.opts.approval) {
            reply({ decision: 'reject_once', autoReason: 'noninteractive' });
            return;
          }
          this.opts.approval({ tool: msg.tool, input: msg.input, risk: msg.risk }).then(
            (outcome) => reply(outcome),
            () => reply({ decision: 'reject_once', autoReason: 'noninteractive' }), // relay 抛错 fail-closed
          );
          return;
        }
        result = normalizeMessage(msg);
      });
      worker.on('error', (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
      worker.on('exit', (code) => {
        if (result) finish(() => resolve(result!));
        else finish(() => reject(new Error(`子 agent worker 异常退出（code=${code}）`)));
      });
    });
  }
}

function filterEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of WORKER_ENV_WHITELIST) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function normalizeMessage(msg: unknown): SubagentRunResult {
  if (msg && typeof msg === 'object' && 'summary' in msg) {
    const m = msg as { summary: unknown; isError?: unknown };
    return { summary: String(m.summary), isError: Boolean(m.isError) };
  }
  return { summary: typeof msg === 'string' ? msg : JSON.stringify(msg) };
}
