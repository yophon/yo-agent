/**
 * MCP host 连接层（DESIGN §3.3 / §15.3）—— outbound MCP client：
 *   连接 → tools/list 发现 → 经 3A 护栏映射注册 → tools/call 包成 ToolExecutorRef。
 *
 * 与 `mcp-surface.ts`（yo-agent 作 server）对称：`createStdioClientTransport` 对称于 `createStdioTransport`，
 * SDK 依赖收在本包，app 依赖面不扩大。外部 server 是**不可信输入源**，全部经 3A 护栏：
 *   命名隔离 `mcp__{server}__{tool}`（防撞名错路由）、schema 清洗（防注入/超大）、审批 clamp（绝不 never）。
 *
 * 连接健康用 configFlag 表达（`mcp:{server}`）：host 维护健康标志集（`flags()`），喂给
 * kernel.toolFlags；3C 熔断/空闲断连时撤下标志 → 工具经 `evalAvailability` 从 resolveAvailable 消失（无需 unregister）。
 *
 * 3C 韧性（运行时危险）：
 *   - per-call 超时（默认 60s）：挂死的远端调用不阻塞整 turn，超时 abort + 计入熔断（MCP-local，不波及 bash 等本地工具）。
 *   - 失败熔断：连续传输失败 ≥ 阈值 → 冷却期 `flags()` 撤下该 server → 工具消失；冷却后半开恢复。
 *   - 空闲 TTL：长时间无调用 → 断连回收子进程；断连前查 in-flight 计数，有未完成则推迟（防竞态）。
 *   - tools/list_changed：显式重建工具集（非热换）+ toolsetVersion 自增，turn 内 snapshot（3A）保证不漂移前缀。
 *   - 连接状态可观测：`statusSnapshot()` 供 kernel diff 落 EventLog；`onStatus` 回调供运行日志。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CreateMessageRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { SamplingHandler } from './mcp-sampling';
import type { McpServerStatus, McpServerStatusInfo } from '@yo-agent/protocol';
import type { RegisteredTool, ToolDescriptor, ToolEvent, ToolExecutorRef, ToolRegistry } from '@yo-agent/tools';
import { clampMcpApproval, mcpToolName, sanitizeMcpInputSchema, sanitizeMcpServerName } from '@yo-agent/tools';
import type { ResolvedMcpServer } from './mcp-config';

/** server 连接健康标志（availability configFlag）；3C 熔断/断连时撤下 → 工具从 resolveAvailable 消失。 */
export function mcpHealthFlag(server: string): string {
  return `mcp:${sanitizeMcpServerName(server)}`;
}

/** 顶层 description 截断上限（与 sanitizeMcpInputSchema 的 maxStringLen 对齐，降 tool-poisoning 注入面）。 */
const MCP_DESC_MAX = 8192;

/** 默认 per-call 超时（§15.3，挂死远端调用上限）。 */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
/** 默认连续失败熔断阈值（§15.3 BUNDLE_MCP_FAILURE_THRESHOLD）。 */
export const DEFAULT_MCP_FAILURE_THRESHOLD = 3;
/** 默认熔断冷却时长（§15.3）。 */
export const DEFAULT_MCP_COOLDOWN_MS = 60_000;
/** 默认空闲 TTL：超此时长无调用则断连回收子进程（§15.3）。 */
export const DEFAULT_MCP_IDLE_TTL_MS = 10 * 60_000;

/** stdio client transport 工厂（SDK 依赖收在本包；env 由 SDK 自动并入 getDefaultEnvironment，PATH 不丢）。 */
export function createStdioClientTransport(server: ResolvedMcpServer): Transport {
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: Object.keys(server.env).length ? server.env : undefined,
    stderr: 'inherit', // 子 server stderr 直通本进程 stderr，不混入 stdout 协议帧
  });
}

/**
 * 失败熔断状态机（§15.3）：连续失败累计达阈值 → 打开冷却窗口；窗口内 `isOpen` 为真。
 * 半开：冷却期满后 `isOpen` 转假但失败计数保留——下一次失败立即重新打开（单次试探失败即回退），
 * 下一次成功才 `recordSuccess` 清零彻底闭合。纯时钟驱动、无定时器，便于注入时钟离线确定性单测。
 */
