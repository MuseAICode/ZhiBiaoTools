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

    const timed = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };
    // 真实校验与假校验交替执行、逐对计算耗时比，取中位数：机器负载的波动同时影响一对中的两次，不会只偏向一边
    // （先连续测完一种再测另一种时，负载高峰只落在其中一组，比例会偏离）。先各跑一次预热。
    await hasher.verify('wrong password here', hash);
    await hasher.verifyDummy('wrong password here');
    const ratios: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const real = await timed(() => hasher.verify('wrong password here', hash));
      const dummy = await timed(() => hasher.verifyDummy('wrong password here'));
      ratios.push(dummy / real);
    }
    const ratio = ratios.sort((x, y) => x - y)[4]!;
    // 假哈希与真实哈希参数相同，耗时由 argon2 决定，比例应接近 1；宽松的范围只用来发现“跳过了哈希”（比例接近 0）
    // 或“多做了几次哈希”这类回归。
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(4);
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
