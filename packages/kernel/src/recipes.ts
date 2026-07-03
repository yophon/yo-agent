import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PermissionModeSchema } from '@yo-agent/protocol';
import type { PermissionMode } from '@yo-agent/protocol';
import { MAX_SKILL_FILE_BYTES, parseFrontmatter, parseList } from './skills';
import type { LoadWarn } from './skills';

/**
 * 子 agent recipe / profile（DESIGN §5 / §8，Roo mode / Goose Recipes 范式）：
 * 声明式定义一个子 agent —— 工具白名单 + 独立 prompt + 绑定 model + 权限模式。喂给 4C 的 `profile` 参数。
 *
 * 存储（提交 git 即全队共享）：`<dir>/<name>.md`，YAML-ish frontmatter + 正文（= system prompt）。
 * 安全：recipe 只能**请求**收紧——deriveSubagentPolicy 仍对 requestedTools/requestedMode 与 parent 取交集/更严者，
 * recipe 绝不能放大子 agent 权限（「只收紧」不变量，§2.5）。
 */
export interface Recipe {
  name: string;
  description?: string;
  /** 请求的工具白名单（再与 parent 取交集）。 */
  tools?: string[];
  /** 请求的绑定模型（opts.model 未显式指定时用）。 */
  model?: string;
  /** 请求的权限模式（再与 parent 取更严者）。 */
  permissionMode?: PermissionMode;
  /** system prompt 正文。 */
  prompt: string;
  source?: string;
}

function asPermissionMode(v: string | undefined): PermissionMode | undefined {
  if (!v) return undefined;
  const r = PermissionModeSchema.safeParse(v.trim());
  return r.success ? r.data : undefined;
}

/**
 * 解析单个 recipe 文件文本 → Recipe（name 缺省回退文件名）。
 * 非法 permissionMode 忽略该字段（不整体拒 recipe），4.9b：经 onWarn 告警不再静默。
 */
export function parseRecipe(text: string, fallbackName: string, source?: string, onWarn?: LoadWarn): Recipe {
  const { attrs, body } = parseFrontmatter(text);
  const tools = parseList(attrs.tools);
  const rawMode = attrs.permissionmode ?? attrs['permission-mode'];
  const mode = asPermissionMode(rawMode);
  if (rawMode && !mode) {
    onWarn?.(`[recipes] recipe「${attrs.name || fallbackName}」的 permissionMode「${rawMode}」非法，已忽略该字段`);
  }
  return {
    name: attrs.name || fallbackName,
    ...(attrs.description ? { description: attrs.description } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(attrs.model ? { model: attrs.model } : {}),
    ...(mode ? { permissionMode: mode } : {}),
    prompt: body,
    ...(source ? { source } : {}),
  };
}

/**
 * 从多个目录加载 recipes（后面目录同名覆盖前面 → 约定 global 在前、project 在后，project 优先）。
 * 仅 `<dir>/<name>.md`。目录不存在/不可读 → 跳过（不抛）。
 * onWarn（4.9b）：单文件超限/为空/不可读、非法 permissionMode 时告警（曾经静默——画像无声消失）。
 */
export async function loadRecipes(dirs: Array<{ dir: string; source?: string }>, onWarn?: LoadWarn): Promise<Map<string, Recipe>> {
  const byName = new Map<string, Recipe>();
  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const full = join(dir, entry);
      let text: string | null;
      try {
        if ((await stat(full)).size > MAX_SKILL_FILE_BYTES) {
          onWarn?.(`[recipes] 跳过 ${full}：超过 ${MAX_SKILL_FILE_BYTES} 字节上限（防 OOM）`); // 审查 4D-LOW
          continue;
        }
        text = (await readFile(full, 'utf8')).trim() || null;
        if (text == null) {
          onWarn?.(`[recipes] 跳过 ${full}：内容为空`);
          continue;
        }
      } catch (e) {
        onWarn?.(`[recipes] 读取 ${full} 失败，已跳过：${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const recipe = parseRecipe(text, entry.replace(/\.md$/i, ''), source, onWarn);
      byName.set(recipe.name, recipe);
    }
  }
  return byName;
}
