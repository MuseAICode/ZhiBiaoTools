import type { PreloadBridge } from '../types/ipc';

/**
 * 已停用功能（更新、插件）在 preload 中遗留的接口。按路线图第 1 步前的决定第 5 项，
 * 它们不带进 AppBridge，Renderer 改用 getBridge() 后就无法再调用；接口本身在后续 PR 中删除。
 * 授权相关接口已在 旧仓库 PR #15 删除，这里没有需要排除的项。
 */
export type DisabledBridgeKey =
  | 'getLatestVersion'
  | 'getUpdateDownloadUrl'
  | 'checkUpdate'
  | 'startUpdate'
  | 'quitAndInstall'
  | 'onUpdateProgress'
  | 'onUpdateDownloaded'
  | 'onUpdateError'
  | 'onPluginUpdatesAvailable'
  | 'plugins';

/**
 * Renderer 访问 Main 进程（以后是服务端）的唯一端口。
 * 类型以 ipc.ts 的 PreloadBridge 为准，只去掉已停用的接口，避免两份定义各自演化。
 */
export type AppBridge = Omit<PreloadBridge, DisabledBridgeKey>;
