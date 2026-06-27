/**
 * Condenser 实现（DESIGN §5.1 / ADR-6）。
 * - NoopCondenser：恒不压缩（测试 / 短会话）。
 * - SummarizingCondenser：保首 keepFirst + 保尾 keepTail 原始 + 中段 LLM 结构化 Handoff 摘要，
 *   摘要 prompt 强制逐字保留不透明标识符（OpenClaw IDENTIFIER_PRESERVATION），用便宜模型（opencode）。
 *
 * 压缩只影响"送 LLM 的消息窗口"；原始 EventLog 不删（§5.1）。tokensSaved 由内核估算并随 ContextCompacted 落库。
 */
import type { HandoffSummary } from '@yo-agent/protocol';
import type { CanonMessage, ChatRequest, ContentBlock, Provider } from '@yo-agent/provider';
import type { Condenser, CondenseOpts, ContextState } from './index';

/** 占位 Condenser：恒不压缩。 */
export class NoopCondenser implements Condenser {
  shouldCompact(_ctx: ContextState): boolean {
    return false;
  }
  async condense(messages: CanonMessage[]): Promise<CanonMessage[]> {
    return messages;
  }
}

/** 中段摘要器：把一段历史文本压成结构化交接摘要。便宜模型即可，可注入 fake 离线测试。 */
export type Summarizer = (text: string, hint?: string) => Promise<string>;

export interface SummarizingCondenserOpts {
  summarize: Summarizer;
  /** 触发阈值（默认 0.8，可配至 0.85，§15.10 C1）。 */
  thresholdRatio?: number;
  /** 保留开头条数（system + 首个 user，默认 2）。 */
  keepFirst?: number;
  /** 保留结尾原始轮数（默认 6）。 */
  keepTail?: number;
  /** 标识符缺失时对便宜模型的重试次数（默认 1，§15.10）。重试仍缺则确定性回填。 */
  maxIdentifierRetries?: number;
  /**
   * 压缩保护工具名集合（4D / DESIGN §5.4，opencode PRUNE_PROTECTED_TOOLS）：
   * 中段里含这些工具的 tool_use/tool_result 的消息对**逐字保留不进摘要**（如 skill_activate 激活的技能全文，
   * 压缩时不被截断）。缺省空集 → 行为同既有（整段中段摘要）。
   */
  protectedToolNames?: ReadonlySet<string>;
}

const SUMMARY_SYSTEM = [
  '你是上下文压缩器。把给定的对话历史压成结构化交接摘要，必须包含四节：',
  '## 目标 / ## 已发生 / ## 当前状态 / ## 下一步。',
  '逐字保留所有不透明标识符（UUID、hash、文件路径、URL、变量/函数名、错误码），',
  '不得缩写、改写或重构标识符。只输出摘要本身，不要寒暄。',
].join('\n');

export class SummarizingCondenser implements Condenser {
  private readonly summarize: Summarizer;
  private readonly thresholdRatio: number;
  private readonly keepFirst: number;
  private readonly keepTail: number;
  private readonly maxIdentifierRetries: number;
  private readonly protectedToolNames: ReadonlySet<string>;

  constructor(opts: SummarizingCondenserOpts) {
    this.summarize = opts.summarize;
    this.thresholdRatio = opts.thresholdRatio ?? 0.8;
    this.keepFirst = opts.keepFirst ?? 2;
    this.keepTail = opts.keepTail ?? 6;
    this.maxIdentifierRetries = opts.maxIdentifierRetries ?? 1;
    this.protectedToolNames = opts.protectedToolNames ?? new Set();
  }

  shouldCompact(ctx: ContextState): boolean {
    if (ctx.usableTokens <= 0) return false;
    return ctx.usedTokens >= this.thresholdRatio * ctx.usableTokens;
  }

