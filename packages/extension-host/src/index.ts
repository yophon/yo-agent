/**
 * @yo-agent/extension-host —— 进程内可信扩展档（5.2b）。
 * 作者面：defineExtension / ExtensionApi（sdk）；宿主面：discoverExtensions + 信任门（loader）
 * + ExtensionHost（host）。与 plugin-host（跨进程不可信档）分层并列。
 */
export * from './sdk';
export * from './loader';
export * from './host';