export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
}
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? DEFAULT_MCP_FAILURE_THRESHOLD);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_MCP_COOLDOWN_MS);
  }

  recordSuccess(now: number): void {
    // 冷却窗口内的成功（turn 内 snapshot 工具重试命中）不清任何状态：既 honor 固定冷却窗口（BRK-4），
    // 又保留失败计数以兑现半开语义（冷却满后单次试探失败即重新打开）。仅冷却已过的成功才彻底闭合。
    if (this.isOpen(now)) return;
    this.failures = 0;
    this.openUntil = 0;
  }
  recordFailure(now: number): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openUntil = now + this.cooldownMs;
  }
  isOpen(now: number): boolean {
    return this.openUntil > now;
  }
}

/** mcpExecutor 调用生命周期回调（per-connection：in-flight 计数 / 空闲时钟 / 熔断计数）。 */
export interface McpCallHooks {
  onCallStart?(): void;
  onCallEnd?(): void;
  /** 收到响应（含 tool 级 isError）= 连接健康 → 熔断计数清零。 */
  onTransportOk?(): void;
  /** 传输层错误或自有超时（server 挂死）→ 熔断计数 +1。用户中断不在此列（中性）。 */
  onTransportFail?(): void;
}

/** SDK Tool（`tools/list` 单项）→ ToolDescriptor，经 3A 全部护栏。 */
export function toolDescriptorFromMcp(
  server: string,
  tool: { name: string; description?: string; inputSchema?: unknown },
): ToolDescriptor {
  return {
    name: mcpToolName(server, tool.name), // 命名空间隔离 + 校验
    kind: 'other',
    description: (tool.description ?? '').slice(0, MCP_DESC_MAX),
    inputSchema: sanitizeMcpInputSchema(tool.inputSchema), // 限深度/属性数/字符串长，脏 schema 安全降级
    owner: 'mcp',
    availability: { configFlag: mcpHealthFlag(server) }, // 绑连接健康（3C 熔断/断连接缝）
    approval: clampMcpApproval(undefined), // 外部工具无 approval 声明 → risk-based，绝不 never（必走 ApprovalGate）
  };
}

/**
 * 组合 ctx.signal（turn 取消）与 per-call 超时，返回组合 signal + 超时判定 + 清理。
 * 不依赖 AbortSignal.any（兼容 Node 20.0）；超时由本 executor 自持（MCP-local），故能精确归因「超时 vs 用户中断」。
 */