  async condense(messages: CanonMessage[], opts: CondenseOpts = {}): Promise<CanonMessage[]> {
    let keepFirst = opts.keepFirst ?? this.keepFirst;
    let tailStart = messages.length - (opts.keepTail ?? this.keepTail);

    // 中段太短不值得压缩。
    if (tailStart <= keepFirst) return messages;

    // head 边界保护：head 末条不能以未配对 tool_use 结尾（其 tool_result 落中段被摘 → 孤儿 tool_use，Anthropic 400）。
    // 回退 keepFirst，把该 assistant(tool_use) 推进中段一并摘要。
    while (keepFirst > 1 && hasToolUse(messages[keepFirst - 1]!)) keepFirst--;

    // tail 边界保护：尾段不能以"孤儿 tool_result"开头（其配对 tool_use 会被摘进中段，provider 报错）。
    while (tailStart > keepFirst && hasToolResult(messages[tailStart]!)) tailStart--;
    if (tailStart <= keepFirst) return messages;

    const head = messages.slice(0, keepFirst);
    const middleAll = messages.slice(keepFirst, tailStart);
    const tail = messages.slice(tailStart);

    // 压缩保护（4D）：把含 protectedToolNames 工具的消息对（tool_use+tool_result）逐字摘出，仅摘要其余中段。
    const { protectedMsgs, toSummarize: middle } = partitionProtected(middleAll, this.protectedToolNames);
    if (middle.length === 0) return messages; // 中段全受保护 → 压不动，不发事件

    const middleText = renderForSummary(middle);
    // 标识符保真：压缩前抽取中段不透明标识符集合（UUID/path/hash/URL/error-code）。
    const wanted = extractIdentifiers(middleText);

    // 关键（审查 H1）：missing/回填/preserved 一律以「最终进窗文本」为基准，而非原始模型输出 summaryText。
    // 因为 parseHandoffSections→renderHandoff 会丢弃前言/未映射小节，模型已保留的标识符仍可能不进窗——
    // 只对 summaryText 校验会漏判 → 审计字段撒谎 + 标识符静默丢失。
    let summaryText = await this.summarize(middleText, opts.hint);
    let handoff = parseHandoffSections(summaryText);
    let rendered = renderHandoff(handoff, middle.length, []);
    let missing = wanted.filter((id) => !rendered.includes(id));
    // diff 检出缺失 → 对便宜模型单次（可配）重试，hint 明列必须逐字保留的标识符。
    for (let attempt = 0; attempt < this.maxIdentifierRetries && missing.length > 0; attempt++) {
      summaryText = await this.summarize(middleText, retryHint(opts.hint, missing));
      handoff = parseHandoffSections(summaryText);
      rendered = renderHandoff(handoff, middle.length, []);
      missing = wanted.filter((id) => !rendered.includes(id));
    }

    // 重试仍缺 → 确定性回填：把缺失标识符逐字注入交接（机制护栏，不靠 prompt 文字）。
    const backfilled = missing;
    const finalText = backfilled.length > 0 ? renderHandoff(handoff, middle.length, backfilled) : rendered;
    // preservedIdentifiers = finalText 实际逐字包含的集合（不虚报；回填后通常即全部 wanted）。
    const preserved = wanted.filter((id) => finalText.includes(id));
    opts.onHandoff?.(handoff, preserved);

    const summaryMsg: CanonMessage = {
      role: 'user',
      content: finalText,
    };
    // 合并相邻 user 消息：摘要(user) 与 head 末/tail 首/受保护段相邻的 user 会破坏 Anthropic 严格交替（400）。
    // 受保护段（逐字保留的技能全文等）插在摘要之后、tail 之前，保持其内部 tool_use/tool_result 配对完整。
    return mergeAdjacentUser([...head, summaryMsg, ...protectedMsgs, ...tail]);
  }
}

/**
 * 中段压缩保护分区（4D）：把含 protectedToolNames 工具（tool_use/tool_result）的消息逐字摘出，其余进摘要。
 * 配对完整性：受保护的 tool_use → 连带其后续 tool_result 消息；受保护的 tool_result → 连带其前置 tool_use 消息。
 * 空保护集 / 无命中 → 全部进摘要（行为同既有）。
 */
function partitionProtected(
  middle: CanonMessage[],
  protectedSet: ReadonlySet<string>,
): { protectedMsgs: CanonMessage[]; toSummarize: CanonMessage[] } {
  if (protectedSet.size === 0) return { protectedMsgs: [], toSummarize: middle };
  const mask = middle.map((m) => messageTouchesProtected(m, protectedSet));
  if (!mask.some(Boolean)) return { protectedMsgs: [], toSummarize: middle };
  // 配对扩展：每个受保护锚点连带其配对消息（assistant tool_use ↔ 紧随的 user tool_result）。
  for (let i = 0; i < middle.length; i++) {
    if (!mask[i]) continue;
    const m = middle[i]!;
    if (hasToolUse(m) && i + 1 < middle.length) mask[i + 1] = true;
    if (hasToolResult(m) && i - 1 >= 0) mask[i - 1] = true;
  }
  const protectedMsgs: CanonMessage[] = [];
  const toSummarize: CanonMessage[] = [];
  middle.forEach((m, i) => (mask[i] ? protectedMsgs : toSummarize).push(m));
  return { protectedMsgs, toSummarize };
}

