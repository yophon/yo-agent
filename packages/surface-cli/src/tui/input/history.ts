/**
 * 持久输入历史(4.6b):JSONL 追加写 ~/.config/yo-agent/history.jsonl(权限 600)。
 * 启动加载:同 cwd 的条目排在队尾(↑ 最先召回),组内保持时间序;上限滚动截断。
 * 全程 best-effort:fs 失败静默降级为纯内存(TUI 不因历史文件炸掉)。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HistoryEntry {
  ts: number;
  cwd: string;
  text: string;
}

export const HISTORY_LIMIT = 1000;

export class PersistentHistory {
  private items: string[];

  private constructor(
    private readonly file: string | null,
    private readonly cwd: string,
    items: string[],
  ) {
    this.items = items;
  }

  /** file 为 null → 纯内存(测试/显式关闭)。 */
  static load(file: string | null, cwd: string, limit = HISTORY_LIMIT): PersistentHistory {
    if (!file) return new PersistentHistory(null, cwd, []);
    try {
      if (!existsSync(file)) return new PersistentHistory(file, cwd, []);
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const entries: HistoryEntry[] = [];
      for (const line of lines.slice(-limit)) {
        try {
          const e = JSON.parse(line) as HistoryEntry;
          if (typeof e.text === 'string' && e.text) entries.push(e);
        } catch {
          // 脏行跳过
        }
      }
      // 同 cwd 靠后(↑ 优先召回),组内保持原时间序。
      const others = entries.filter((e) => e.cwd !== cwd).map((e) => e.text);
      const same = entries.filter((e) => e.cwd === cwd).map((e) => e.text);
      return new PersistentHistory(file, cwd, [...others, ...same]);
    } catch {
      return new PersistentHistory(null, cwd, []);
    }
  }

  list(): readonly string[] {
    return this.items;
  }

  /** 追加一条(连续重复跳过);持久化 best-effort。 */
  push(text: string): void {
    if (!text || this.items.at(-1) === text) return;
    this.items.push(text);
    if (!this.file) return;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const isNew = !existsSync(this.file);
      appendFileSync(this.file, JSON.stringify({ ts: Date.now(), cwd: this.cwd, text } satisfies HistoryEntry) + '\n');
      if (isNew) chmodSync(this.file, 0o600);
      this.rotate();
    } catch {
      // 静默:历史不可用不影响 TUI
    }
  }

  /** 超限 20% 时重写保留最近 LIMIT 条(避免每次 push 都重写)。 */
  private rotate(): void {
    if (!this.file) return;
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= HISTORY_LIMIT * 1.2) return;
    writeFileSync(this.file, lines.slice(-HISTORY_LIMIT).join('\n') + '\n', { mode: 0o600 });
  }
}
