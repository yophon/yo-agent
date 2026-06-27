import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryMemoryStore, SqliteMemoryStore } from '@yo-agent/store';
import type { MemoryRecord, MemoryStore } from '@yo-agent/store';

const rec = (workspacePath: string, key: string, content: string, updatedAt = 1000): MemoryRecord => ({
  workspacePath,
  key,
  content,
  updatedAt,
  source: 'remember',
});

// 共享的合约测试：内存与 SQLite 两实现行为一致（3E 退出标准）。
function contract(name: string, make: () => MemoryStore) {
  describe(name, () => {
    it('write → read 往返；upsert 覆盖同 (workspace,key)', async () => {
      const s = make();
      await s.writeMemory(rec('/wsA', 'k1', 'v1'));
      expect((await s.readMemory('/wsA', 'k1'))?.content).toBe('v1');
      await s.writeMemory(rec('/wsA', 'k1', 'v2', 2000));
      const r = await s.readMemory('/wsA', 'k1');
      expect(r?.content).toBe('v2');
      expect(r?.updatedAt).toBe(2000);
    });

    it('readMemory 不存在 → null', async () => {
      const s = make();
      expect(await s.readMemory('/wsA', 'nope')).toBeNull();
    });

    it('workspace 隔离：listMemory 只见本 workspace，按 key 字典序', async () => {
      const s = make();
      await s.writeMemory(rec('/wsA', 'b', 'A-b'));
      await s.writeMemory(rec('/wsA', 'a', 'A-a'));
      await s.writeMemory(rec('/wsB', 'a', 'B-a'));
      const listA = await s.listMemory('/wsA');
      expect(listA.map((r) => r.key)).toEqual(['a', 'b']); // 字典序稳定
      expect(listA.every((r) => r.workspacePath === '/wsA')).toBe(true);
      // wsB 的记忆在 wsA 不可见。
      expect(await s.readMemory('/wsA', 'a').then((r) => r?.content)).toBe('A-a');
      expect((await s.listMemory('/wsB')).map((r) => r.content)).toEqual(['B-a']);
    });

    it('deleteMemory 删除单条', async () => {
      const s = make();
      await s.writeMemory(rec('/wsA', 'k1', 'v1'));
      await s.deleteMemory('/wsA', 'k1');
      expect(await s.readMemory('/wsA', 'k1')).toBeNull();
    });
  });
}

contract('InMemoryMemoryStore', () => new InMemoryMemoryStore());

// node:sqlite 探针：不可用整组跳过（同 sqlite.test.ts 口径）。
const probe = (() => {
  try {
    SqliteMemoryStore.open(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

if (probe) {
  contract('SqliteMemoryStore', () => SqliteMemoryStore.open(':memory:'));

  describe('SqliteMemoryStore 持久化（resume 后可读回）', () => {
    it('落盘后重开同库可读回记忆', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'yo-mem-'));
      const dbPath = join(dir, 'mem.db');
      try {
        const s1 = SqliteMemoryStore.open(dbPath);
        await s1.writeMemory(rec('/ws', 'fact', '用户偏好中文'));
        s1.close();
        // 模拟跨进程 resume：重开同一文件。
        const s2 = SqliteMemoryStore.open(dbPath);
        const r = await s2.readMemory('/ws', 'fact');
        s2.close();
        expect(r?.content).toBe('用户偏好中文');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
} else {
  describe.skip('SqliteMemoryStore (node:sqlite 不可用)', () => {
    it('skipped', () => {});
  });
}
