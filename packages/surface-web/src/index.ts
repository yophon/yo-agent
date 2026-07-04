/**
 * @yo-agent/surface-web —— 浏览器内嵌 surface（Phase 5）。
 * 内核就在页面里跑：createWebAgent 装配（全走 5A core 浏览器安全面）+ defineHttpTool
 * 把后端业务 API 声明成工具 + ChatController 把事件流归约成 UI 无关聊天状态。
 * 本包自身零 Node 依赖——check:browser 以此为真入口打包冒烟。
 */
export * from './config';
export * from './agent';
export * from './http-tool';