function makeCallSignal(
  ctxSignal: AbortSignal | undefined,
  ms: number | undefined,
): { signal: AbortSignal | undefined; timedOut: () => boolean; dispose: () => void } {
  if (!ms || ms <= 0) return { signal: ctxSignal, timedOut: () => false, dispose: () => {} };
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new Error(`MCP 调用超时（${ms}ms）`));
  }, ms);
  const onAbort = (): void => ctrl.abort(ctxSignal?.reason);
  if (ctxSignal) {
    if (ctxSignal.aborted) ctrl.abort(ctxSignal.reason);
    else ctxSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      ctxSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/** 包 client.callTool 为 ToolExecutorRef：CallToolResult.content[] 归一为 ToolEvent；per-call 超时 + 熔断归因。 */
export function mcpExecutor(
  client: Client,
  remoteName: string,
  hooks?: McpCallHooks,
  callTimeoutMs?: number,
): ToolExecutorRef {
  return {
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      hooks?.onCallStart?.();
      const t = makeCallSignal(ctx.signal, callTimeoutMs);
      // progress notifications → ToolCallOutput delta（3G）：onprogress 推队列，循环实时抽干。
      const progressQ: string[] = [];
      let wake: (() => void) | null = null;
      const onprogress = (p: { progress: number; total?: number; message?: string }) => {
        progressQ.push(formatProgress(p));
        const w = wake;
        wake = null;
        w?.();
      };
      let settled = false;
      let failed = false; // 显式标志：勿用 `if (failure)`——falsy 拒因（reject(undefined/0/'')）会漏判（审查 L9）
      let result: Awaited<ReturnType<Client['callTool']>> | undefined;
      let failure: unknown;
      const callP = client
        .callTool({ name: remoteName, arguments: toArgs(input) }, undefined, { signal: t.signal, onprogress })
        .then(
          (r) => {
            result = r;
          },
          (e) => {
            failed = true;
            failure = e;
          },
        )
        .finally(() => {
          settled = true;
          const w = wake;
          wake = null;
          w?.();
        });
      try {
        for (;;) {
          while (progressQ.length > 0) yield { kind: 'output', chunk: progressQ.shift()! };
          if (settled) break;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
        await callP; // 已 settle；仅为满足 lint（promise 已被消费）
        if (failed) throw failure ?? new Error(`MCP 工具 ${remoteName} 调用失败（无拒因）`);
        hooks?.onTransportOk?.(); // 收到响应（即便 isError）= 连接健康
      } catch (e) {
        // 失败归因（§15.3 熔断）：传输错 / 本地超时 / kernel 超时(reason.name==='TimeoutError') 均计入熔断（server 挂死或不可达）；
        // 仅「真正的用户中断」（ctx.signal abort 且 reason 非 TimeoutError）中性不计（审查 ATTR-3：双层超时不得被误判为中断）。
        const abortedByUser = !!ctx.signal?.aborted && (ctx.signal.reason as { name?: string } | undefined)?.name !== 'TimeoutError';
        if (!abortedByUser) hooks?.onTransportFail?.();
        throw t.timedOut() ? new Error(`MCP 工具 ${remoteName} 调用超时（${callTimeoutMs}ms），已中止`) : e;
      } finally {
        t.dispose();
        hooks?.onCallEnd?.();
      }
      const res = result!;
      const chunks = (Array.isArray(res.content) ? res.content : [])
        .map((b) => normalizeBlock(b as ContentBlock))
        .filter((c) => c.length > 0);
      // isError：内容承载错误详情（tool 级错误，连接健康，不计熔断）。kernel 在 catch 中以 e.message 覆盖已 yield 的输出，
      // 故错误路径必须一次性 throw 携带全文（先 yield 再 throw 会丢内容）。
      if (res.isError) {
        throw new Error(chunks.join('\n') || `MCP 工具 ${remoteName} 返回错误（无内容）`);
      }
      // content 为空但有 structuredContent（带 outputSchema 的工具，content[] 仅 SHOULD）→ 回退结构化全文，
      // 否则 LLM 拿到空观测（审查 protocol-correctness）。成功路径与 isError 同用 join('\n') 保块边界一致。
      if (chunks.length === 0 && res.structuredContent !== undefined) {
        yield { kind: 'output', chunk: JSON.stringify(res.structuredContent) };
        return;
      }
      const text = chunks.join('\n');
      if (text) yield { kind: 'output', chunk: text };
    },
  };
}

/** tools/list 单项的最小结构（外部 server 返回，字段不可信）。 */
export interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** listTools 的最小结构接口（便于离线单测分页，无需起真实 server）。 */
export interface ToolLister {
  listTools(params?: { cursor?: string }): Promise<{ tools: RawMcpTool[]; nextCursor?: string }>;
}

/** 游标分页全量拉取 tools/list（首页之后的工具不丢，审查 protocol-correctness）。 */
export async function listAllTools(client: ToolLister): Promise<RawMcpTool[]> {
  const all: RawMcpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    all.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/**
 * 原始工具列表 → RegisteredTool[]，per-tool 隔离：单个非法工具名（toolDescriptorFromMcp 抛错）只跳过该工具，
 * 不让整台 server 的工具一起消失（审查 completeness：throw 曾在 per-tool try/catch 之外）。
 */
export function mapDiscoveredTools(
  server: string,
  client: Client,
  rawTools: RawMcpTool[],
  log?: (m: string) => void,
  hooks?: McpCallHooks,
  callTimeoutMs?: number,
): RegisteredTool[] {
  const out: RegisteredTool[] = [];
  for (const t of rawTools) {
    try {
      out.push({
        descriptor: toolDescriptorFromMcp(server, t),
        executor: mcpExecutor(client, t.name, hooks, callTimeoutMs),
      });
    } catch (e) {
      log?.(`[mcp] 跳过 ${server} 的非法工具「${t.name}」：${errMsg(e)}`);
    }
  }
  return out;
}

type ContentBlock = { type: string; [k: string]: unknown };

/** MCP 入参恒为 object schema；非对象入参兜底包一层（防 SDK 校验拒）。 */
/** progress 通知 → 人读进度文本（3G）。 */
function formatProgress(p: { progress: number; total?: number; message?: string }): string {
  if (p.message) return p.message;
  return p.total !== undefined ? `进度 ${p.progress}/${p.total}` : `进度 ${p.progress}`;
}

function toArgs(input: unknown): Record<string, unknown> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  return { value: input };
}

/**
 * CallToolResult content 块归一为文本 chunk。
 * 已知有损降级：images/audio/resource 二进制内容压成占位串（ToolEvent 仅文本，非文本承载推迟 Phase N）。
 */
function normalizeBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'image':
    case 'audio':
      return `[${block.type} ${String(block.mimeType ?? '')}，${dataLen(block.data)}B base64 已省略（非文本承载推迟，见 Phase 3 已知限制）]`;
    case 'resource': {
      const r = block.resource as { uri?: string; text?: string; mimeType?: string } | undefined;
      if (r && typeof r.text === 'string') return r.text;
      return `[resource ${r?.uri ?? ''}${r?.mimeType ? ' ' + r.mimeType : ''}（无内联文本）]`;
    }
    case 'resource_link':
      return `[resource_link ${String(block.uri ?? '')}]`;
    default:
      return `[${block.type} 内容已省略]`;
  }
}

