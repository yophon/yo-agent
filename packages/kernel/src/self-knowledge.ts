/**
 * Agent 自知注入（4.9a / DESIGN §5.2 延伸）：把运行时事实（环境/模型目录/记忆机制/子代理画像/MCP 连接）
 * 渲染成 system prompt 常驻段落——修「自知信息只给人不给 LLM」病根（feedback/4.8 反馈①的根因）。
 *
 * 全部为纯渲染函数（数据由组合根注入，本模块不依赖 provider/surface-mcp），便于离线单测；
 * 仅 readGitBranch 触 fs（读 .git/HEAD，不 spawn git）。空数据 → 返回空串（该段不注入，不占 token）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** startSession 时喂给 systemSuffix 函数的会话事实（kernel 注入，见 AgentKernelDeps.systemSuffix）。 */
export interface SessionSelfInfo {
  model: string;
  cwd: string;
  permissionMode: string;
}

export interface EnvBlockInfo {
  cwd: string;
  workspaceRoot: string;
  /** 如 `darwin 25.5.0`（process.platform + os.release）。 */
  os: string;
  /** ISO 日期（YYYY-MM-DD）。 */
  date: string;
  gitBranch?: string;
  model: string;
  permissionMode: string;
}

/** env 块（对照 Claude Code `<env>`）：cwd/workspaceRoot/OS/日期/git 分支/当前模型/会话初始权限模式。 */
export function renderEnvBlock(info: EnvBlockInfo): string {
  const lines = [
    '# 环境',
    `- cwd：${info.cwd}`,
    `- workspaceRoot：${info.workspaceRoot}`,
    `- OS：${info.os}`,
    `- 日期：${info.date}`,
    ...(info.gitBranch ? [`- git 分支：${info.gitBranch}`] : []),
    `- 当前模型：${info.model}`,
    `- 权限模式：${info.permissionMode}（会话起点值；用户可中途切换，切换后会另行提示）`,
  ];
  return lines.join('\n');
}

export interface ModelBrief {
  id: string;
  displayName?: string;
  contextWindow?: number;
}

/**
 * 模型目录段：当前模型 + 可用清单（LLM 从此有真实模型名可抄，不再裸猜连环 404）。
 * available 为空（目录未收录当前模型）→ 明确说「不要猜模型名」而非列空表。
 */
export function renderModelSection(current: string, available: ModelBrief[]): string {
  if (available.length === 0) {
    return [
      '# 可用模型',
      `当前模型：${current}（模型目录未收录，无法枚举同 provider 的其他模型）。`,
      '派生子代理时请留空 model 沿用当前模型；不要凭记忆猜模型名（未知名会直接被上游拒绝）。',
    ].join('\n');
  }
  const lines = available.map(
    (m) =>
      `- \`${m.id}\`${m.displayName ? `（${m.displayName}${m.contextWindow ? `，${Math.round(m.contextWindow / 1000)}k 上下文` : ''}）` : ''}${m.id === current ? ' ←当前' : ''}`,
  );
  return [
    '# 可用模型',
    ...lines,
    '指定模型（如派生子代理的 model 参数）只能从上表选择或留空沿用当前模型；不要凭记忆猜模型名。',
  ].join('\n');
}

/** 记忆机制 preamble：告知有长期记忆、按 workspace 隔离、如何写（writeTool 提供则枚举 agent 侧写入手段）。 */
export function renderMemoryPreamble(opts: { workspaceRoot: string; writeTool?: string }): string {
  const write = opts.writeTool
    ? `你可以用 \`${opts.writeTool}\` 工具写入一条长期记忆；用户也可以用 \`#remember <文本>\` 手动写入。`
    : '用户可以用 `#remember <文本>` 手动写入一条长期记忆。';
  return [
    '# 长期记忆',
    `本 workspace 有跨会话长期记忆，落盘于 \`${join(opts.workspaceRoot, 'MEMORY.md')}\`（按 workspace 隔离，不跨仓库泄漏）。`,
    '其内容（若存在）已并入本 system prompt 的约定文件部分。',
    write,
  ].join('\n');
}

export interface ProfileBrief {
  name: string;
  description?: string;
}

/** 子代理画像枚举：可用 recipe 清单（与模型目录同构——LLM 有真实画像名可抄，不再裸猜静默降级）。 */
export function renderProfileSection(profiles: ProfileBrief[]): string {
  const lines = profiles.map((p) => `- \`${p.name}\`${p.description ? `：${p.description}` : ''}`);
  return [
    '# 子代理画像（subagent_spawn 的 profile 参数）',
    '- `default`：无定制画像，沿用父会话工具与权限（留空即此）',
    ...lines,
  ].join('\n');
}

export interface McpServerBrief {
  server: string;
  status: string;
  toolCount?: number;
}

/**
 * MCP server 摘要：已连接清单 + 被信任门跳过的名单——LLM 能解释「为什么没有 X 的工具」
 * 并引导用户 opt-in 信任。两边都空 → 空串（无 MCP 时不占 token）。
 */
export function renderMcpSection(connected: McpServerBrief[], skippedUntrusted: string[]): string {
  if (connected.length === 0 && skippedUntrusted.length === 0) return '';
  const lines: string[] = ['# MCP server'];
  for (const c of connected) {
    lines.push(`- \`${c.server}\`：${c.status}${c.toolCount !== undefined ? `（${c.toolCount} 个工具，前缀 mcp__${c.server}__）` : ''}`);
  }
  if (skippedUntrusted.length > 0) {
    lines.push(
      `以下 server 已配置但未被信任（供应链防护，默认不启用）：${skippedUntrusted.map((s) => `\`${s}\``).join('、')}。`,
      '用户可在 `~/.yo-agent/mcp-trust.json` 按项目路径记名 opt-in 后重启启用——若用户问起这些工具为何缺席，据此解释。',
    );
  }
  return lines.join('\n');
}

/** 组合各自知段（跳过空段），段间空行分隔。 */
export function composeSystemSections(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => !!p).join('\n\n');
}

/**
 * 读当前 git 分支（直读 .git/HEAD，不 spawn git）：`ref: refs/heads/<branch>` → 分支名；
 * detached HEAD → 短 hash。非 git 仓库 / worktree 的 .git 文件形态 → undefined（env 块省略该行）。
 */
export async function readGitBranch(workspaceRoot: string): Promise<string | undefined> {
  try {
    const head = (await readFile(join(workspaceRoot, '.git', 'HEAD'), 'utf8')).trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (m) return m[1]!.trim();
    return head ? head.slice(0, 12) : undefined;
  } catch {
    return undefined;
  }
}
