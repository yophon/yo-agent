import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Skills 懒加载（DESIGN §5.4 / §8）：技能**摘要**（name+description）常驻上下文，**全文**仅在 `skill_activate`
 * 激活时加载（省 token）；激活后内容受压缩保护不被截断（见 condenser `protectedToolNames`，opencode PRUNE_PROTECTED_TOOLS）。
 *
 * 存储（提交 git 即全队共享）：`<dir>/<name>.md`（单文件）或 `<dir>/<name>/SKILL.md`（目录式，兼容 Claude Code）。
 * 文件用 YAML-ish frontmatter 声明 name/description，正文为全文指令。
 */
export interface Skill {
  name: string;
  description: string;
  /** 全文指令（激活时注入）。 */
  body: string;
  /** 来源（project/global/显式目录），可观测用。 */
  source?: string;
}

/** 极简 frontmatter 解析（无第三方 YAML 依赖）：`---\nkey: value\n---\n正文`。无 frontmatter → attrs 空、body 原文。 */
export function parseFrontmatter(text: string): { attrs: Record<string, string>; body: string } {
  const norm = text.replace(/\r\n/g, '\n');
  if (!norm.startsWith('---\n')) return { attrs: {}, body: norm };
  const end = norm.indexOf('\n---', 4);
  if (end === -1) return { attrs: {}, body: norm };
  const head = norm.slice(4, end);
  // 关闭分隔符行后的内容为正文（跳过 `\n---` 那一行剩余到下个换行）。
  const afterFence = norm.indexOf('\n', end + 1);
  const body = afterFence === -1 ? '' : norm.slice(afterFence + 1);
  const attrs: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) attrs[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  return { attrs, body: body.trim() };
}

/** 解析逗号/方括号列表：`a, b` 或 `[a, b]` → ['a','b']；空 → []。 */
export function parseList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** 解析单个 skill 文件文本 → Skill（name 缺省回退文件名/目录名）。 */
export function parseSkill(text: string, fallbackName: string, source?: string): Skill {
  const { attrs, body } = parseFrontmatter(text);
  return {
    name: attrs.name || fallbackName,
    description: attrs.description || '',
    body,
    ...(source ? { source } : {}),
  };
}

/** skill/recipe 加载告警回调（4.9b）：解析失败/超限/空文件不再「三不见」，由调用方接 stderr。 */
export type LoadWarn = (msg: string) => void;

/**
 * 从多个目录加载 skills（后面的目录同名覆盖前面 → 约定：global 在前、project 在后，project 优先）。
 * 支持 `<dir>/<name>.md` 与 `<dir>/<name>/SKILL.md` 两式。目录不存在/不可读 → 跳过（不抛）。
 * onWarn（4.9b）：单文件超限/为空/不可读时告警（曾经静默跳过——技能无声消失，feedback/4.8 病根 2）。
 */
export async function loadSkills(dirs: Array<{ dir: string; source?: string }>, onWarn?: LoadWarn): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // 目录不存在 → 跳过
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      let text: string | null = null;
      let fallbackName = entry.replace(/\.md$/i, '');
      try {
        const st = await stat(full);
        if (st.isDirectory()) {
          // 目录式：无 SKILL.md 是常态（非技能目录），tryRead 对缺失静默；有但坏（超限/空/不可读）才告警。
          text = await tryRead(join(full, 'SKILL.md'), onWarn);
          fallbackName = entry;
        } else if (entry.toLowerCase().endsWith('.md')) {
          text = await tryRead(full, onWarn);
        }
      } catch (e) {
        onWarn?.(`[skills] 读取 ${full} 失败，已跳过：${e instanceof Error ? e.message : String(e)}`);
      }
      if (text == null) continue;
      const skill = parseSkill(text, fallbackName, source);
      byName.set(skill.name, skill); // 后者覆盖（project 覆盖 global）
    }
  }
  return [...byName.values()];
}

/** 渲染技能摘要段（注入 system prompt；全文按需经 skill_activate 加载）。无技能 → 空串。 */
export function renderSkillSummaries(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- \`${s.name}\`：${s.description || '(无描述)'}`);
  return ['# 可用技能（仅摘要；需要时用 skill_activate 加载全文）', ...lines].join('\n');
}

/** skill/recipe 单文件读取上限（审查 4D-LOW：不可信 workspace 放数 GB .md 会 OOM 撑爆启动）。 */
export const MAX_SKILL_FILE_BYTES = 1024 * 1024; // 1 MiB

async function tryRead(path: string, onWarn?: LoadWarn): Promise<string | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null; // 不存在（目录式无 SKILL.md 是常态）→ 静默跳过
  }
  if (size > MAX_SKILL_FILE_BYTES) {
    onWarn?.(`[skills] 跳过 ${path}：超过 ${MAX_SKILL_FILE_BYTES} 字节上限（防 OOM）`);
    return null;
  }
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (!text) {
      onWarn?.(`[skills] 跳过 ${path}：内容为空`);
      return null;
    }
    return text;
  } catch (e) {
    onWarn?.(`[skills] 读取 ${path} 失败，已跳过：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
