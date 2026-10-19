// 密码哈希：argon2id，参数按 OWASP 建议（19 MiB 内存、2 次迭代、并行度 1），见 docs/SERVER_DESIGN.md 第 3.1 节。
// 用 Node 24 内置的 crypto.argon2，不引入原生依赖。存储为 PHC 字符串：
//   $argon2id$v=19$m=19456,t=2,p=1$<盐 base64>$<哈希 base64>
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { isWeakPassword } from './weakPasswords.ts';

export interface Argon2Params {
  /** 内存，KiB。 */
  memory: number;
  passes: number;
  parallelism: number;
}

export const DEFAULT_ARGON2_PARAMS: Readonly<Argon2Params> = Object.freeze({ memory: 19_456, passes: 2, parallelism: 1 });

const SALT_BYTES = 16;
const TAG_BYTES = 32;
/** 超长输入只会拖慢哈希，不增加安全性。 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const PHC_PATTERN = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(password: string, salt: Buffer, params: Argon2Params, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password, nonce: salt, parallelism: params.parallelism, tagLength, memory: params.memory, passes: params.passes },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

const b64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** 哈希格式不合法时返回 false，不抛错。 */
  verify(password: string, encoded: string): Promise<boolean>;
  /**
   * 用户不存在时调用：用与真实哈希相同参数的假哈希做一次完整校验，使响应时间与“密码错误”一致，
   * 避免按耗时区分邮箱是否存在。始终返回 false。
   */
  verifyDummy(password: string): Promise<false>;
}

export async function createPasswordHasher(params: Argon2Params = DEFAULT_ARGON2_PARAMS): Promise<PasswordHasher> {
  async function hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(password, salt, params, TAG_BYTES);
    return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(key)}`;
  }

  async function verify(password: string, encoded: string): Promise<boolean> {
    const match = PHC_PATTERN.exec(encoded);
    if (!match) return false;
    const [, memory, passes, parallelism, salt, expectedB64] = match;
    const expected = Buffer.from(expectedB64!, 'base64');
    if (expected.length < 16) return false;
    let actual: Buffer;
    try {
      actual = await derive(
        password,
        Buffer.from(salt!, 'base64'),
        { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) },
        expected.length,
      );
    } catch {
      return false;
    }
    return timingSafeEqual(actual, expected);
  }

  const dummy = await hash(randomBytes(32).toString('hex'));

  return {
    hash,
    verify,
    async verifyDummy(password) {
      await verify(password, dummy);
      return false;
    },
  };
}

export type PasswordProblem = 'too_short' | 'too_long' | 'weak' | 'contains_email';

/** 注册、重置、修改密码时的强度检查（第 3.1 节）：至少 10 位，不在常见弱口令表中，不包含邮箱用户名。 */
export function checkPasswordStrength(password: string, email?: string): PasswordProblem | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  if (isWeakPassword(password)) return 'weak';
  const localPart = email?.split('@', 1)[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && password.toLowerCase().includes(localPart)) return 'contains_email';
  return null;
}

export const PASSWORD_PROBLEM_MESSAGES: Readonly<Record<PasswordProblem, string>> = Object.freeze({
  too_short: `密码至少 ${PASSWORD_MIN_LENGTH} 位`,
  too_long: `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`,
  weak: '密码过于常见，请换一个',
  contains_email: '密码不能包含邮箱用户名',
});
