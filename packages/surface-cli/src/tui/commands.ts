/**
 * Slash 命令注册表(4.6d):name/desc/run 声明式定义,补全菜单与 /help 从同一注册表生成。
 * run 通过 CommandDeps 拿会话上下文与 UI 能力;4.6e 起补 setModel/setPermissionMode 等内核接缝。
 */
import type { Tone } from '../tui-format';
import { fmtCost, fmtInt } from '../tui-format';
import type { UiState } from './model';
import type { TuiKernel } from './app';
import type { Id } from '@yo-agent/protocol';

export interface CommandDeps {
  kernel: TuiKernel;
  sessionId(): Id;
  model: string;
  cwd: string;
  getState(): UiState;
  notice(tone: Tone, text: string): void;
  clear(): void;
  exit(): void;
  /** /new:开新会话并切换订阅(kernel.startSession 可用时)。 */
  newSession?(): Promise<void>;
  /** /reasoning:推理流显隐切换,返回新状态。 */
  toggleReasoning(): boolean;
}

export interface SlashCommand {
  /** 含 `/` 前缀。 */
  name: string;
  aliases?: string[];
  desc: string;
  run(deps: CommandDeps, args: string): void | Promise<void>;
}

export function buildCommands(): SlashCommand[] {
  return [
    {
      name: '/help',
      desc: '显示命令与快捷键',
      run: (d) => d.notice('info', helpText(buildCommands())),
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
      desc: '显示当前模型与可用模型',
      run: async (d) => {
        d.notice('info', `当前模型:${d.model}`);
        try {
          const ms = (await d.kernel.listModels?.()) ?? [];
          const names = ms.map((m) => m.id ?? m.name ?? '').filter(Boolean);
          if (names.length) d.notice('info', `可用模型:${names.join(', ')}`);
        } catch {
          // 列表失败静默
        }
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
