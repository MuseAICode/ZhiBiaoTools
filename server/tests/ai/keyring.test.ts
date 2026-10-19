// 主密钥与凭据加密（src/ai/keyring.ts、src/ai/credentials.ts）：包装 / 解包、AAD 绑定、错误不带密钥材料，
// 以及“只有 AI 网关解密”的代码约束。
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { credentialAad, normalizeBaseUrl, sealCredential, type CredentialBinding } from '../../src/ai/credentials.ts';
import { createFileKeyWrapper, KeyringError, loadFileKeyWrapper, parseKeyFile } from '../../src/ai/keyring.ts';

const KEY = randomBytes(32);
const API_KEY = 'sk-test-0123456789abcdef-XYZW';

function binding(overrides: Partial<CredentialBinding> = {}): CredentialBinding {
  return { id: randomUUID(), kind: 'text_model', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', ...overrides };
}

describe('主密钥文件', () => {
  it('只接受恰好 32 字节的 base64，首尾空白忽略', () => {
    expect(parseKeyFile(`${KEY.toString('base64')}\n`)).toEqual(KEY);
    expect(parseKeyFile(randomBytes(31).toString('base64'))).toBeUndefined();
    expect(parseKeyFile(randomBytes(33).toString('base64'))).toBeUndefined();
    expect(parseKeyFile(KEY.toString('hex'))).toBeUndefined();
    expect(parseKeyFile('')).toBeUndefined();
  });

  it('文件不合法或不可读时报错，错误信息不含文件内容', () => {
    const secret = 'not-a-key-but-secret-material';
    expect(() => loadFileKeyWrapper('/run/secrets/ai_kek', 1, () => secret)).toThrow(KeyringError);
    try {
      loadFileKeyWrapper('/run/secrets/ai_kek', 1, () => secret);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
    expect(() =>
      loadFileKeyWrapper('/missing', 1, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/无法读取/);
  });
});

describe('包装数据密钥', () => {
  const wrapper = createFileKeyWrapper(KEY, 1);
  const aad = Buffer.from('aad');

  it('包装后可以解包，每次包装结果不同（随机 IV）', () => {
    const dek = randomBytes(32);
    const first = wrapper.wrap(dek, aad);
    const second = wrapper.wrap(dek, aad);
    expect(first.equals(second)).toBe(false);
    expect(wrapper.unwrap(first, aad, 1)).toEqual(dek);
  });

  it('AAD、主密钥版本、主密钥或密文不符时解包失败，错误中不含密钥材料', () => {
    const dek = randomBytes(32);
    const wrapped = wrapper.wrap(dek, aad);
    const tampered = Buffer.from(wrapped);
    tampered[tampered.length - 1]! ^= 1;
    const other = createFileKeyWrapper(randomBytes(32), 1);
    for (const attempt of [
      () => wrapper.unwrap(wrapped, Buffer.from('other'), 1),
      () => wrapper.unwrap(wrapped, aad, 2),
      () => wrapper.unwrap(tampered, aad, 1),
      () => other.unwrap(wrapped, aad, 1),
    ]) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KeyringError);
      const text = `${(caught as Error).message} ${JSON.stringify(caught)}`;
      expect(text).not.toContain(KEY.toString('base64'));
      expect(text).not.toContain(dek.toString('hex'));
    }
  });
});

describe('凭据加密', () => {
  const wrapper = createFileKeyWrapper(KEY, 3);

  it('密文和包装后的数据密钥中都没有明文 Key，只保留末尾 4 位', () => {
    const sealed = sealCredential(wrapper, binding(), API_KEY);
    expect(sealed.last4).toBe('XYZW');
    expect(sealed.kekVersion).toBe(3);
    for (const field of [sealed.ciphertext, sealed.wrappedDek, sealed.iv, sealed.authTag]) {
      expect(field.includes(Buffer.from(API_KEY))).toBe(false);
      expect(field.includes(Buffer.from('0123456789abcdef'))).toBe(false);
    }
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
  });

  it('AAD 绑定 id、类型、服务商和 Base URL，任何一项改动都得到不同的 AAD', () => {
    const base = binding();
    const aad = credentialAad(base);
    for (const change of [{ id: randomUUID() }, { provider: 'qwen' as const }, { baseUrl: 'https://api.deepseek.com/v1' }]) {
      expect(credentialAad({ ...base, ...change }).equals(aad)).toBe(false);
    }
    // JSON 编码：字段中含分隔符时也不会和另一组字段编码相同。
    expect(credentialAad({ ...base, baseUrl: 'https://a|b' }).equals(credentialAad({ ...base, baseUrl: 'https://a' }))).toBe(false);
  });
});

describe('Base URL', () => {
  it.each([
    ['https://api.deepseek.com', 'https://api.deepseek.com'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1/', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['HTTPS://API.DeepSeek.com:443/v1', 'https://api.deepseek.com/v1'],
  ])('%s 规范化为 %s', (raw, expected) => {
    expect(normalizeBaseUrl(raw, [])).toBe(expected);
  });

  it.each([
    'http://api.deepseek.com',
    'https://user:pw@api.deepseek.com',
    'https://api.deepseek.com/?x=1',
    'https://api.deepseek.com/#frag',
    'ftp://api.deepseek.com',
    'file:///etc/passwd',
    'not a url',
    `https://example.com/${'a'.repeat(500)}`,
  ])('拒绝 %s', (raw) => {
    expect(normalizeBaseUrl(raw, [])).toBeUndefined();
  });

  it('http 只允许 AI_UPSTREAM_PRIVATE_HOSTS 中的主机', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8080/v1', ['127.0.0.1'])).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:8080/v1', [])).toBeUndefined();
    expect(normalizeBaseUrl('http://10.0.0.1/v1', ['127.0.0.1'])).toBeUndefined();
  });
});

describe('只有 AI 网关解密', () => {
  const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );
  }

  it('createDecipheriv 只出现在主密钥模块和 AI 网关中，解包数据密钥只有网关调用', () => {
    const decipher: string[] = [];
    const unwrap: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const text = readFileSync(file, 'utf8');
      const name = relative(srcRoot, file).replaceAll('\\', '/');
      if (text.includes('createDecipheriv')) decipher.push(name);
      if (/\.unwrap\(/.test(text)) unwrap.push(name);
    }
    expect(decipher.sort()).toEqual(['ai/gateway.ts', 'ai/keyring.ts']);
    expect(unwrap).toEqual(['ai/gateway.ts']);
  });

  it('解密函数不导出', () => {
    const text = readFileSync(join(srcRoot, 'ai/gateway.ts'), 'utf8');
    expect(text).toMatch(/^function openCredential\(/m);
    expect(text).not.toMatch(/export[^\n]*openCredential/);
  });
});