function dataLen(data: unknown): number {
  return typeof data === 'string' ? data.length : 0;
}

/** McpConnection 运行时配置（时钟/超时/熔断/状态回调由 manager 注入）。 */
export interface McpConnectionOptions {
  now?: () => number;
  callTimeoutMs?: number;
  breaker?: CircuitBreakerOptions;
  log?: (m: string) => void;
  /** 熔断打开瞬间回调（manager 据此发 onStatus failed）。 */
  onStatusChange?: (status: McpServerStatus) => void;
  /** 收到 tools/list_changed 通知（manager 据此重建工具集，非热换）。 */
  onListChanged?: () => void;
  /** sampling 处理器（3G）：提供则声明 client sampling 能力并注册 createMessage 处理器（限流/计费在 handler 内）。 */
  samplingHandler?: SamplingHandler;
}

/** 单个 MCP server 连接：封装 SDK Client + Transport + 生命周期 + 熔断/in-flight/空闲时钟 + 已注册工具名。 */
export class McpConnection {
  private readonly client: Client;
  private toolNames: string[] = [];
  private readonly now: () => number;
  private readonly callTimeoutMs: number | undefined;
  private readonly breaker: CircuitBreaker;
  private readonly hooks: McpCallHooks;
  /** 在飞调用计数（空闲断连前查此，>0 推迟，防竞态）。 */
  private inFlightCount = 0;
  /** 末次调用时刻（空闲 TTL 基准）；连接建立即视为刚活跃。 */
  private lastUsed: number;

  constructor(
    readonly server: string,
    private readonly transport: Transport,
    private readonly opts: McpConnectionOptions = {},
  ) {
    // 提供 samplingHandler → 声明 sampling 能力，server 方可反向 createMessage（3G）。
    this.client = new Client(
      { name: 'yo-agent', version: '0.1.0' },
      opts.samplingHandler ? { capabilities: { sampling: {} } } : undefined,
    );
    this.now = opts.now ?? (() => Date.now());
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
    this.breaker = new CircuitBreaker(opts.breaker);
    this.lastUsed = this.now();
    this.hooks = {
      onCallStart: () => {
        this.inFlightCount++;
        this.lastUsed = this.now();
      },
      onCallEnd: () => {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        this.lastUsed = this.now();
      },
      onTransportOk: () => this.breaker.recordSuccess(this.now()),
      onTransportFail: () => {
        const t = this.now();
        const wasOpen = this.breaker.isOpen(t);
        this.breaker.recordFailure(t);
        if (!wasOpen && this.breaker.isOpen(t)) this.opts.onStatusChange?.('failed');
      },
    };
  }

