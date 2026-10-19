import rawRemoteServices from '../../electron/resources/remote-services.json';

// 在线服务地址在构建时从 electron/resources/remote-services.json 读入，默认全部为空：
// 为空的服务不发任何请求，对应入口隐藏。
export interface RemoteServices {
  /** 使用文档地址。 */
  userGuideUrl: string;
}

const remoteServiceKeys: Array<keyof RemoteServices> = ['userGuideUrl'];

// 只接受 https 地址，去掉末尾斜杠；其余一律按未配置处理。
function normalizeServiceUrl(value: unknown) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    return new URL(text).protocol === 'https:' ? text : '';
  } catch {
    return '';
  }
}

export const remoteServices = Object.fromEntries(
  remoteServiceKeys.map((key) => [key, normalizeServiceUrl((rawRemoteServices as Partial<RemoteServices>)[key])]),
) as unknown as RemoteServices;
