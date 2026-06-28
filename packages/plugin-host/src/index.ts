/**
 * @yo-agent/plugin-host —— 插件 SDK + Worker IPC 隔离（4E / ADR-18）。
 * 第三方插件（不可信代码）跑在独立 Worker，经结构化 IPC + 心跳重连与主进程通信；
 * 崩溃不拖垮主进程（退出标准③）、读不到主进程 secret、工具走主审批流不可绕。
 */
export * from './protocol';
export * from './transport';
export * from './host';
export * from './loader';
export * from './sdk';