  async connect(): Promise<void> {
    // 注册 tools/list_changed 处理器（须在 connect 前/中就位，否则首条通知漏接）。显式重建非热换（§15.4）。
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.opts.onListChanged?.();
    });
    // 3G：sampling 反向请求路由到注入的处理器（限流/配额计费在 handler 内）。须在 connect 前注册。
    if (this.opts.samplingHandler) {
      const handler = this.opts.samplingHandler;
      this.client.setRequestHandler(CreateMessageRequestSchema, (req) => handler(req));
    }
    await this.client.connect(this.transport);
  }

  /** 3G — MCP resources：列资源 / 读资源（远端须声明 resources 能力，否则 SDK 抛错）。 */
  async listResources(): ReturnType<Client['listResources']> {
    return this.client.listResources();
  }
  async readResource(uri: string): ReturnType<Client['readResource']> {
    return this.client.readResource({ uri });
  }

  /** 3G — MCP prompts：列 prompt / 取 prompt（映射 /mcp__<server>__<prompt> slash）。 */
  async listPrompts(): ReturnType<Client['listPrompts']> {
    return this.client.listPrompts();
  }
  async getPrompt(name: string, args?: Record<string, string>): ReturnType<Client['getPrompt']> {
    return this.client.getPrompt({ name, arguments: args });
  }

  /**
   * tools/list 发现 → 经 3A 护栏映射为 RegisteredTool[]（不注册，交 manager 集中处理撞名）。
   * 游标分页全量拉取（首页之后的工具不丢）；per-tool 构造隔离——单个非法工具名只跳过该工具，
   * 不让 toolDescriptorFromMcp 抛错拖垮整台 server（审查 protocol-correctness / completeness）。
   * executor 绑本连接 hooks（in-flight/空闲/熔断）+ per-call 超时。
   */
  async discoverTools(): Promise<RegisteredTool[]> {
    const raw = await listAllTools(this.client);
    return mapDiscoveredTools(this.server, this.client, raw, this.opts.log, this.hooks, this.callTimeoutMs);
  }

  setRegistered(names: string[]): void {
    this.toolNames = names;
  }
  registeredNames(): readonly string[] {
    return this.toolNames;
  }

  /** 熔断是否打开（冷却窗口内）→ flags() 据此撤下健康标志。 */
  breakerOpen(now: number): boolean {
    return this.breaker.isOpen(now);
  }
  get inFlight(): number {
    return this.inFlightCount;
  }
  get lastUsedAt(): number {
    return this.lastUsed;
  }
  /** 测试/重连用：直驱熔断（避免起真实失败的 client）。 */
  noteTransportFailure(now: number): void {
    const wasOpen = this.breaker.isOpen(now);
    this.breaker.recordFailure(now);
    if (!wasOpen && this.breaker.isOpen(now)) this.opts.onStatusChange?.('failed');
  }

  /** 远端能力协商（判断支持 tools/resources/prompts，为 3G 铺路）。 */
  capabilities(): ReturnType<Client['getServerCapabilities']> {
    return this.client.getServerCapabilities();
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (e) {
      this.opts.log?.(`[mcp] 关闭 ${this.server} 出错：${errMsg(e)}`);
    }
  }
}

export interface McpHostOptions {
  registry: ToolRegistry;
  /** 为 server 造 transport（生产用 createStdioClientTransport；测试注入 InMemoryTransport）。 */
  transportFor: (server: ResolvedMcpServer) => Transport;
  log?: (msg: string) => void;
  /** 注入时钟（测试用），默认 Date.now。 */
  now?: () => number;
  /** per-call 超时（ms），默认 60s。 */
  callTimeoutMs?: number;
  /** 熔断参数（阈值/冷却）。 */
  breaker?: CircuitBreakerOptions;
  /** 空闲 TTL（ms），默认 10min。 */
  idleTtlMs?: number;
  /** 连接状态变化回调（连接/断连/熔断），供运行日志（与 kernel 落库的 statusSnapshot 解耦）。 */
  onStatus?: (status: McpServerStatusInfo) => void;
  /** 工具集重建后回调（list_changed 触发），供测试 await 重建完成。 */
  onToolsChanged?: (server: string) => void;
  /** sampling 处理器（3G）：提供则各连接声明 sampling 能力，server 反向 createMessage 路由到此（限流/计费在内）。 */
  samplingHandler?: SamplingHandler;
}

