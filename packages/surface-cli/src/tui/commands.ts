/**
 * Slash 命令注册表(4.6d):name/desc/run 声明式定义,补全菜单与 /help 从同一注册表生成。
 * run 通过 CommandDeps 拿会话上下文与 UI 能力;4.6e 起补 setModel/setPermissionMode 等内核接缝。
 */
import type { Tone } from '../tui-format';
import { fmtCost, fmtInt } from '../tui-format';
import type { PickerState, UiState } from './model';
import type { TuiKernel } from './types';
import type { Id, PermissionMode } from '@yo-agent/protocol';

/** Shift+Tab 循环圈(bypass/ci 不进循环,仅 /mode 显式可达)。 */
export const MODE_CYCLE: PermissionMode[] = ['read-only', 'supervised', 'accept-edits', 'autonomous'];
const ALL_MODES: Array<{ mode: PermissionMode; hint: string }> = [
  { mode: 'read-only', hint: '只读,一切修改被拒' },
  { mode: 'supervised', hint: '默认:非只读操作逐一审批' },
  { mode: 'accept-edits', hint: '文件编辑自动批,命令仍审批' },
  { mode: 'autonomous', hint: '低风险自动批,高风险仍审批' },
  { mode: 'ci', hint: '无人值守:默认拒绝待审操作' },
  { mode: 'bypass', hint: '危险:跳过全部审批' },
];

export interface CommandDeps {
  kernel: TuiKernel;
  sessionId(): Id;
  /** 当前生效模型(会话级,可被 /model 切换)。 */
  model: string;
  /** 当前生效权限模式。 */
  mode: PermissionMode;
  cwd: string;
  getState(): UiState;
  notice(tone: Tone, text: string): void;
  clear(): void;
  exit(): void;
  /** 打开通用选择器(审批/输入互斥由 app 保证)。 */
  openPicker(p: PickerState): void;
  /** /model 切换后的 UI 状态同步。 */
  setModelUi(model: string): void;
  /** /mode / Shift+Tab 切换后的 UI 状态同步。 */
  setModeUi(mode: PermissionMode): void;
  /** /resume:切换活动会话并重订阅。 */
  switchSession(id: Id): void;
  /** /new:开新会话并切换订阅(kernel.startSession 可用时)。 */
  newSession?(): Promise<void>;
  /** /reasoning:推理流显隐切换,返回新状态。 */
  toggleReasoning(): boolean;
  /** /tasks:打开子代理任务面板(4.10c;缺省时降级提示)。 */
  openTasks?(): void;
}

