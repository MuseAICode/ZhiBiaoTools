// 平台凭据的加密存储（docs/SERVER_DESIGN.md 第 4.2~4.4 节）：每条凭据一个随机 256 位数据密钥（DEK），
// 用 AES-256-GCM 加密 API Key，DEK 再由主密钥（KEK，src/ai/keyring.ts）包装。数据库里只有密文和包装后的 DEK。
//
// 本模块只加密、不解密：解密只在 AI 网关（src/ai/gateway.ts）中进行，明文只存在于发请求的局部变量里。
// 任何接口都不返回明文，管理员接口只返回 credentialStatus（是否已配置、末尾 4 位）。
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { toBillingError } from '../billing/ledger.ts';
import type { BillingProvider, CredentialKind, Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import type { KeyWrapper } from './keyring.ts';

export const BASE_URL_MAX_LENGTH = 500;
/** API Key：可见 ASCII，不含空白（也就不可能注入请求头）。 */
export const API_KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

export interface CredentialBinding {
  id: string;
  kind: CredentialKind;
  provider: BillingProvider;
  baseUrl: string;
}

export interface SealedCredential {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  kekVersion: number;
  last4: string;
}

export interface CredentialStatus {
  provider: BillingProvider;
  kind: CredentialKind;
  baseUrl: string;
  configured: true;
  last4: string;
  kekVersion: number;
  createdAt: Date;
}

/**
 * AAD 绑定 id、类型、服务商和 Base URL：把一行密文复制到另一行、或换掉 Base URL，解密都会失败，
 * “Base URL 改动后不沿用已保存的 Key”因此在密码学上也成立（第 4.4 节）。用 JSON 数组编码，字段之间没有歧义。
 */
export function credentialAad(binding: CredentialBinding): Buffer {
  return Buffer.from(JSON.stringify(['provider_credentials', binding.id, binding.kind, binding.provider, binding.baseUrl]), 'utf8');
}

/**
 * 规范化并校验 Base URL：只允许 https，用户信息、查询串和片段一律拒绝，去掉末尾的 /。
 * privateHosts（AI_UPSTREAM_PRIVATE_HOSTS）中的主机可以用 http；其他主机写成 IP 字面量时，
 * 私有、回环等地址在连接时会被拒绝（src/ai/upstream.ts），这里只做格式检查。
 */
export function normalizeBaseUrl(raw: string, privateHosts: readonly string[]): string | undefined {
  if (raw.length > BASE_URL_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const insecureAllowed = privateHosts.includes(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecureAllowed)) return undefined;
  if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#')) return undefined;
  if (!host) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** 加密一条凭据：随机 DEK 加密 API Key，DEK 交给主密钥包装后立即清零。 */
export function sealCredential(wrapper: KeyWrapper, binding: CredentialBinding, apiKey: string): SealedCredential {
  const aad = credentialAad(binding);
  const dek = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    return {
      ciphertext,
      iv,
      authTag: cipher.getAuthTag(),
      wrappedDek: wrapper.wrap(dek, aad),
      kekVersion: wrapper.version,
      last4: apiKey.slice(-4),
    };
  } finally {
    dek.fill(0);
  }
}

export interface PutCredentialInput {
  /** 凭据种类：文本模型（默认）或生图（迁移 0045）。 */
  kind?: CredentialKind;
  provider: BillingProvider;
  /** 已经过 normalizeBaseUrl。 */
  baseUrl: string;
  apiKey: string;
}

/**
 * 平台管理员写入（替换）某个服务商的凭据。每次都生成新的 id 并重新加密，所以修改 Base URL 必须同时重新填写 Key。
 * 是否平台管理员由数据库函数校验，操作人取 context.userId。
 */
export async function putCredential(
  db: Kysely<Database>,
  context: TenantContext,
  wrapper: KeyWrapper,
  input: PutCredentialInput,
): Promise<CredentialStatus> {
  if (!API_KEY_PATTERN.test(input.apiKey)) throw new TypeError('API Key 格式不合法');
  const binding: CredentialBinding = { id: randomUUID(), kind: input.kind ?? 'text_model', provider: input.provider, baseUrl: input.baseUrl };
  const sealed = sealCredential(wrapper, binding, input.apiKey);
  try {
    return await withTenant(db, context, async (trx) => {
      const result = await sql<{ credential_id: string; created_at: Date }>`
        SELECT credential_id, created_at FROM ai_admin_put_credential(
          ${binding.id}::uuid, ${binding.kind}, ${binding.provider}, ${binding.baseUrl},
          ${sealed.ciphertext}, ${sealed.iv}, ${sealed.authTag}, ${sealed.wrappedDek}, ${sealed.kekVersion}::integer, ${sealed.last4})`.execute(trx);
      const row = result.rows[0]!;
      return {
        provider: binding.provider,
        kind: binding.kind,
        baseUrl: binding.baseUrl,
        configured: true,
        last4: sealed.last4,
        kekVersion: sealed.kekVersion,
        createdAt: row.created_at,
      };
    });
  } catch (error) {
    throw toBillingError(error);
  }
}

/** 平台凭据的状态（不含密文）；平台管理员接口使用。 */
export async function listCredentialStatus(db: Kysely<Database>, context: TenantContext): Promise<CredentialStatus[]> {
  const rows = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('provider_credentials')
      .select(['provider', 'kind', 'base_url', 'last4', 'kek_version', 'created_at'])
      .orderBy('provider')
      .orderBy('kind')
      .execute(),
  );
  return rows.map((row) => ({
    provider: row.provider,
    kind: row.kind,
    baseUrl: row.base_url,
    configured: true,
    last4: row.last4,
    kekVersion: row.kek_version,
    createdAt: row.created_at,
  }));
}