/** 多 server 编排：连接 → 发现 → 注册到 registry；维护连接健康标志集喂 kernel.toolFlags；3C 韧性回路。 */
export class McpHostManager {
  private readonly conns = new Map<string, McpConnection>();
  private readonly healthy = new Set<string>();
  /** 已加载的 server 规格（供跨进程 resume / 空闲断连后重连复用，由 ensureConnected 读取）。 */
  private readonly specs = new Map<string, ResolvedMcpServer>();
  /** 正在重建的 server（防 list_changed 风暴并发重入）。 */
  private readonly rebuilding = new Set<string>();
  /** 重建进行中又到达 list_changed → 标脏，当前轮收口后补跑一次（coalescing，防丢更新，审查 CONC-1）。 */
  private readonly rebuildDirty = new Set<string>();
  /** 工具集世代号（按 server 名单调递增；连接/重连/重建各 +1）：喂 statusSnapshot.epoch，kernel 据此失效审批缓存。 */
  private readonly epochs = new Map<string, number>();
  /** 进行中的连接（按 server 名）：并发 addServer/ensureConnected 命中同名 → 复用同一 promise，绝不重复 spawn（审查 CONC-RECONN-1）。 */
  private readonly connecting = new Map<string, Promise<McpConnection>>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;

  constructor(private readonly opts: McpHostOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_MCP_IDLE_TTL_MS;
  }

  private bumpEpoch(name: string): number {
    const e = (this.epochs.get(name) ?? 0) + 1;
    this.epochs.set(name, e);
    return e;
  }

  /** kernel.toolFlags 数据源：已连接且熔断未打开的 server 的工具才经 availability 可见。 */
  flags(): Iterable<string> {
    const now = this.now();
    const out = new Set<string>();
    for (const conn of this.conns.values()) {
      if (conn.breakerOpen(now)) continue; // 熔断中 → 工具从 resolveAvailable 消失（冷却后恢复）
      out.add(mcpHealthFlag(conn.server));
    }
    return out;
  }
  connectedServers(): string[] {
    return [...this.conns.keys()];
  }
  connection(name: string): McpConnection | undefined {
    return this.conns.get(name);
  }

  // ───────────────────────── 3G 进阶通道：resources / prompts ─────────────────────────

  private requireConn(server: string): McpConnection {
    const c = this.conns.get(server);
    if (!c) throw new Error(`MCP server 未连接：${server}`);
    return c;
  }

  /** 列某 server 资源（远端须声明 resources 能力）。 */
  async listResources(server: string): ReturnType<McpConnection['listResources']> {
    return this.requireConn(server).listResources();
  }
  /** 读某 server 资源。 */
  async readResource(server: string, uri: string): ReturnType<McpConnection['readResource']> {
    return this.requireConn(server).readResource(uri);
  }
  /** 列某 server prompts。 */
  async listPrompts(server: string): ReturnType<McpConnection['listPrompts']> {
    return this.requireConn(server).listPrompts();
  }
  /** 取某 server prompt（slash 命令展开）。 */
  async getPrompt(server: string, name: string, args?: Record<string, string>): ReturnType<McpConnection['getPrompt']> {
    return this.requireConn(server).getPrompt(name, args);
  }
  /** prompt → slash 命令名：/mcp__<server>__<prompt>（§15.3）。 */
  promptSlashName(server: string, prompt: string): string {
    return `/mcp__${sanitizeMcpServerName(server)}__${prompt}`;
  }

  /** 连接状态快照（供 kernel diff 落 EventLog）：在册 server → connected/failed；已断连者不在册（kernel diff 出 disconnected）。 */
  statusSnapshot(): McpServerStatusInfo[] {
    const now = this.now();
    return [...this.conns.values()].map((conn) => ({
      server: conn.server,
      status: conn.breakerOpen(now) ? ('failed' as const) : ('connected' as const),
      toolCount: conn.registeredNames().length,
      epoch: this.epochs.get(conn.server) ?? 0,
    }));
  }

