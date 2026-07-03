/**
 * McpServerSurface（DESIGN §3.3 / §7.2）：把 yo-agent 暴露为 MCP server，
 * 被 Claude Code / Cursor / Agents SDK 当**可编排执行节点**调用——委派一个子任务，
 * yo-agent 用自己的模型 + 内置工具跑完整 turn，返回最终回答与工具活动摘要。
 *
 * 安全（§15.3）：当前 `run` 以 autonomous（autoApproveGate 放行所有工具）跑——
 * 仅自托管 + 显式 `--mcp-server` 启用；破坏性工具经 MCP elicitation 二次确认留后续。
 * stdio 模式 stdout 是 MCP 协议通道，日志必须走 stderr。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { ApprovalGate, Kernel, Surface, SurfaceKind } from '@yo-agent/kernel';

/** autonomous 节点用：放行所有工具（orchestrator 已委派信任）。 */
export const autoApproveGate: ApprovalGate = {
  async request() {
    return { decision: 'allow_once' };
  },
};

/** stdio 传输工厂（把 MCP SDK 依赖收在本包内，app 只依赖本包）。 */
export function createStdioTransport(): Transport {
  return new StdioServerTransport();
}

export interface McpServerSurfaceOpts {
  transport: Transport;
  name?: string;
  version?: string;
}

export class McpServerSurface implements Surface {
  readonly kind: SurfaceKind = 'mcp-server';

  constructor(private readonly opts: McpServerSurfaceOpts) {}

  async start(kernel: Kernel): Promise<void> {
    const server = new McpServer({ name: this.opts.name ?? 'yo-agent', version: this.opts.version ?? '0.1.0' });
    server.registerTool(
      'run',
      {
        title: 'Run yo-agent',
        description:
          '把一个任务委派给 yo-agent：它用自己的模型 + 工具（读写文件/列目录等）跑一个完整 turn，返回最终回答与工具活动摘要。适合下放需独立上下文/不同模型的子任务。',
        inputSchema: {
          prompt: z.string().describe('要 yo-agent 执行的任务或问题'),
          model: z.string().optional().describe('覆盖模型 id（可选）'),
        },
      },
      async ({ prompt, model }) => this.runTask(kernel, prompt, model),
    );
    await server.connect(this.opts.transport);
  }

  /** 跑一个一次性会话的完整 turn，归并为 MCP CallToolResult。 */
  private async runTask(
    kernel: Kernel,
    prompt: string,
    model: string | undefined,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> {
    const text: string[] = [];
    const toolNameById = new Map<string, string>(); // runTask 局部，避免并发 run 互相污染
    const okToolIds: string[] = []; // 仅成功完成的工具
    const errors: string[] = [];
    let failed: string | undefined;
    const sessionId = await kernel.startSession(model ? { model } : {});
    const unsub = kernel.subscribe(sessionId, null, (env) => {
      const e = env.event;
      if (e.kind === 'AssistantText' && e.delta) text.push(e.delta);
      else if (e.kind === 'ToolCallStarted') toolNameById.set(e.id, e.name);
      else if (e.kind === 'ToolCallCompleted' && e.status === 'ok') okToolIds.push(e.id);
      else if (e.kind === 'Error') errors.push(e.message);
      else if (e.kind === 'TurnFailed') failed = failed ?? e.error.message;
      // 失败语义藏在 TurnCompleted.stopReason（内核对外只暴露 TurnCompleted/TurnFailed）：非 end_turn 即异常终止。
      else if (e.kind === 'TurnCompleted' && e.stopReason !== 'end_turn') failed = failed ?? e.stopReason;
    });
    try {
      await kernel.submitInput(sessionId, prompt, `mcp-${Date.now()}`);
    } catch (e) {
      failed = failed ?? (e instanceof Error ? e.message : String(e));
    } finally {
      unsub();
      kernel.endSession(sessionId); // 一次性会话回收，常驻 MCP server 防内存泄漏
    }
    const names = okToolIds.map((id) => toolNameById.get(id) ?? id);
    const used = [...new Set(names)];
    const summary = used.length ? `\n\n[yo-agent 成功执行 ${names.length} 次工具：${used.join(', ')}]` : '';
    const errNote = failed ? `\n\n（异常终止：${failed}${errors.length ? `；${errors.join('；')}` : ''}）` : '';
    const body = (text.join('').trim() || (failed ? '' : '（无输出）')) + errNote;
    return { content: [{ type: 'text', text: (body + summary).trim() || '（无输出）' }], isError: failed !== undefined };
  }
}
