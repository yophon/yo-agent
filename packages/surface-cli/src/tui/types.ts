/**
 * TUI 对外契约(4.7d 自 app.ts 拆出):内核接缝 TuiKernel + 组件入参 CliAppProps。
 * 单独成文件也解掉 commands.ts ↔ app.ts 的类型环依赖。
 */
import type { ApprovalDecision, EventEnvelope, Id, PermissionMode } from '@yo-agent/protocol';
import type { SlashCommand } from './commands';

/** CliApp 仅依赖内核的这几个方法。可选项缺省时对应功能降级(FakeKernel 测试免实现)。 */
export interface TuiKernel {
  subscribe(sessionId: Id, fromCursor: number | null, handler: (env: EventEnvelope) => void): () => void;
  submitInput(sessionId: Id, prompt: string, idemKey: string): Promise<unknown>;
  decideApproval(requestId: Id, decision: ApprovalDecision, updatedInput?: unknown): void;
  interrupt?(sessionId: Id): Promise<void>;
  steer?(sessionId: Id, text: string): Promise<void>;
  listModels?(): Promise<ReadonlyArray<{ id?: string; name?: string }>>;
  /** /new 用;缺省时 /new 提示不可用。 */
  startSession?(opts?: { model?: string; cwd?: string; permissionMode?: PermissionMode }): Promise<Id>;
  // ── 4.6e 内核接缝(全部可选,缺省时对应命令降级提示)──
  setModel?(sessionId: Id, model: string): void;
  setPermissionMode?(sessionId: Id, mode: PermissionMode): void;
  compactNow?(sessionId: Id): Promise<boolean>;
  contextState?(sessionId: Id): { usedTokens: number; usableTokens: number };
  listPersistedSessions?(): Promise<
    ReadonlyArray<{ sessionId: Id; model: string; workspacePath: string; lastActiveAt: number }>
  >;
  resumeSession?(sessionId: Id): Promise<boolean>;
  // ── 4.7f 历史回放接缝 ──
  /** 已落库事件流(/resume 回放;缺省时恢复会话不回放,仅接续新事件)。 */
  events?: { read(sessionId: Id): AsyncIterable<EventEnvelope> };
  /** 审批是否仍挂起(回放跳过已决审批的 ApprovalRequested;缺省一律跳过)。 */
  isApprovalPending?(requestId: Id): boolean;
}

export interface CliAppProps {
  kernel: TuiKernel;
  sessionId: Id;
  /** 初始提问。空串 → 直接进输入态等待用户键入(交互式 REPL)。 */
  prompt: string;
  /** 状态栏展示用(不影响内核行为)。 */
  model?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  /** true:首轮完成即退出(单次模式 / 测试)。默认 false:多轮 REPL,持续到 /exit 或 Ctrl+C。 */
  autoExit?: boolean;
  /** 输入历史持久化路径;缺省 null = 纯内存(runTui 注入默认 ~/.config/yo-agent/history.jsonl)。 */
  historyFile?: string | null;
  /** @ 文件补全数据源(测试注入;缺省 git ls-files / fs 遍历)。 */
  fileLister?: (cwd: string) => Promise<string[]>;
  /** FakeProvider 演示态(状态栏醒目提示)。 */
  demo?: boolean;
  /** 启动即打开 /resume 选择器(`yoagent --resume` 不带 id)。 */
  openResumePicker?: boolean;
  /** 挂载即回放历史事件(`--resume <id>/last` 已恢复的会话,4.7f)。 */
  replayOnMount?: boolean;
  /** 扩展注入的 slash 命令(5.2b extension-host):与内置撞名时内置优先并告警;补全与 /help 同源自动带上。 */
  extraCommands?: SlashCommand[];
}
