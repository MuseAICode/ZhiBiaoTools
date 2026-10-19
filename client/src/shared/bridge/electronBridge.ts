import type { PreloadBridge } from '../types/ipc';
import type { AppBridge } from './types';

/**
 * Electron 实现：直接返回 preload 通过 contextBridge 暴露的对象，只在类型上收窄为 AppBridge。
 * 不复制、不包一层函数，保证 getBridge() 与 window.appBridge 是同一个对象，调用行为完全一致。
 */
export function createElectronBridge(source: PreloadBridge): AppBridge {
  return source;
}
