import { describe, expect, it } from 'vitest';
import { checkPasswordStrength, createPasswordHasher, DEFAULT_ARGON2_PARAMS } from '../../src/auth/password.ts';
import { isWeakPassword } from '../../src/auth/weakPasswords.ts';

describe('argon2id 密码哈希（真实参数）', () => {
  it('输出 PHC 字符串，参数为 m=19456,t=2,p=1，盐随机', async () => {
    const hasher = await createPasswordHasher();
    const a = await hasher.hash('correct horse battery');
    const b = await hasher.hash('correct horse battery');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(a).not.toBe(b);
    expect(DEFAULT_ARGON2_PARAMS).toEqual({ memory: 19_456, passes: 2, parallelism: 1 });
  });

  it('正确密码通过，错误密码、格式不合法的哈希不通过', async () => {
    const hasher = await createPasswordHasher();
    const hash = await hasher.hash('correct horse battery');
    expect(await hasher.verify('correct horse battery', hash)).toBe(true);
    expect(await hasher.verify('correct horse batterz', hash)).toBe(false);
    expect(await hasher.verify('correct horse battery', 'x')).toBe(false);
    expect(await hasher.verify('correct horse battery', hash.replace('argon2id', 'argon2i'))).toBe(false);
    expect(await hasher.verify('correct horse battery', `${hash.slice(0, -10)}`)).toBe(false);
  });

  it('不存在的用户走假哈希校验：总是失败，耗时与真实校验同一量级', async () => {
    const hasher = await createPasswordHasher();
    const hash = await hasher.hash('correct horse battery');
    expect(await hasher.verifyDummy('correct horse battery')).toBe(false);

    async function median(fn: () => Promise<unknown>) {
      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const start = performance.now();
        await fn();
        samples.push(performance.now() - start);
      }
      return samples.sort((x, y) => x - y)[2]!;
    }
    const real = await median(() => hasher.verify('wrong password here', hash));
    const dummy = await median(() => hasher.verifyDummy('wrong password here'));
    // 假哈希与真实哈希参数相同，耗时由 argon2 决定；宽松的比例只用来发现“跳过了哈希”这类回归。
    expect(dummy / real).toBeGreaterThan(0.5);
    expect(dummy / real).toBeLessThan(2);
  });
});

describe('密码强度', () => {
  it.each([
    ['short', 'too_short'],
    ['123456789', 'too_short'],
    ['x'.repeat(129), 'too_long'],
    ['1234567890', 'weak'],
    ['Password123', 'weak'],
    ['qwertyuiop', 'weak'],
    ['aaaaaaaaaaaa', 'weak'],
    ['abcdefghijk', 'weak'],
  ])('%s → %s', (password, problem) => {
    expect(checkPasswordStrength(password)).toBe(problem);
  });

  it('不能包含邮箱用户名', () => {
    expect(checkPasswordStrength('Zhangsan-2026!', 'zhangsan@example.com')).toBe('contains_email');
    expect(checkPasswordStrength('Zhangsan-2026!', 'li@example.com')).toBeNull();
  });

  it('按字符而不是 UTF-16 码元计长度', () => {
    expect(checkPasswordStrength('标书工具密码很安全的')).toBeNull();
    expect(checkPasswordStrength('😀😀😀😀😀')).toBe('too_short');
  });

  it('合格的密码通过', () => {
    expect(checkPasswordStrength('tidy-orbit-lantern-42')).toBeNull();
    expect(isWeakPassword('tidy-orbit-lantern-42')).toBe(false);
  });
});
