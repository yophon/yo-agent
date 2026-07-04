/**
 * queue-and-nudge —— 行动面示例：followUp（排队 follow-up）+ steer（运行中插话）+ onEvent（事件观测）。
 * /queue <文本>：当前 turn 以 end_turn 正常完成后自动提交（interrupted/failed 保留队列）；
 * /nudge <文本>：向**运行中**的 turn 插话（空闲时调用由内核语义决定行为）。
 */
import { defineExtension } from '@yo-agent/extension-host';

export default defineExtension((yo) => {
  yo.registerCommand({
    name: 'queue',
    desc: '排队一条 follow-up（turn 正常完成后自动发送）',
    run: async (ctx, args) => {
      const text = args.trim();
      if (!text) {
        ctx.notice('用法：/queue <要排队的输入>');
        return;
      }
      yo.followUp(ctx.sessionId, text);
      ctx.notice(`已排队（end_turn 后自动发送）：${text}`);
    },
  });
  yo.registerCommand({
    name: 'nudge',
    desc: '向运行中的 turn 插话（steer）',
    run: async (ctx, args) => {
      const text = args.trim();
      if (!text) {
        ctx.notice('用法：/nudge <插话内容>');
        return;
      }
      await yo.steer(ctx.sessionId, text);
      ctx.notice(`已插话：${text}`);
    },
  });
  // 事件观测：turn 完成时出一条运行日志（stderr，演示 onEvent 面）。
  yo.onEvent((env) => {
    if (env.event.kind === 'TurnCompleted') yo.log(`turn 完成（${env.event.stopReason}）`);
  });
});
