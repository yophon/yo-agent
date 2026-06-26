/**
 * MCP host 连接层（DESIGN §3.3 / §15.3）—— outbound MCP client：
 *   连接 → tools/list 发现 → 经 3A 护栏映射注册 → tools/call 包成 ToolExecutorRef。
 *
 * 与 `mcp-surface.ts`（yo-agent 作 server）对称：`createStdioClientTransport` 对称于 `createStdioTransport`，
 * SDK 依赖收在本包，app 依赖面不扩大。外部 server 是**不可信输入源**，全部经 3A 护栏：
 *   命名隔离 `mcp__{server}__{tool}`（防撞名错路由）、schema 清洗（防注入/超大）、审批 clamp（绝不 never）。
 *
 * 连接健康用 configFlag 表达（`mcp:{server}`）：host 维护健康标志集（`flags()`），喂给
 * kernel.toolFlags；3C 熔断时撤下标志 → 工具经 `evalAvailability` 从 resolveAvailable 消失（无需 unregister）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RegisteredTool, ToolDescriptor, ToolEvent, ToolExecutorRef, ToolRegistry } from '@yo-agent/tools';
import { clampMcpApproval, mcpToolName, sanitizeMcpInputSchema, sanitizeMcpServerName } from '@yo-agent/tools';
import type { ResolvedMcpServer } from './mcp-config';

/** server 连接健康标志（availability configFlag）；3C 熔断时撤下 → 工具从 resolveAvailable 消失。 */
export function mcpHealthFlag(server: string): string {
  return `mcp:${sanitizeMcpServerName(server)}`;
}

/** 顶层 description 截断上限（与 sanitizeMcpInputSchema 的 maxStringLen 对齐，降 tool-poisoning 注入面）。 */
const MCP_DESC_MAX = 8192;

/** stdio client transport 工厂（SDK 依赖收在本包；env 由 SDK 自动并入 getDefaultEnvironment，PATH 不丢）。 */
export function createStdioClientTransport(server: ResolvedMcpServer): Transport {
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: Object.keys(server.env).length ? server.env : undefined,
    stderr: 'inherit', // 子 server stderr 直通本进程 stderr，不混入 stdout 协议帧
  });
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
    availability: { configFlag: mcpHealthFlag(server) }, // 绑连接健康（3C 熔断接缝）
    approval: clampMcpApproval(undefined), // 外部工具无 approval 声明 → risk-based，绝不 never（必走 ApprovalGate）
  };
}

/** 包 client.callTool 为 ToolExecutorRef：CallToolResult.content[] 归一为 ToolEvent。 */
export function mcpExecutor(client: Client, remoteName: string): ToolExecutorRef {
  return {
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const res = await client.callTool({ name: remoteName, arguments: toArgs(input) }, undefined, {
        signal: ctx.signal, // 复用 3A 接缝：interrupt / per-call 超时 abort 透传到远端调用
      });
      const chunks = (Array.isArray(res.content) ? res.content : [])
        .map((b) => normalizeBlock(b as ContentBlock))
        .filter((c) => c.length > 0);
      // isError：内容承载错误详情。kernel 在 catch 中以 e.message 覆盖已 yield 的输出，
      // 故错误路径必须一次性 throw 携带全文（先 yield 再 throw 会丢内容）。
      if (res.isError) {
        throw new Error(chunks.join('\n') || `MCP 工具 ${remoteName} 返回错误（无内容）`);
      }
      for (const c of chunks) yield { kind: 'output', chunk: c };
    },
  };
}

type ContentBlock = { type: string; [k: string]: unknown };

/** MCP 入参恒为 object schema；非对象入参兜底包一层（防 SDK 校验拒）。 */
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

/** 单个 MCP server 连接：封装一个 SDK Client + Transport + 生命周期 + 已注册工具名（断连反注册用）。 */
export class McpConnection {
  private readonly client: Client;
  private readonly toolNames: string[] = [];

  constructor(
    readonly server: string,
    private readonly transport: Transport,
    private readonly log?: (m: string) => void,
  ) {
    this.client = new Client({ name: 'yo-agent', version: '0.1.0' });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  /** tools/list 发现 → 经 3A 护栏映射为 RegisteredTool[]（不注册，交 manager 集中处理撞名）。 */
  async discoverTools(): Promise<RegisteredTool[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      descriptor: toolDescriptorFromMcp(this.server, t),
      executor: mcpExecutor(this.client, t.name),
    }));
  }

  rememberRegistered(name: string): void {
    this.toolNames.push(name);
  }
  registeredNames(): readonly string[] {
    return this.toolNames;
  }
  /** 远端能力协商（判断支持 tools/resources/prompts，为 3G 铺路）。 */
  capabilities(): ReturnType<Client['getServerCapabilities']> {
    return this.client.getServerCapabilities();
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (e) {
      this.log?.(`[mcp] 关闭 ${this.server} 出错：${errMsg(e)}`);
    }
  }
}

export interface McpHostOptions {
  registry: ToolRegistry;
  /** 为 server 造 transport（生产用 createStdioClientTransport；测试注入 InMemoryTransport）。 */
  transportFor: (server: ResolvedMcpServer) => Transport;
  log?: (msg: string) => void;
}

/** 多 server 编排：连接 → 发现 → 注册到 registry；维护连接健康标志集喂 kernel.toolFlags。 */
export class McpHostManager {
  private readonly conns = new Map<string, McpConnection>();
  private readonly healthy = new Set<string>();

  constructor(private readonly opts: McpHostOptions) {}

  /** kernel.toolFlags 数据源：仅健康（已连接）server 的工具经 availability 可见。 */
  flags(): Iterable<string> {
    return this.healthy;
  }
  connectedServers(): string[] {
    return [...this.conns.keys()];
  }

  async addServer(server: ResolvedMcpServer): Promise<McpConnection> {
    if (this.conns.has(server.name)) throw new Error(`MCP server「${server.name}」已连接`);
    const conn = new McpConnection(server.name, this.opts.transportFor(server), this.opts.log);
    try {
      await conn.connect();
      for (const t of await conn.discoverTools()) {
        try {
          this.opts.registry.register(t);
          conn.rememberRegistered(t.descriptor.name);
        } catch (e) {
          // 撞名（与内置或别的 server）→ 跳过该工具，不静默覆盖（§15.3）、不撕整个连接。
          this.opts.log?.(`[mcp] 跳过 ${server.name} 的工具 ${t.descriptor.name}：${errMsg(e)}`);
        }
      }
    } catch (e) {
      await conn.close(); // 连接/发现失败 → 关 client 防子进程泄漏
      throw e;
    }
    this.conns.set(server.name, conn);
    this.healthy.add(mcpHealthFlag(server.name));
    this.opts.log?.(`[mcp] 已连接 ${server.name}（${server.source}），注册 ${conn.registeredNames().length} 个工具`);
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

  async closeAll(): Promise<void> {
    for (const conn of this.conns.values()) {
      for (const name of conn.registeredNames()) this.opts.registry.unregister(name);
      this.healthy.delete(mcpHealthFlag(conn.server));
      await conn.close();
    }
    this.conns.clear();
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
