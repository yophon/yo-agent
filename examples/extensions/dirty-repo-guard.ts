/**
 * dirty-repo-guard —— pi 官方示例等价物（参照 pi packages/coding-agent/examples/extensions/dirty-repo-guard.ts）。
 * 语义映射到 yo-agent 挂点：pi 拦 session 切换 → 这里经 onPreToolUse 拦 bash 的**破坏性 git 命令**：
 * 工作区有未提交改动时 deny（PreToolUse fail-closed，exec 出错也不放行破坏命令）。
 *
 * 用法：拷到 `~/.yo-agent/extensions/`（全局，默认信任）或 `<repo>/.yo-agent/extensions/`（项目，须信任门 opt-in）。
 */
import { defineExtension } from '@yo-agent/extension-host';

/** 会改写/丢弃工作区状态的 git 子命令（保守清单，只拦这些——普通 git status/log/diff 不受影响）。 */
const DESTRUCTIVE_GIT = /^git\s+(checkout|switch|reset|stash|rebase|merge|clean)\b/;

export default defineExtension((yo) => {
  yo.on({
    async onPreToolUse(ctx, p) {
      if (p.tool !== 'bash') return;
      const cmd = String((p.input as { command?: unknown } | null)?.command ?? '').trim();
      if (!DESTRUCTIVE_GIT.test(cmd)) return;
      // 查会话 cwd 的仓库（bash 工具也在 ctx.cwd 执行，与被拦命令同仓库）。
      const { output, exitCode } = await yo.exec('git status --porcelain', { cwd: ctx.cwd });
      if (exitCode !== 0) return; // 非 git repo → 放行
      const changed = output.trim().split('\n').filter(Boolean).length;
      if (changed === 0) return;
      return {
        decision: 'deny',
        reason: `工作区有 ${changed} 个未提交文件，先提交再执行「${cmd}」（dirty-repo-guard 扩展拦截）`,
      };
    },
  });
});