  async addServer(server: ResolvedMcpServer): Promise<McpConnection> {
    if (this.conns.has(server.name)) throw new Error(`MCP server「${server.name}」已连接`);
    // 并发去重：同名连接进行中（两个会话并发起 turn → 并发 ensureConnected）→ 复用同一 promise，
    // 否则两路都过同步守卫、各 spawn 一个子进程、后者覆盖前者 → 子进程泄漏 + 工具孤儿（审查 CONC-RECONN-1）。
    const inflight = this.connecting.get(server.name);
    if (inflight) return inflight;
    // 规范化名撞名守卫：两条原始名不同但 sanitize 后相同（github / GitHub）会共享工具前缀+健康标志，
    // 第二台必全工具撞名空载、白白 spawn 子进程。连接前（spawn 前）拦截（审查 completeness）。
    const flag = mcpHealthFlag(server.name);
    if (this.healthy.has(flag)) {
      throw new Error(`MCP server 规范化名「${sanitizeMcpServerName(server.name)}」与已连接 server 冲突，跳过`);
    }
    const p = this.doConnect(server, flag);
    this.connecting.set(server.name, p);
    try {
      return await p;
    } finally {
      this.connecting.delete(server.name);
    }
  }

  /** 实际连接 + 发现 + 注册（addServer 经 connecting 去重后调用，保证单 server 单飞）。 */
  private async doConnect(server: ResolvedMcpServer, flag: string): Promise<McpConnection> {
    const conn = new McpConnection(server.name, this.opts.transportFor(server), {
      now: this.now,
      callTimeoutMs: this.opts.callTimeoutMs,
      breaker: this.opts.breaker,
      log: this.opts.log,
      onStatusChange: (status) =>
        this.opts.onStatus?.({ server: server.name, status, toolCount: conn.registeredNames().length }),
      onListChanged: () => void this.rebuild(server.name),
      samplingHandler: this.opts.samplingHandler,
    });
    try {
      await conn.connect();
      const registered: string[] = [];
      for (const t of await conn.discoverTools()) {
        try {
          this.opts.registry.register(t);
          registered.push(t.descriptor.name);
        } catch (e) {
          // 撞名（与内置或别的 server）→ 跳过该工具，不静默覆盖（§15.3）、不撕整个连接。
          this.opts.log?.(`[mcp] 跳过 ${server.name} 的工具 ${t.descriptor.name}：${errMsg(e)}`);
        }
      }
      conn.setRegistered(registered);
    } catch (e) {
      await conn.close(); // 连接/发现失败 → 关 client 防子进程泄漏
      throw e;
    }
    this.conns.set(server.name, conn);
    this.healthy.add(flag);
    this.specs.set(server.name, server);
    this.bumpEpoch(server.name); // 连接/重连 → 世代 +1（kernel 据此失效审批缓存，防重连期 rug-pull）
    this.opts.log?.(`[mcp] 已连接 ${server.name}（${server.source}），注册 ${conn.registeredNames().length} 个工具`);
    this.opts.onStatus?.({ server: server.name, status: 'connected', toolCount: conn.registeredNames().length });
    return conn;
  }

  /** 批量启动：单个 server 失败不影响其余（记日志，继续）。 */
  async start(servers: ResolvedMcpServer[]): Promise<void> {
    for (const s of servers) {
      try {
        await this.addServer(s);
      } catch (e) {
        this.opts.log?.(`[mcp] 连接 ${s.name} 失败：${errMsg(e)}`);
      }
    }
  }