/** 切权限模式(Shift+Tab 与 /mode 共用):内核接缝 + UI 同步 + 提示。 */
export function applyMode(d: CommandDeps, mode: PermissionMode): void {
  if (!d.kernel.setPermissionMode) {
    d.notice('warn', '切换权限模式不可用:内核未暴露 setPermissionMode');
    return;
  }
  try {
    d.kernel.setPermissionMode(d.sessionId(), mode);
    d.setModeUi(mode);
    d.notice('info', `权限模式 → ${mode}`);
  } catch (e) {
    d.notice('error', `切换失败:${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface SlashCommand {
  /** 含 `/` 前缀。 */
  name: string;
  aliases?: string[];
  desc: string;
  run(deps: CommandDeps, args: string): void | Promise<void>;
}

/**
 * 构建命令表（5.2b：extra 注入扩展命令——与内置撞名（含别名）时内置优先，经 onClash 告警不静默覆盖）。
 * /help 与补全同源自本返回值：extra 注入即自动进帮助与补全菜单。
 */
export function buildCommands(extra: SlashCommand[] = [], onClash?: (name: string) => void): SlashCommand[] {
  const all: SlashCommand[] = [
    {
      name: '/help',
      desc: '显示命令与快捷键',
      run: (d) => d.notice('info', helpText(all)),
    },
    {
      name: '/clear',
      desc: '清空可视记录(不影响会话上下文)',
      run: (d) => d.clear(),
    },
    {
      name: '/new',
      desc: '结束当前会话,开新会话',
      run: async (d) => {
        if (!d.newSession) {
          d.notice('warn', '/new 不可用:内核未暴露 startSession');
          return;
        }
        await d.newSession();
      },
    },
    {
      name: '/model',
      desc: '查看/切换模型(选择器,下一轮生效)',
      run: async (d, args) => {
        d.notice('info', `当前模型:${d.model}`);
        const pick = (id: string): void => {
          if (!d.kernel.setModel) {
            d.notice('warn', '切换模型不可用:内核未暴露 setModel');
            return;
          }
          try {
            d.kernel.setModel(d.sessionId(), id);
            d.setModelUi(id);
            d.notice('info', `模型 → ${id}(下一轮生效)`);
          } catch (e) {
            d.notice('error', `切换失败:${e instanceof Error ? e.message : String(e)}`);
          }
        };
        if (args) {
          pick(args);
          return;
        }
        let names: string[] = [];
        try {
          const ms = (await d.kernel.listModels?.()) ?? [];
          names = ms.map((m) => m.id ?? m.name ?? '').filter(Boolean);
        } catch {
          // 列表失败走空
        }
        if (!names.length) {
          d.notice('warn', '模型目录为空;可 /model <id> 直接指定');
          return;
        }
        d.openPicker({
          title: '切换模型',
          items: names.map((id) => ({ label: id, value: id, hint: id === d.model ? '当前' : undefined })),
          selected: Math.max(0, names.indexOf(d.model)),
          onPick: (v) => pick(v as string),
        });
      },
    },
    {
      name: '/mode',
      desc: '切换权限模式(bypass 需二次确认)',
      run: (d, args) => {
        const apply = (mode: PermissionMode): void => {
          if (mode === 'bypass') {
            d.openPicker({
              title: 'bypass 跳过全部审批,确认?',
              items: [
                { label: '取消', value: 'cancel' },
                { label: '确认切到 bypass(危险)', value: 'bypass' },
              ],
              selected: 0,
              onPick: (v) => {
                if (v === 'bypass') applyMode(d, 'bypass');
              },
            });
            return;
          }
          applyMode(d, mode);
        };
        if (args) {
          const hit = ALL_MODES.find((m) => m.mode === args);
          if (!hit) {
            d.notice('warn', `未知模式:${args}(${ALL_MODES.map((m) => m.mode).join(' / ')})`);
            return;
          }
          apply(hit.mode);
          return;
        }
        d.openPicker({
          title: '切换权限模式',
          items: ALL_MODES.map((m) => ({ label: m.mode, value: m.mode, hint: m.mode === d.mode ? `当前 · ${m.hint}` : m.hint })),
          selected: Math.max(0, ALL_MODES.findIndex((m) => m.mode === d.mode)),
          onPick: (v) => apply(v as PermissionMode),
        });
      },
    },
    {
      name: '/compact',
      desc: '手动压缩上下文',
      run: async (d) => {
        if (!d.kernel.compactNow) {
          d.notice('warn', '/compact 不可用:内核未暴露 compactNow');
          return;
        }
        try {
          const done = await d.kernel.compactNow(d.sessionId());
          if (!done) d.notice('info', '无需压缩(窗口太短或压不动)');
          // 压成时 ContextCompacted 事件自带「省 N tokens」通知,不重复播报
        } catch (e) {
          d.notice('error', `压缩失败:${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: '/resume',
      desc: '恢复历史会话(选择器)',
      run: async (d) => {
        if (!d.kernel.listPersistedSessions || !d.kernel.resumeSession) {
          d.notice('warn', '/resume 不可用:需要持久化 store(YO_DB=路径)');
          return;
        }
        let rows: Awaited<ReturnType<NonNullable<typeof d.kernel.listPersistedSessions>>>;
        try {
          rows = await d.kernel.listPersistedSessions();
        } catch (e) {
          d.notice('error', `读取会话失败:${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        const current = d.sessionId();
        const items = rows
          .filter((r) => r.sessionId !== current)
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
          .slice(0, 20)
          .map((r) => ({
            label: `${String(r.sessionId).slice(0, 8)} · ${r.model}`,
            hint: `${new Date(r.lastActiveAt).toLocaleString()} · ${r.workspacePath}`,
            value: r.sessionId,
          }));
        if (!items.length) {
          d.notice('info', '没有可恢复的历史会话');
          return;
        }
        d.openPicker({
          title: '恢复会话',
          items,
          selected: 0,
          onPick: (v) => {
            void (async () => {
              const ok = await d.kernel.resumeSession!(v as Id).catch(() => false);
              if (!ok) {
                d.notice('error', `恢复失败:store 中无会话 ${String(v).slice(0, 8)}`);
                return;
              }
              d.switchSession(v as Id);
              d.notice('info', `已恢复会话 ${String(v).slice(0, 8)},可继续对话`);
            })();
          },
        });
      },
    },
    {
      name: '/cost',
      desc: '本会话用量明细(按轮)',
      run: (d) => {
        const s = d.getState();
        if (!s.costLog.length) {
          d.notice('info', '尚无已完成轮次');
          return;
        }
        const rows = s.costLog.map(
          (u, i) => `  #${i + 1}  ↑${fmtInt(u.inTok)} ↓${fmtInt(u.outTok)}${u.cacheTok ? `(cache ${fmtInt(u.cacheTok)})` : ''} · ${fmtCost(u.costUsd)}`,
        );
        const t = s.totals;
        rows.push(`  合计 ↑${fmtInt(t.inTok)} ↓${fmtInt(t.outTok)}${t.cacheTok ? `(cache ${fmtInt(t.cacheTok)})` : ''} · ${fmtCost(t.costUsd)}`);
        d.notice('info', ['用量明细:', ...rows].join('\n'));
      },
    },
    {
      name: '/mcp',
      desc: 'MCP server 连接状态',
      run: (d) => {
        const st = d.getState().mcpStatus;
        const names = Object.keys(st);
        if (!names.length) {
          d.notice('info', '本会话尚无 MCP server 活动');
          return;
        }
        const rows = names.map((n) => {
          const s = st[n]!;
          return `  ${n}  ${s.status}${s.toolCount !== undefined ? ` · ${s.toolCount} 工具` : ''}${s.error ? ` · ${s.error}` : ''}`;
        });
        d.notice('info', ['MCP servers:', ...rows].join('\n'));
      },
    },
    {
      name: '/tasks',
      desc: '子代理任务面板(查看运行中/已结束子代理与其事件流)',
      run: (d) => {
        if (!d.openTasks) {
          d.notice('warn', '/tasks 不可用');
          return;
        }
        d.openTasks();
      },
    },
    {
      name: '/reasoning',
      desc: '推理流显示开关',
      run: (d) => {
        const on = d.toggleReasoning();
        d.notice('info', `推理流:${on ? '显示' : '隐藏'}`);
      },
    },
    {
      name: '/cwd',
      desc: '显示工作目录',
      run: (d) => d.notice('info', `cwd: ${d.cwd}`),
    },
    {
      name: '/exit',
      aliases: ['/quit'],
      desc: '退出',
      run: (d) => d.exit(),
    },
  ];
  const taken = new Set(all.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  for (const c of extra) {
    const names = [c.name, ...(c.aliases ?? [])];
    if (names.some((n) => taken.has(n))) {
      onClash?.(c.name);
      continue; // 内置/先注册者优先，不静默覆盖
    }
    for (const n of names) taken.add(n);
    all.push(c);
  }
  return all;
}

/** 解析 `/cmd args`;非 slash(或首词不含 `/` 前缀)返回 null。 */
export function parseCommandLine(text: string): { name: string; args: string } | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const sp = t.indexOf(' ');
  if (sp === -1) return { name: t, args: '' };
  return { name: t.slice(0, sp), args: t.slice(sp + 1).trim() };
}

export function findCommand(commands: readonly SlashCommand[], name: string): SlashCommand | undefined {
  return commands.find((c) => c.name === name || c.aliases?.includes(name));
}

export function helpText(commands: readonly SlashCommand[]): string {
  const width = Math.max(...commands.map((c) => c.name.length + (c.aliases?.join(', ').length ?? 0)));
  const rows = commands.map((c) => {
    const names = [c.name, ...(c.aliases ?? [])].join(', ');
    return `  ${names.padEnd(width + 2)} ${c.desc}`;
  });
  return [
    '可用命令:',
    ...rows,
    '快捷键:Enter 发送 · Alt+Enter/Ctrl+J 换行 · 运行中 Enter 引导(steer)· Esc 中断 · Ctrl+O 工具详情',
    '  ↑↓ 历史/行移 · ←→/Ctrl+A/E 光标 · Ctrl+W/K/U 删词/删行/清空 · @ 文件补全 · Ctrl+C 双击退出',
  ].join('\n');
}
