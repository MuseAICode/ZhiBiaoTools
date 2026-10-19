import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeNotImplementedError, detectBridgeKind, getBridge, type AppBridge } from '../../../src/shared/bridge';
import { createElectronBridge } from '../../../src/shared/bridge/electronBridge';
import { createWebBridge } from '../../../src/shared/bridge/webBridge';
import type { PreloadBridge } from '../../../src/shared/types/ipc';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectBridgeKind', () => {
  it('preload 注入了对象时选 Electron 实现', () => {
    expect(detectBridgeKind({})).toBe('electron');
  });

  it.each([undefined, null, '', 0, 'not-an-object'])('没有可用的 preload 对象（%j）时选 Web 实现', (value) => {
    expect(detectBridgeKind(value)).toBe('web');
  });
});

describe('getBridge', () => {
  it('Electron 下返回的就是 window.appBridge 本身，调用行为不变', () => {
    const load = vi.fn().mockResolvedValue({});
    const source = { config: { load } };
    vi.stubGlobal('window', { appBridge: source });

    const bridge = getBridge();
    expect(bridge).toBe(source);
    void bridge.config.load();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('每次调用都重新读取 window.appBridge，不缓存旧对象', () => {
    const first = {};
    const second = {};
    vi.stubGlobal('window', { appBridge: first });
    expect(getBridge()).toBe(first);
    vi.stubGlobal('window', { appBridge: second });
    expect(getBridge()).toBe(second);
  });

  it('浏览器中没有 window.appBridge 时返回 WebBridge，且只创建一次', () => {
    vi.stubGlobal('window', {});
    const bridge = getBridge();
    expect(bridge.platform).toBe('web');
    expect(getBridge()).toBe(bridge);
  });

  it('没有 window（Node 环境）时返回 WebBridge', () => {
    expect(typeof window).toBe('undefined');
    expect(getBridge().platform).toBe('web');
  });
});

describe('createElectronBridge', () => {
  it('不复制、不包装 preload 对象', () => {
    const source = {} as PreloadBridge;
    expect(createElectronBridge(source)).toBe(source);
  });
});

describe('WebBridge 空壳', () => {
  it('返回 Promise 的方法以 BridgeNotImplementedError 拒绝，并带上方法路径', async () => {
    const bridge = createWebBridge();
    await expect(bridge.config.load()).rejects.toBeInstanceOf(BridgeNotImplementedError);
    await expect(bridge.getVersion()).rejects.toMatchObject({ path: 'getVersion', message: 'WebBridge 尚未实现：getVersion' });
    await expect(bridge.knowledgeBase.search({} as never)).rejects.toMatchObject({ path: 'knowledgeBase.search' });
  });

  it('同步方法（事件订阅、getPathForFile）同步抛出', () => {
    const bridge = createWebBridge();
    expect(() => bridge.tasks.onTaskEvent(() => undefined)).toThrow(BridgeNotImplementedError);
    expect(() => bridge.ai.onHttpError(() => undefined)).toThrow('WebBridge 尚未实现：ai.onHttpError');
    expect(() => bridge.file.getPathForFile({} as File)).toThrow(BridgeNotImplementedError);
  });

  it('每个方法都明确报错，没有静默成功的', async () => {
    const paths: string[] = [];
    const visit = async (value: unknown, path: string) => {
      if (typeof value === 'function') {
        paths.push(path);
        let error: unknown;
        try {
          await value();
        } catch (caught) {
          error = caught;
        }
        expect(error, path).toBeInstanceOf(BridgeNotImplementedError);
        expect((error as BridgeNotImplementedError).path, path).toBe(path);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          await visit(child, path ? `${path}.${key}` : key);
        }
      }
    };
    await visit(createWebBridge(), '');
    expect(paths.length).toBeGreaterThan(150);
  });

  it('不包含已停用的更新、插件接口', () => {
    const bridge = createWebBridge() as unknown as Record<string, unknown>;
    for (const key of ['plugins', 'checkUpdate', 'startUpdate', 'quitAndInstall', 'getLatestVersion', 'getUpdateDownloadUrl', 'onUpdateProgress', 'onUpdateDownloaded', 'onUpdateError', 'onPluginUpdatesAvailable']) {
      expect(bridge, key).not.toHaveProperty(key);
    }
  });

  it('AppBridge 类型上也没有已停用接口', () => {
    const bridge = createWebBridge();
    // @ts-expect-error 插件接口已停用，不在 AppBridge 中
    expect(bridge.plugins).toBeUndefined();
    // @ts-expect-error 更新接口已停用，不在 AppBridge 中
    expect(bridge.checkUpdate).toBeUndefined();
    const typed: AppBridge = bridge;
    expect(typed).toBe(bridge);
  });
});