  /**
   * tools/list_changed → 显式重建工具集（§15.4 不热换）：全反注册本连接旧工具 + 全注册新发现工具，
   * registry.version 随增删自增（toolsetVersion 可观测）。turn 内 snapshot（3A）保证不在 turn 中途漂移前缀——
   * 本 turn 用起点快照，重建只影响下一 turn 的可见集。
   * 并发安全：重建进行中再来通知 → 标脏，当前轮收口后补跑一次（coalescing，防 list_changed 风暴丢更新，审查 CONC-1）；
   * 每轮 await 发现后复核连接仍在册（与 sweepIdle/disconnect 竞态）→ 已断则弃，绝不向 registry 注册孤儿工具（审查 CONC-2/5）。
   */
  async rebuild(name: string): Promise<void> {
    if (!this.conns.has(name)) return;
    if (this.rebuilding.has(name)) {
      this.rebuildDirty.add(name); // 重入 → 标脏，待当前轮补跑
      return;
    }
    this.rebuilding.add(name);
    try {
      do {
        this.rebuildDirty.delete(name);
        const conn = this.conns.get(name);
        if (!conn) return;
        const fresh = await conn.discoverTools();
        if (this.conns.get(name) !== conn) return; // await 期间连接被断开/替换 → 弃本轮，勿注册孤儿
        for (const old of conn.registeredNames()) this.opts.registry.unregister(old);
        const registered: string[] = [];
        for (const t of fresh) {
          try {
            this.opts.registry.register(t);
            registered.push(t.descriptor.name);
          } catch (e) {
            this.opts.log?.(`[mcp] 重建跳过 ${name} 的工具 ${t.descriptor.name}：${errMsg(e)}`);
          }
        }
        conn.setRegistered(registered);
        this.bumpEpoch(name); // 重建 → 世代 +1（kernel 据此失效审批缓存，防 list_changed rug-pull）
        this.opts.log?.(`[mcp] ${name} 工具集已重建（list_changed），现 ${registered.length} 个工具`);
        this.opts.onStatus?.({ server: name, status: 'connected', toolCount: registered.length });
      } while (this.rebuildDirty.has(name)); // 期间又来通知 → 以最新远端状态再跑一轮
    } catch (e) {
      this.opts.log?.(`[mcp] ${name} 工具集重建失败：${errMsg(e)}`);
    } finally {
      this.rebuilding.delete(name);
      this.rebuildDirty.delete(name);
      this.opts.onToolsChanged?.(name);
    }
  }

  /**
   * 按需重连（§15.3 会话级懒加载收口）：重连所有「在册 spec 但当前未连接」的 server——
   * 即被空闲 TTL 断连后又被需要的连接。kernel 在每 turn 起点调用，使空闲断连的工具在下一 turn 透明恢复，
   * 不致永久消失（审查 LIFE-6/9）。单 server 重连失败只记日志、不连累其余（与 start 容错口径一致）。
   */
  async ensureConnected(): Promise<void> {
    for (const [name, spec] of this.specs) {
      if (this.conns.has(name)) continue; // 已连接（含熔断打开仍在册）→ 跳过
      try {
        await this.addServer(spec);
      } catch (e) {
        this.opts.log?.(`[mcp] 重连 ${name} 失败：${errMsg(e)}`);
      }
    }
  }

  /**
   * 空闲 TTL 清理：超 idleTtlMs 无调用的连接断连回收子进程；**断连前查 in-flight 计数，>0 则推迟**（防竞态）。
   * 返回本轮实际断连的 server 名。生产由周期任务驱动（rpc 常驻），测试注入时钟直驱。
   */
  async sweepIdle(now: number = this.now()): Promise<string[]> {
    const disconnected: string[] = [];
    for (const [name, conn] of [...this.conns]) {
      if (now - conn.lastUsedAt <= this.idleTtlMs) continue;
      if (conn.inFlight > 0) {
        this.opts.log?.(`[mcp] ${name} 空闲超时但有 ${conn.inFlight} 个在飞调用，推迟断连`);
        continue;
      }
      await this.disconnect(name, 'disconnected');
      disconnected.push(name);
    }
    return disconnected;
  }

  /** 断开单个连接：反注册工具 + 撤健康标志 + 关 client；保留 spec（供重连）。 */
  private async disconnect(name: string, status: McpServerStatus): Promise<void> {
    const conn = this.conns.get(name);
    if (!conn) return;
    for (const t of conn.registeredNames()) this.opts.registry.unregister(t);
    this.healthy.delete(mcpHealthFlag(name));
    this.conns.delete(name);
    await conn.close();
    this.opts.log?.(`[mcp] 已断开 ${name}（${status}）`);
    this.opts.onStatus?.({ server: name, status });
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.conns.keys()]) await this.disconnect(name, 'disconnected');
    this.specs.clear();
    // 注意：epochs 有意**不清**——世代号须跨断连/重连单调递增，清零会使重连后 epoch 回到 1、
    // 与 kernel 缓存值相同 → 漏失审批缓存失效（重连期 rug-pull 隐患）。map 仅按 server 名有界。
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
