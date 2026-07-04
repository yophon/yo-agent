/**
 * 扩展作者面 SDK（5.2b）。扩展 = 一个 TS/ESM 文件，default export `defineExtension(setup)`：
 *
 * ```ts
 * import { defineExtension } from '@yo-agent/extension-host';
 * export default defineExtension((yo) => {
 *   yo.on({ onPreToolUse: (ctx, p) => { if (bad(p)) return { decision: 'deny', reason: '…' }; } });
 *   yo.registerCommand({ name: 'hello', desc: '打招呼', run: async (ctx) => ctx.notice('hi') });
 * });
 * ```
 *
 * 定位是**可信档**（与 pi 同立场）：扩展跑在主进程，等同任意代码执行——项目目录扩展过信任门，
 * 不可信场景用 plugin-host（Worker 隔离）。能力面对齐 pi 但为自有 API（不背 pi ExtensionAPI 包袱，
 * 否决记录见 docs/PHASE-5.2.md）。
 */
import type { EventEnvelope, Id } from '@yo-agent/protocol';
import type { Hooks, SessionSelfInfo } from '@yo-agent/kernel';
import type { RegisteredTool } from '@yo-agent/tools';

/** 扩展 slash 命令执行上下文（TUI 经 main.ts 适配注入；其它 surface 可自行适配）。 */
export interface ExtensionCommandCtx {
  sessionId: Id;
  /** 输出一行提示到当前 surface（TUI notice 区）。 */
  notice(text: string): void;
}

export interface ExtensionCommand {
  /** 命令名（可带可不带 `/` 前缀，host 归一为带前缀）。 */
  name: string;
  desc: string;
  run(ctx: ExtensionCommandCtx, args: string): void | Promise<void>;
}

export interface ExecResult {
  output: string;
  exitCode: number;
}

/**
 * 扩展能力面。注册面（tool/command/system 段）在 setup 期调用；行动面（exec/steer/followUp）
 * 可在 setup 期或任意回调（hook/事件）里调用。
 */
export interface ExtensionApi {
  /** 扩展名（目录/文件名派生），日志与健康 flag（ext:<name>）标识。 */
  readonly name: string;
  /**
   * 注册工具（进主 ToolRegistry，与内置/MCP/插件工具同台）。钳制（照 plugin-host 范式）：
   * owner 强制 'plugin'、approval 绝不 'never'（缺省/never→risk-based）、availability 绑
   * ext:<name> 健康 flag、拒绝 mcp__ 保留前缀。撞名注册失败只告警不抛（不拖垮扩展）。
   */
  registerTool(tool: RegisteredTool): void;
  /** 注册 slash 命令（→ TUI extraCommands 接缝；与内置撞名时内置优先 + 告警）。 */
  registerCommand(cmd: ExtensionCommand): void;
  /** 追加 system prompt 段（startSession 时经 composeSystemSections 拼入；函数形态喂会话事实）。 */
  addSystemSection(section: string | ((info: SessionSelfInfo) => string)): void;
  /** 挂生命周期 hook（直通内核 HookBus 9 点；PreToolUse 可拦截/改写 input，语义见 kernel/hooks）。 */
  on(hooks: Hooks): void;
  /** 订阅事件流（22 变体 AgentEvent 全量；会话经 SessionStart 自动接上）。回调抛错只告警。 */
  onEvent(cb: (env: EventEnvelope) => void): void;
  /** 执行 shell 命令（走装配层共享 ExecBackend——与 bash 工具同一沙箱档/secret 剥离策略）。 */
  exec(cmd: string, opts?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ExecResult>;
  /** 向运行中的 turn 插话（直通 kernel.steer）。 */
  steer(sessionId: Id, text: string): Promise<void>;
  /**
   * 排队 follow-up：当前 turn 以 end_turn 正常完成后自动提交（interrupted/failed 不触发，队列保留）。
   * 注意与 TUI 本地输入队列相互独立（各自判据一致、互不可见）。
   */
  followUp(sessionId: Id, text: string): void;
  /** 运行日志（→ 装配层 onWarn/stderr 通道，带 [ext:<name>] 前缀）。 */
  log(msg: string): void;
}

export interface ExtensionModule {
  /** 识别标记：区分「defineExtension 产物」与任意 default export（loader 校验用）。 */
  readonly __yoExtension: true;
  setup(api: ExtensionApi): void | Promise<void>;
}

/** 定义一个扩展（default export 此返回值）。setup 在扩展加载时调用一次，抛错只跳过本扩展（围栏）。 */
export function defineExtension(setup: (yo: ExtensionApi) => void | Promise<void>): ExtensionModule {
  return { __yoExtension: true, setup };
}

/** 校验模块 default export 是否为 defineExtension 产物。 */
export function isExtensionModule(v: unknown): v is ExtensionModule {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as ExtensionModule).__yoExtension === true &&
    typeof (v as ExtensionModule).setup === 'function'
  );
}

/** 扩展健康 flag（availability configFlag；对齐 plugin-host 的 plugin:<id> 命名）。 */
export function extensionHealthFlag(name: string): string {
  return `ext:${name}`;
}
