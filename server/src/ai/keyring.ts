// 主密钥（KEK）：包装每条平台凭据的数据密钥（DEK），docs/SERVER_DESIGN.md 第 4.2 节。
//
// 开发环境和 CI 用本地密钥文件（32 字节随机数的 base64，server/scripts/init-dev-secrets.sh 生成）；
// 生产环境换成云 KMS 的实现，接口不变。主密钥只保存在本模块闭包里的 Buffer 中，不进入配置对象、日志和数据库。
//
// 包装格式：iv（12 字节）| auth_tag（16 字节）| 密文，AES-256-GCM，AAD 与凭据密文相同（绑定凭据的 id、类型、服务商、Base URL）。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KeyWrapper {
  /** 主密钥版本，写入 provider_credentials.kek_version。 */
  readonly version: number;
  wrap(dek: Buffer, aad: Buffer): Buffer;
  /** 只有 AI 网关（src/ai/gateway.ts）调用。版本或 AAD 不符、密文被改动时抛错，错误中不含密钥材料。 */
  unwrap(wrapped: Buffer, aad: Buffer, version: number): Buffer;
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

/** 解析密钥文件内容：去掉首尾空白后必须是恰好 32 字节的标准 base64。不合法时返回 undefined，不回显内容。 */
export function parseKeyFile(content: string): Buffer | undefined {
  const text = content.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return undefined;
  const key = Buffer.from(text, 'base64');
  return key.length === KEY_BYTES ? key : undefined;
}

export function createFileKeyWrapper(key: Buffer, version: number): KeyWrapper {
  if (key.length !== KEY_BYTES) throw new KeyringError('主密钥长度不正确');
  if (!Number.isSafeInteger(version) || version < 1) throw new KeyringError('主密钥版本不合法');
  const kek = Buffer.from(key);
  return Object.freeze({
    version,
    wrap(dek: Buffer, aad: Buffer): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', kek, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    unwrap(wrapped: Buffer, aad: Buffer, wrappedVersion: number): Buffer {
      if (wrappedVersion !== version) throw new KeyringError('数据密钥由其他版本的主密钥包装');
      if (wrapped.length <= IV_BYTES + TAG_BYTES) throw new KeyringError('数据密钥格式不正确');
      try {
        const decipher = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, IV_BYTES));
        decipher.setAAD(aad);
        decipher.setAuthTag(wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
      } catch {
        throw new KeyringError('数据密钥解包失败');
      }
    },
  });
}

/** 从文件加载主密钥。失败时抛 KeyringError，信息中只有原因，不含路径以外的内容。 */
export function loadFileKeyWrapper(path: string, version: number, readFile: (path: string) => string = (file) => readFileSync(file, 'utf8')): KeyWrapper {
  let content: string;
  try {
    content = readFile(path);
  } catch {
    throw new KeyringError('AI_KEK_FILE 指向的文件无法读取');
  }
  const key = parseKeyFile(content);
  if (!key) throw new KeyringError('AI_KEK_FILE 的内容应为 32 字节随机数的 base64（openssl rand -base64 32）');
  const wrapper = createFileKeyWrapper(key, version);
  key.fill(0);
  return wrapper;
}