/** 消息是否含受保护工具名的 tool_use 或 tool_result 块。 */
function messageTouchesProtected(m: CanonMessage, protectedSet: ReadonlySet<string>): boolean {
  if (!Array.isArray(m.content)) return false;
  return m.content.some(
    (b) =>
      (b.type === 'tool_use' && protectedSet.has(b.name)) ||
      (b.type === 'tool_result' && b.name !== undefined && protectedSet.has(b.name)),
  );
}

/** 重试 hint：在原 hint 后追加"必须逐字保留以下标识符"指令。 */
function retryHint(base: string | undefined, missing: string[]): string {
  const inst = `上一版摘要遗漏了这些必须逐字保留的标识符，请在重写的摘要中原样包含它们：\n${missing.join('\n')}`;
  return base ? `${base}\n\n${inst}` : inst;
}

/**
 * 把四节交接结构 + 回填标识符渲染为单条 user 消息文本。
 * 回填段（自动注入仍缺的标识符）保证最终消息逐字含全部 wanted（确定性护栏）。
 */
function renderHandoff(h: HandoffSummary, middleCount: number, backfilled: string[]): string {
  const parts = [`[上下文已压缩 —— 以下为中段 ${middleCount} 条历史的结构化交接]`];
  if (h.goal) parts.push(`## 目标\n${h.goal}`);
  if (h.whatHappened) parts.push(`## 已发生\n${h.whatHappened}`);
  if (h.currentState) parts.push(`## 当前状态\n${h.currentState}`);
  if (h.nextSteps) parts.push(`## 下一步\n${h.nextSteps}`);
  if (backfilled.length > 0) parts.push(`## 保留标识符（自动回填，逐字保真）\n${backfilled.join(', ')}`);
  return parts.join('\n\n');
}

const HANDOFF_TITLE_MAP: ReadonlyArray<[RegExp, keyof HandoffSummary]> = [
  [/目标|goal/i, 'goal'],
  [/已发生|发生|happened|history/i, 'whatHappened'],
  [/当前状态|状态|state|status|current/i, 'currentState'],
  [/下一步|后续|next|todo/i, 'nextSteps'],
];

function mapHandoffTitle(title: string): keyof HandoffSummary | null {
  const t = title.replace(/[:：#\s]/g, '');
  for (const [re, key] of HANDOFF_TITLE_MAP) if (re.test(t)) return key;
  return null;
}

/**
 * 确定性解析便宜模型产出的四节 markdown（## 目标 / 已发生 / 当前状态 / 下一步）为结构对象。
 * 无可识别标题（模型未守格式）→ 回退把全文塞入 whatHappened（不丢内容）。
 */
export function parseHandoffSections(text: string): HandoffSummary {
  const h: HandoffSummary = { goal: '', whatHappened: '', currentState: '', nextSteps: '' };
  const headerRe = /^#{1,6}[ \t]*(.+?)[ \t]*$/gm;
  const headers: Array<{ key: keyof HandoffSummary | null; bodyStart: number; headerStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    headers.push({ key: mapHandoffTitle(m[1]!), bodyStart: headerRe.lastIndex, headerStart: m.index });
  }
  if (headers.length === 0) {
    h.whatHappened = text.trim();
    return h;
  }
  // 前言（首标题前）+ 未映射小节 body 不丢弃，统一并入 whatHappened（审查 H1：避免标识符随被丢内容流失）。
  const extra: string[] = [];
  const preamble = text.slice(0, headers[0]!.headerStart).trim();
  if (preamble) extra.push(preamble);
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i]!;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1]!.headerStart : text.length;
    const body = text.slice(cur.bodyStart, bodyEnd).trim();
    if (!body) continue;
    if (cur.key) {
      // 同键多标题累加拼接（审查 #2：后者不覆盖前者）。
      h[cur.key] = h[cur.key] ? `${h[cur.key]}\n\n${body}` : body;
    } else {
      extra.push(body);
    }
  }
  if (extra.length > 0) h.whatHappened = h.whatHappened ? `${h.whatHappened}\n\n${extra.join('\n\n')}` : extra.join('\n\n');
  if (!h.goal && !h.whatHappened && !h.currentState && !h.nextSteps) h.whatHappened = text.trim();
  return h;
}

