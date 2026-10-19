import type { YibiaoBridge } from '../types/ipc';
import { createElectronBridge } from './electronBridge';
import type { AppBridge } from './types';
import { createWebBridge } from './webBridge';

export type { AppBridge, DisabledBridgeKey } from './types';
export { BridgeNotImplementedError } from './webBridge';

export type BridgeKind = 'electron' | 'web';

/** preload 注入的对象存在时用 Electron 实现，否则用 Web 实现。 */
export function detectBridgeKind(electronSource: unknown): BridgeKind {
  return typeof electronSource === 'object' && electronSource !== null ? 'electron' : 'web';
}

let webBridge: AppBridge | null = null;

/**
 * Renderer 获取 bridge 的唯一入口。每次调用都重新读取 window.yibiao，不缓存 Electron 实现，
 * 所以返回值始终与 window.yibiao 是同一个对象；Web 实现只创建一次。
 */
export function getBridge(): AppBridge {
  const electronSource = typeof window === 'undefined' ? undefined : (window as { yibiao?: unknown }).yibiao;
  if (detectBridgeKind(electronSource) === 'electron') {
    return createElectronBridge(electronSource as YibiaoBridge);
  }
  webBridge ??= createWebBridge();
  return webBridge;
}
