/**
 * Ink TUI（DESIGN §7.2）：差量渲染流式输出 + 交互审批 UX（↑↓ 选择 / Enter 确认）。
 * 用 React.createElement 而非 JSX，免 tsconfig jsx 配置、保持全 .ts。
 *
 * CliApp 组件可被 ink-testing-library 离线冒烟测试；runTui 用 ink 真 render（需 TTY）。
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { ApprovalDecision, ApprovalSuggestion, EventEnvelope, Id } from '@yo-agent/protocol';

const h = React.createElement;

/** CliApp 仅依赖内核的这几个方法（AgentKernel 满足），便于测试注入 fake。 */
export interface TuiKernel {
  subscribe(sessionId: Id, fromCursor: number | null, handler: (env: EventEnvelope) => void): () => void;
  submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<unknown>;
  decideApproval(requestId: Id, decision: ApprovalDecision, updatedInput?: unknown): void;
}

export interface CliAppProps {
  kernel: TuiKernel;
  sessionId: Id;
  prompt: string;
  /** 测试时关闭自动退出，便于断言帧。 */
  autoExit?: boolean;
}

interface ApprovalView {
  requestId: Id;
  tool: string;
  suggestions: ApprovalSuggestion[];
}

const DEFAULT_SUGGESTIONS: ApprovalSuggestion[] = [
  { decision: 'allow_once', label: '允许一次' },
  { decision: 'allow_always', label: '总是允许' },
  { decision: 'reject_once', label: '拒绝一次' },
  { decision: 'reject_always', label: '总是拒绝' },
];

export function CliApp(props: CliAppProps): React.ReactElement {
  const { kernel, sessionId, prompt, autoExit = true } = props;
  const { exit } = useApp();
  const [output, setOutput] = useState('');
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [selected, setSelected] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const unsub = kernel.subscribe(sessionId, null, (env) => {
      const e = env.event;
      switch (e.kind) {
        case 'AssistantText':
          if (e.delta) setOutput((o) => o + e.delta);
          break;
        case 'ToolCallStarted':
          setOutput((o) => o + `\n[tool ${e.name}]\n`);
          break;
        case 'ToolCallOutput':
          setOutput((o) => o + e.chunk);
          break;
        case 'ToolCallCompleted':
          setOutput((o) => o + (e.status === 'error' ? ' [✗]\n' : ' [✓]\n'));
          break;
        case 'Error':
          setOutput((o) => o + `\n[错误: ${e.message}]\n`);
          break;
        case 'ContextCompacted':
          setOutput((o) => o + `\n[上下文压缩：省 ${e.tokensSaved} tokens]\n`);
          break;
        case 'ApprovalRequested':
          setSelected(0);
          setApproval({
            requestId: e.requestId,
            tool: e.tool,
            suggestions: e.suggestions.length ? e.suggestions : DEFAULT_SUGGESTIONS,
          });
          break;
        case 'TurnCompleted':
          setOutput((o) => o + `\n[完成: ${e.stopReason}]\n`);
          setDone(true);
          break;
        case 'TurnFailed':
          setOutput((o) => o + `\n[失败: ${e.error.message}]\n`);
          setDone(true);
          break;
        default:
          break;
      }
    });
    void kernel.submitInput(sessionId, prompt, `tui-${Date.now()}`).catch(() => {});
    return unsub;
  }, [kernel, sessionId, prompt]);

  useEffect(() => {
    if (done && autoExit) {
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [done, autoExit, exit]);

  useInput((_input, key) => {
    if (!approval) return;
    const n = approval.suggestions.length;
    if (key.upArrow) setSelected((s) => (s + n - 1) % n);
    else if (key.downArrow) setSelected((s) => (s + 1) % n);
    else if (key.return) {
      const dec = approval.suggestions[selected]!.decision;
      kernel.decideApproval(approval.requestId, dec);
      setApproval(null);
    }
  });

  const children: React.ReactElement[] = [h(Text, { key: 'out' }, output || '…')];
  if (approval) {
    children.push(
      h(
        Box,
        { key: 'approval', flexDirection: 'column', marginTop: 1 },
        h(Text, { key: 'hdr', color: 'yellow' }, `⚠ 审批请求：${approval.tool}  (↑↓ 选择，Enter 确认)`),
        ...approval.suggestions.map((sug, i) =>
          h(
            Text,
            { key: sug.decision, color: i === selected ? 'green' : undefined },
            `${i === selected ? '❯ ' : '  '}${sug.label ?? sug.decision}`,
          ),
        ),
      ),
    );
  }
  return h(Box, { flexDirection: 'column' }, ...children);
}

/** 真 render（需 TTY）。headless / jsonl 模式不应走这里。 */
export async function runTui(props: CliAppProps): Promise<void> {
  const { render } = await import('ink');
  const instance = render(h(CliApp, props));
  await instance.waitUntilExit();
}