const URL_RE = /https?:\/\/[^\s)<>"'`]+/gi;
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const PATH_RE = /(?:\.{0,2}\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+/g;
// 带已知扩展名的裸文件名（无目录前缀，如 config.json/schema.sql）——PATH_RE 要求 ≥1 斜杠会漏（审查 L2）。
const BARE_FILE_RE = /\b[A-Za-z0-9_.-]+\.(?:json|ts|tsx|js|jsx|mjs|cjs|py|go|rs|sql|ya?ml|toml|lock|md|sh|env|txt|css|html?)\b/gi;
const HASH_RE = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/g;
// 错误码：1-2 个大写字母 + ≥3 位数字（TS2304/E404），收紧以排除 S3/HTTP2/UTF8/SHA256/MD5 等散文缩写（审查 L1）。
const ERRCODE_RE = /\b[A-Z]{1,2}\d{3,}\b/g;
const ERRNO_RE = /\bE[A-Z]{2,}\b/g;

/** 路径过滤：剔除 "and/or" 一类散文误命中——要求含扩展名 `.` 或 ≥2 分隔符或绝对/相对前缀。 */
function isPathish(s: string): boolean {
  if (s.includes('.')) return true;
  if ((s.match(/\//g)?.length ?? 0) >= 2) return true;
  return /^\.{0,2}\//.test(s);
}

/** 用空格等长替换已命中跨度，避免后续类别在已消费文本里重复命中（如 UUID 段被当 hash）。 */
function consume(text: string, re: RegExp, add: (s: string) => void): string {
  return text.replace(re, (mm) => {
    add(mm);
    return ' '.repeat(mm.length);
  });
}

/**
 * 抽取不透明标识符集合（UUID/URL/path/hash/error-code）——标识符保真 diff 的"应保留"基准。
 * 按 URL→UUID→path→hash 顺序消费，避免 URL 内路径段、UUID 内 hex 段被重复计入（降噪）。
 */
export function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  let rest = text;
  rest = consume(rest, URL_RE, (s) => out.add(s.replace(/[.,;:、，。）)]+$/u, '')));
  rest = consume(rest, UUID_RE, (s) => out.add(s));
  rest = consume(rest, PATH_RE, (s) => {
    if (isPathish(s)) out.add(s);
  });
  rest = consume(rest, BARE_FILE_RE, (s) => out.add(s)); // 无斜杠的裸文件名（PATH 之后，hash 之前）
  rest = consume(rest, HASH_RE, (s) => out.add(s));
  for (const mm of rest.matchAll(ERRCODE_RE)) out.add(mm[0]);
  for (const mm of rest.matchAll(ERRNO_RE)) out.add(mm[0]);
  return [...out].sort();
}

function hasToolUse(m: CanonMessage): boolean {
  return Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use');
}

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content;
}

/** 合并相邻的 user 消息为单条（content 拼成 block 数组），保证 user/assistant 交替合法。 */
function mergeAdjacentUser(messages: CanonMessage[]): CanonMessage[] {
  const out: CanonMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user' && m.role === 'user') {
      out[out.length - 1] = { role: 'user', content: [...toBlocks(prev.content), ...toBlocks(m.content)] };
    } else {
      out.push(m);
    }
  }
  return out;
}

/** 把 Provider 包成便宜模型摘要器（CLI 用同 provider 换便宜 model）。 */
export function makeProviderSummarizer(provider: Provider, model: string): Summarizer {
  return async (text, hint) => {
    const req: ChatRequest = {
      modelId: model,
      tools: [],
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: (hint ? `压缩指令：${hint}\n\n` : '') + text },
      ],
    };
    let out = '';
    for await (const ev of provider.streamChat(req)) {
      if (ev.kind === 'TextDelta') out += ev.text;
    }
    return out.trim() || '(摘要为空)';
  };
}

function hasToolResult(m: CanonMessage): boolean {
  if (m.role === 'tool') return true;
  return Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
}

function renderForSummary(messages: CanonMessage[]): string {
  return messages.map((m) => `### ${m.role}\n${renderContent(m.content)}`).join('\n\n');
}

function renderContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      switch (b.type) {
        case 'text':
        case 'thinking':
          return b.text;
        case 'tool_use':
          return `[调用 ${b.name}(${safeJson(b.input)})]`;
        case 'tool_result':
          return `[结果${b.isError ? '(错误)' : ''}: ${b.content}]`;
      }
    })
    .join('\n');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
