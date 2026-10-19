// 计费账本（迁移 0003_billing、src/billing/ledger.ts）：计价精度、扣费幂等、并发扣费、余额不足、跨组织隔离、
// 账本与价格表不可修改、管理员充值 / 冲正 / 定价。
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addModelPrice,
  chargeUsage,
  creditOrganization,
  getBalance,
  MAX_MANUAL_CREDIT_UNITS,
  reverseLedgerEntry,
  type UsageCharge,
} from '../../src/billing/ledger.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const BILLING_TABLES = ['org_balances', 'billing_ledger', 'model_prices'] as const;

let testDb: TestDatabase;
let appDb: Kysely<Database>;
let superuser: Kysely<any>;

const orgA = randomUUID();
const orgB = randomUUID();
const orgPlatform = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const platformAdmin = randomUUID();
const disabledAdmin = randomUUID();
const ctxA: TenantContext = { orgId: orgA, userId: userA, role: 'owner' };
const ctxB: TenantContext = { orgId: orgB, userId: userB, role: 'owner' };
const ctxAdmin: TenantContext = { orgId: orgPlatform, userId: platformAdmin, role: 'owner' };
const ctxDisabledAdmin: TenantContext = { orgId: orgPlatform, userId: disabledAdmin, role: 'member' };

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

/** 平台默认价：deepseek-chat 输入 2 元 / 百万 token、输出 8 元 / 百万 token。 */
const DEEPSEEK_INPUT = 20_000n;
const DEEPSEEK_OUTPUT = 80_000n;
/** unit-model：每个输入 token 1 个计费单位，便于构造精确金额。 */
const UNIT_MODEL = 'unit-model';

let orgCounter = 0;

/** 新建一个独立组织（含 owner 成员），返回其上下文。 */
async function newOrg(): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  orgCounter += 1;
  await superuser.insertInto('organizations').values({ id: orgId, name: `组织 ${orgCounter}`, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `u${orgCounter}-${userId.slice(0, 8)}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, role: 'owner' };
}

async function credit(orgId: string, amount: bigint) {
  return creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount, reference: 'TEST-REF', note: '测试充值' });
}

function usage(overrides: Partial<UsageCharge> = {}): UsageCharge {
  return { requestId: randomUUID(), provider: 'deepseek', model: 'deepseek-chat', inputTokens: 1_000, outputTokens: 500, ...overrides };
}

/** 超级用户读取（绕过 RLS），用于核对。 */
async function ledgerOf(orgId: string) {
  return superuser.selectFrom('billing_ledger').selectAll().where('org_id', '=', orgId).orderBy('created_at').execute();
}

async function rawBalance(orgId: string): Promise<bigint> {
  const row = await superuser.selectFrom('org_balances').select('balance').where('org_id', '=', orgId).executeTakeFirst();
  return row ? BigInt(row.balance) : 0n;
}

/** 不变式：余额等于账本金额之和，且每一笔的 balance_after 都不为负。 */
async function expectInvariant(orgId: string) {
  const rows = await ledgerOf(orgId);
  const sum = rows.reduce((total, row) => total + BigInt(row.amount), 0n);
  expect(await rawBalance(orgId)).toBe(sum);
  for (const row of rows) expect(BigInt(row.balance_after) >= 0n).toBe(true);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;

  await superuser.insertInto('organizations').values([
    { id: orgA, name: '组织 A', kind: 'personal' },
    { id: orgB, name: '组织 B', kind: 'personal' },
    { id: orgPlatform, name: '平台', kind: 'personal' },
  ]).execute();
  await superuser.insertInto('users').values([
    { id: userA, email: 'a@example.com', password_hash: 'x' },
    { id: userB, email: 'b@example.com', password_hash: 'x' },
    { id: platformAdmin, email: 'admin@example.com', password_hash: 'x', is_platform_admin: true },
    { id: disabledAdmin, email: 'disabled-admin@example.com', password_hash: 'x', is_platform_admin: true, status: 'disabled' },
  ]).execute();
  await superuser.insertInto('org_memberships').values([
    { org_id: orgA, user_id: userA, role: 'owner' },
    { org_id: orgB, user_id: userB, role: 'owner' },
    { org_id: orgPlatform, user_id: platformAdmin, role: 'owner' },
    { org_id: orgPlatform, user_id: disabledAdmin, role: 'member' },
  ]).execute();

  // 价格由超级用户直接写入（录入时刻在过去），模拟已生效的历史版本。
  const past = daysAgo(30);
  await superuser.insertInto('model_prices').values([
    { provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: DEEPSEEK_INPUT.toString(), output_price_per_mtok: DEEPSEEK_OUTPUT.toString(), effective_from: past, created_at: past, created_by: platformAdmin },
    { provider: 'qwen', model: 'qwen-plus', input_price_per_mtok: '8000', output_price_per_mtok: '20000', effective_from: past, created_at: past, created_by: platformAdmin },
    { provider: 'deepseek', model: UNIT_MODEL, input_price_per_mtok: '1000000', output_price_per_mtok: '0', effective_from: past, created_at: past, created_by: platformAdmin },
    // 组织 A 的 qwen-plus 专属价，只对组织 A 生效。
    { org_id: orgA, provider: 'qwen', model: 'qwen-plus', input_price_per_mtok: '4000', output_price_per_mtok: '10000', effective_from: past, created_at: past, created_by: platformAdmin },
  ]).execute();

  appDb = connect<Database>(testDb.appConfig, 10);
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('金额精度', () => {
  async function amount(input: bigint, output: bigint, inputPrice: bigint, outputPrice: bigint): Promise<bigint> {
    const result = await sql<{ amount: string }>`
      SELECT billing_charge_amount(${input.toString()}::bigint, ${output.toString()}::bigint,
                                   ${inputPrice.toString()}::bigint, ${outputPrice.toString()}::bigint) AS amount`.execute(appDb);
    return BigInt(result.rows[0]!.amount);
  }

  /** 对照实现：整数向上取整除法。 */
  const exact = (input: bigint, output: bigint, inputPrice: bigint, outputPrice: bigint) => {
    const total = input * inputPrice + output * outputPrice;
    return (total + 999_999n) / 1_000_000n;
  };

  it.each<[string, bigint, bigint, bigint, bigint, bigint]>([
    ['零用量', 0n, 0n, 20_000n, 80_000n, 0n],
    ['不足 1 个计费单位向上取整', 1n, 0n, 1n, 0n, 1n],
    ['恰好整除不进位', 1_000_000n, 0n, 20_000n, 0n, 20_000n],
    ['输入输出合计后再取整', 1n, 1n, 400_000n, 600_000n, 1n],
    ['输入输出合计后再取整（进位）', 1n, 1n, 400_000n, 600_001n, 2n],
    ['免费模型', 123_456n, 654_321n, 0n, 0n, 0n],
  ])('%s', async (_name, input, output, inputPrice, outputPrice, expected) => {
    expect(await amount(input, output, inputPrice, outputPrice)).toBe(expected);
  });

  it('超过 2^53 的中间结果仍然精确（浮点会算错）', async () => {
    const args = [999_999_980n, 999_999_937n, 123_456_789_146n, 987_654_321_098n] as const;
    const expected = exact(...args);
    expect(await amount(...args)).toBe(expected);
    // 同样的计算用 number 会丢精度：证明这个用例确实覆盖了浮点误差。
    const asFloat = Math.ceil((Number(args[0]) * Number(args[2]) + Number(args[1]) * Number(args[3])) / 1_000_000);
    expect(BigInt(asFloat)).not.toBe(expected);
  });

  it('结果超出 bigint 时报错而不是截断', async () => {
    await expect(amount(1_000_000_000n, 0n, 9_223_372_036_854_775_807n, 0n)).rejects.toThrow(/out of range/);
  });

  it('计费相关的金额、单价、token 列都是 bigint，没有浮点或小数列', async () => {
    const result = await sql<{ table_name: string; column_name: string; data_type: string }>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('org_balances', 'billing_ledger', 'model_prices', 'usage_records')
        AND data_type IN ('real', 'double precision', 'numeric', 'money', 'integer', 'smallint', 'bigint')
      ORDER BY table_name, column_name`.execute(testDb.admin);
    expect(result.rows.every((row) => row.data_type === 'bigint')).toBe(true);
    expect(result.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      'billing_ledger.amount',
      'billing_ledger.balance_after',
      'billing_ledger.input_tokens',
      'billing_ledger.output_tokens',
      'model_prices.input_price_per_mtok',
      'model_prices.output_price_per_mtok',
      'model_prices.upstream_input_price_per_mtok',
      'model_prices.upstream_output_price_per_mtok',
      'org_balances.balance',
      'usage_records.amount',
      'usage_records.cached_input_tokens',
      'usage_records.estimated_input_tokens',
      'usage_records.hold_amount',
      'usage_records.input_tokens',
      'usage_records.max_output_tokens',
      'usage_records.output_tokens',
      'usage_records.upstream_cost',
    ]);
  });
});

describe('扣费', () => {
  it('按价格表扣费，记录请求编号、服务商、模型、token 数和价格版本', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 1_000_000n);
    const charge = usage({ inputTokens: 1_234_567, outputTokens: 89_013 });
    const result = await chargeUsage(appDb, ctx, charge);

    const expected = (1_234_567n * DEEPSEEK_INPUT + 89_013n * DEEPSEEK_OUTPUT + 999_999n) / 1_000_000n;
    expect(result).toMatchObject({ amount: expected, balanceAfter: 1_000_000n - expected, duplicate: false });
    expect(await getBalance(appDb, ctx)).toBe(1_000_000n - expected);

    const row = (await ledgerOf(ctx.orgId)).at(-1);
    expect(row).toMatchObject({
      id: result.entryId,
      entry_type: 'charge',
      amount: (-expected).toString(),
      request_id: charge.requestId,
      provider: 'deepseek',
      model: 'deepseek-chat',
      input_tokens: '1234567',
      output_tokens: '89013',
      price_id: result.priceId,
      operator_user_id: ctx.userId,
    });
    await expectInvariant(ctx.orgId);
  });

  it('从未入账的组织余额为 0', async () => {
    expect(await getBalance(appDb, await newOrg())).toBe(0n);
  });

  it('入参不合法时在发往数据库前拒绝', async () => {
    const ctx = await newOrg();
    for (const bad of [
      usage({ requestId: 'not-a-uuid' }),
      usage({ provider: 'openai' as UsageCharge['provider'] }),
      usage({ model: "x'; DROP TABLE billing_ledger; --" }),
      usage({ inputTokens: 1.5 }),
      usage({ outputTokens: -1 }),
      usage({ inputTokens: 1_000_000_001 }),
    ]) {
      await expect(chargeUsage(appDb, ctx, bad)).rejects.toThrow(TypeError);
    }
  });

  it('模型没有价格时拒绝，不入账', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 1_000n);
    await expect(chargeUsage(appDb, ctx, usage({ model: 'no-such-model' }))).rejects.toMatchObject({
      statusCode: 503,
      code: 'MODEL_PRICE_NOT_CONFIGURED',
    });
    expect(await ledgerOf(ctx.orgId)).toHaveLength(1);
  });
});

describe('幂等', () => {
  it('同一请求编号重复扣费只生效一次，重复提交返回首次的结果', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 100_000n);
    const charge = usage();
    const first = await chargeUsage(appDb, ctx, charge);
    const second = await chargeUsage(appDb, ctx, charge);
    const third = await chargeUsage(appDb, ctx, charge);

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ ...first, duplicate: true });
    expect(third).toEqual({ ...first, duplicate: true });
    expect(await getBalance(appDb, ctx)).toBe(100_000n - first.amount);
    expect((await ledgerOf(ctx.orgId)).filter((row) => row.entry_type === 'charge')).toHaveLength(1);
  });

  it('余额已不足时重放已入账的请求仍返回首次结果，而不是报余额不足', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 10n);
    const charge = usage({ model: UNIT_MODEL, inputTokens: 10, outputTokens: 0 });
    await chargeUsage(appDb, ctx, charge);
    expect(await getBalance(appDb, ctx)).toBe(0n);
    await expect(chargeUsage(appDb, ctx, charge)).resolves.toMatchObject({ duplicate: true, amount: 10n });
  });

  it('同一请求编号但用量不同时拒绝，不再扣费', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 100_000n);
    const charge = usage();
    await chargeUsage(appDb, ctx, charge);
    const balance = await getBalance(appDb, ctx);
    await expect(chargeUsage(appDb, ctx, { ...charge, outputTokens: charge.outputTokens + 1 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await getBalance(appDb, ctx)).toBe(balance);
  });

  it('并发提交同一请求编号：只入账一次', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 100_000n);
    const charge = usage();
    const results = await Promise.all(Array.from({ length: 10 }, () => chargeUsage(appDb, ctx, charge)));
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(new Set(results.map((result) => result.entryId)).size).toBe(1);
    expect((await ledgerOf(ctx.orgId)).filter((row) => row.entry_type === 'charge')).toHaveLength(1);
    expect(await getBalance(appDb, ctx)).toBe(100_000n - results[0]!.amount);
  });

  it('请求编号按组织隔离：不同组织使用同一编号互不影响', async () => {
    const one = await newOrg();
    const two = await newOrg();
    await credit(one.orgId, 100_000n);
    await credit(two.orgId, 100_000n);
    const charge = usage();
    expect((await chargeUsage(appDb, one, charge)).duplicate).toBe(false);
    expect((await chargeUsage(appDb, two, charge)).duplicate).toBe(false);
  });
});

describe('并发扣费与余额不足', () => {
  it('并发扣费不会扣成负数：余额恰好够 10 笔时 25 笔并发只成功 10 笔', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 100n);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 25 }, () => chargeUsage(appDb, ctx, usage({ model: UNIT_MODEL, inputTokens: 10, outputTokens: 0 }))),
    );
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(15);
    for (const outcome of rejected) expect(outcome.reason).toMatchObject({ statusCode: 402, code: 'INSUFFICIENT_BALANCE' });

    expect(await getBalance(appDb, ctx)).toBe(0n);
    const balances = fulfilled.map((outcome) => (outcome as PromiseFulfilledResult<{ balanceAfter: bigint }>).value.balanceAfter);
    expect(new Set(balances).size).toBe(10);
    await expectInvariant(ctx.orgId);
  });

  it('并发扣费与并发充值交错时不变式仍成立', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 50n);
    await Promise.allSettled([
      ...Array.from({ length: 20 }, () => chargeUsage(appDb, ctx, usage({ model: UNIT_MODEL, inputTokens: 7, outputTokens: 0 }))),
      ...Array.from({ length: 5 }, () => credit(ctx.orgId, 13n)),
    ]);
    expect(await rawBalance(ctx.orgId)).toBeGreaterThanOrEqual(0n);
    await expectInvariant(ctx.orgId);
  });

  it('余额不足时返回明确错误，不入账、余额不变', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 9n);
    await expect(chargeUsage(appDb, ctx, usage({ model: UNIT_MODEL, inputTokens: 10, outputTokens: 0 }))).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_BALANCE',
      message: '余额不足，请充值后再试',
    });
    expect(await getBalance(appDb, ctx)).toBe(9n);
    expect(await ledgerOf(ctx.orgId)).toHaveLength(1);
    // 恰好够时成功，余额归零。
    await expect(chargeUsage(appDb, ctx, usage({ model: UNIT_MODEL, inputTokens: 9, outputTokens: 0 }))).resolves.toMatchObject({
      balanceAfter: 0n,
    });
  });

  it('从未充值的组织不能产生费用', async () => {
    await expect(chargeUsage(appDb, await newOrg(), usage())).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('数据库约束兜底：余额列不能为负', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 1n);
    await expect(
      superuser.updateTable('org_balances').set({ balance: '-1' }).where('org_id', '=', ctx.orgId).execute(),
    ).rejects.toThrow(/org_balances_balance_check/);
  });
});

describe('跨组织隔离', () => {
  beforeAll(async () => {
    await credit(orgA, 1_000_000n);
    await credit(orgB, 1_000_000n);
    await chargeUsage(appDb, ctxA, usage());
    await chargeUsage(appDb, ctxB, usage());
  });

  it('只看到本组织的余额和账本', async () => {
    await withTenant(appDb, ctxA, async (trx) => {
      expect(await trx.selectFrom('org_balances').select('org_id').execute()).toEqual([{ org_id: orgA }]);
      const orgs = await trx.selectFrom('billing_ledger').select('org_id').distinct().execute();
      expect(orgs).toEqual([{ org_id: orgA }]);
      expect(await trx.selectFrom('billing_ledger').selectAll().where('org_id', '=', orgB).execute()).toEqual([]);
    });
  });

  it('不能给其他组织记账', async () => {
    await expect(
      withTenant(appDb, ctxA, (trx) =>
        trx.insertInto('billing_ledger').values({
          org_id: orgB, entry_type: 'charge', request_id: randomUUID(), provider: 'deepseek', model: 'deepseek-chat',
          input_tokens: 1, output_tokens: 1,
        }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('价格表：看得到平台默认价和本组织的专属价，看不到其他组织的专属价', async () => {
    const visible = (ctx: TenantContext) =>
      withTenant(appDb, ctx, (trx) => trx.selectFrom('model_prices').select(['org_id', 'model']).where('model', '=', 'qwen-plus').execute());
    expect(await visible(ctxA)).toEqual(expect.arrayContaining([{ org_id: null, model: 'qwen-plus' }, { org_id: orgA, model: 'qwen-plus' }]));
    expect(await visible(ctxB)).toEqual([{ org_id: null, model: 'qwen-plus' }]);
  });

  it('组织专属价只对该组织生效', async () => {
    const charge = { provider: 'qwen', model: 'qwen-plus', inputTokens: 1_000_000, outputTokens: 1_000_000 } as const;
    expect((await chargeUsage(appDb, ctxA, usage(charge))).amount).toBe(4_000n + 10_000n);
    expect((await chargeUsage(appDb, ctxB, usage(charge))).amount).toBe(8_000n + 20_000n);
  });

  it('未设置组织上下文时三张表都返回 0 行（含表属主）', async () => {
    const owner = connect<Database>(testDb.ownerConfig);
    try {
      for (const table of BILLING_TABLES) {
        for (const db of [appDb, owner]) {
          const row = await db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
          expect(Number(row.n), table).toBe(0);
        }
      }
    } finally {
      await owner.destroy();
    }
  });
});

describe('账本与价格表不可修改', () => {
  let entryId: string;
  beforeAll(async () => {
    const ctx = await newOrg();
    entryId = (await credit(ctx.orgId, 100n)).entryId;
  });

  it.each<[string, string]>([
    ['UPDATE 账本', 'UPDATE billing_ledger SET amount = 1'],
    ['DELETE 账本', 'DELETE FROM billing_ledger'],
    ['TRUNCATE 账本', 'TRUNCATE billing_ledger'],
    ['UPDATE 余额', 'UPDATE org_balances SET balance = 1000000'],
    ['INSERT 余额', `INSERT INTO org_balances (org_id, balance) VALUES ('${orgA}', 1)`],
    ['DELETE 余额', 'DELETE FROM org_balances'],
    ['UPDATE 价格', 'UPDATE model_prices SET input_price_per_mtok = 0'],
    ['DELETE 价格', 'DELETE FROM model_prices'],
    ['INSERT 价格', `INSERT INTO model_prices (provider, model, input_price_per_mtok, output_price_per_mtok, effective_from, created_by)
                    VALUES ('deepseek', 'x', 0, 0, now(), '${userA}')`],
  ])('应用角色没有权限：%s', async (_name, statement) => {
    await expect(withTenant(appDb, ctxA, (trx) => sql.raw(statement).execute(trx))).rejects.toThrow(/permission denied/);
  });

  it('应用角色不能直接充值、冲正或自定扣费金额', async () => {
    const base = { org_id: orgA, request_id: randomUUID(), provider: 'deepseek', model: 'deepseek-chat', input_tokens: 1, output_tokens: 1 } as const;
    // 应用角色写不了 amount 列，充值类记录必然缺金额，触发器先拒绝；即便绕过，RLS 也只允许插入扣费。
    await expect(
      withTenant(appDb, ctxA, (trx) => trx.insertInto('billing_ledger').values({ ...base, entry_type: 'recharge' as 'charge' }).execute()),
    ).rejects.toThrow(/amount is required|row-level security/);
    await expect(
      withTenant(appDb, ctxA, (trx) => sql`INSERT INTO billing_ledger (org_id, entry_type, amount, note, operator_user_id)
        VALUES (${orgA}, 'recharge', 100000, 'x', ${userA})`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(appDb, ctxA, (trx) => sql`INSERT INTO billing_ledger (org_id, entry_type, request_id, provider, model, input_tokens, output_tokens, amount)
        VALUES (${orgA}, 'charge', ${randomUUID()}, 'deepseek', 'deepseek-chat', 1, 1, 0)`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
  });

  it('应用角色不能调用内部函数', async () => {
    await expect(withTenant(appDb, ctxAdmin, (trx) => sql`SELECT billing_require_platform_admin()`.execute(trx))).rejects.toThrow(/permission denied/);
  });

  it.each(['UPDATE billing_ledger SET note = $$x$$', 'DELETE FROM billing_ledger', 'TRUNCATE billing_ledger CASCADE',
    'UPDATE model_prices SET note = $$x$$', 'DELETE FROM model_prices', 'TRUNCATE model_prices CASCADE'])(
    '表属主和超级用户也会被触发器拒绝：%s',
    async (statement) => {
      // 超级用户不受 RLS 约束，能看到全部行，所以这里拒绝的确实是触发器而不是“0 行”。
      await expect(sql.raw(statement).execute(superuser)).rejects.toThrow(/append-only/);
      const owner = connect(testDb.ownerConfig);
      try {
        // 属主受 RLS 约束、没有为它建策略，UPDATE / DELETE 影响 0 行；TRUNCATE 不经 RLS，由触发器拒绝。
        if (statement.startsWith('TRUNCATE')) await expect(sql.raw(statement).execute(owner)).rejects.toThrow(/append-only/);
        else await expect(sql.raw(statement).execute(owner)).resolves.toBeDefined();
      } finally {
        await owner.destroy();
      }
      const stillThere = await superuser.selectFrom('billing_ledger').select('id').where('id', '=', entryId).execute();
      expect(stillThere).toEqual([{ id: entryId }]);
    },
  );
});

describe('管理员充值', () => {
  it('记录操作人、类型、凭证号和备注', async () => {
    const ctx = await newOrg();
    const result = await creditOrganization(appDb, ctxAdmin, { orgId: ctx.orgId, type: 'grant', amount: 50_000n, reference: '  ', note: ' 试用赠送 ' });
    expect(result).toMatchObject({ orgId: ctx.orgId, amount: 50_000n, balanceAfter: 50_000n });
    expect((await ledgerOf(ctx.orgId))[0]).toMatchObject({
      id: result.entryId,
      entry_type: 'grant',
      amount: '50000',
      operator_user_id: platformAdmin,
      reference: null,
      note: '试用赠送',
    });
    expect(await getBalance(appDb, ctx)).toBe(50_000n);
  });

  it('非平台管理员、已停用的平台管理员不能充值', async () => {
    for (const ctx of [ctxA, ctxDisabledAdmin]) {
      await expect(creditOrganization(appDb, ctx, { orgId: orgB, type: 'recharge', amount: 100n, reference: null, note: 'x' }))
        .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    }
  });

  it('大额充值暂未开放：单笔上限以内成功，超过上限拒绝', async () => {
    const ctx = await newOrg();
    await expect(credit(ctx.orgId, MAX_MANUAL_CREDIT_UNITS)).resolves.toMatchObject({ balanceAfter: MAX_MANUAL_CREDIT_UNITS });
    await expect(credit(ctx.orgId, MAX_MANUAL_CREDIT_UNITS + 1n)).rejects.toMatchObject({ statusCode: 422, code: 'CREDIT_LIMIT_EXCEEDED' });
    expect(await getBalance(appDb, ctx)).toBe(MAX_MANUAL_CREDIT_UNITS);
  });

  it.each<[string, Partial<Parameters<typeof creditOrganization>[2]>, string]>([
    ['金额为 0', { amount: 0n }, 'BAD_REQUEST'],
    ['金额为负', { amount: -100n }, 'BAD_REQUEST'],
    ['备注为空', { note: '   ' }, 'BAD_REQUEST'],
    ['类型不合法', { type: 'charge' as 'recharge' }, 'BAD_REQUEST'],
    ['组织不存在', { orgId: randomUUID() }, 'ORGANIZATION_NOT_FOUND'],
  ])('拒绝：%s', async (_name, overrides, code) => {
    await expect(
      creditOrganization(appDb, ctxAdmin, { orgId: orgB, type: 'recharge', amount: 100n, reference: null, note: '充值', ...overrides }),
    ).rejects.toMatchObject({ code });
  });
});

describe('冲正', () => {
  it('冲正充值：新增一笔相反金额的记录并引用原记录，原记录不变，每笔只能冲正一次', async () => {
    const ctx = await newOrg();
    const original = await credit(ctx.orgId, 3_000n);
    const reversal = await reverseLedgerEntry(appDb, ctxAdmin, { entryId: original.entryId, note: '金额录错' });
    expect(reversal).toMatchObject({ orgId: ctx.orgId, amount: -3_000n, balanceAfter: 0n });

    const rows = await ledgerOf(ctx.orgId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: original.entryId, amount: '3000', balance_after: '3000' });
    expect(rows[1]).toMatchObject({ entry_type: 'reversal', related_entry_id: original.entryId, operator_user_id: platformAdmin, note: '金额录错' });

    await expect(reverseLedgerEntry(appDb, ctxAdmin, { entryId: original.entryId, note: '再来一次' })).rejects.toMatchObject({
      code: 'LEDGER_ENTRY_ALREADY_REVERSED',
    });
    await expect(reverseLedgerEntry(appDb, ctxAdmin, { entryId: reversal.entryId, note: '冲正冲正' })).rejects.toMatchObject({
      code: 'LEDGER_ENTRY_NOT_FOUND',
    });
    await expectInvariant(ctx.orgId);
  });

  it('冲正扣费：退回扣掉的金额', async () => {
    const ctx = await newOrg();
    await credit(ctx.orgId, 100n);
    const charge = await chargeUsage(appDb, ctx, usage({ model: UNIT_MODEL, inputTokens: 40, outputTokens: 0 }));
    await expect(reverseLedgerEntry(appDb, ctxAdmin, { entryId: charge.entryId, note: '上游故障退费' })).resolves.toMatchObject({
      amount: 40n,
      balanceAfter: 100n,
    });
  });

  it('充值已被花掉时冲正会使余额为负，拒绝', async () => {
    const ctx = await newOrg();
    const original = await credit(ctx.orgId, 100n);
    await chargeUsage(appDb, ctx, usage({ model: UNIT_MODEL, inputTokens: 60, outputTokens: 0 }));
    await expect(reverseLedgerEntry(appDb, ctxAdmin, { entryId: original.entryId, note: '录错' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    expect(await getBalance(appDb, ctx)).toBe(40n);
  });

  it('非平台管理员不能冲正；不存在的记录、空备注拒绝', async () => {
    const ctx = await newOrg();
    const original = await credit(ctx.orgId, 100n);
    await expect(reverseLedgerEntry(appDb, ctx, { entryId: original.entryId, note: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reverseLedgerEntry(appDb, ctxAdmin, { entryId: randomUUID(), note: 'x' })).rejects.toMatchObject({ code: 'LEDGER_ENTRY_NOT_FOUND' });
    await expect(reverseLedgerEntry(appDb, ctxAdmin, { entryId: original.entryId, note: ' ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('价格版本', () => {
  const newPrice = { orgId: null, provider: 'deepseek', model: 'versioned-model', note: null } as const;

  it('立即生效的新价格用于之后的扣费；未来生效的版本在生效前不影响扣费', async () => {
    const v1 = await addModelPrice(appDb, ctxAdmin, { ...newPrice, inputPricePerMtok: 1_000_000n, outputPricePerMtok: 0n, effectiveFrom: null });
    await addModelPrice(appDb, ctxAdmin, {
      ...newPrice, inputPricePerMtok: 5_000_000n, outputPricePerMtok: 0n, effectiveFrom: new Date(Date.now() + 7 * DAY_MS),
    });
    const ctx = await newOrg();
    await credit(ctx.orgId, 1_000n);
    const charge = await chargeUsage(appDb, ctx, usage({ model: 'versioned-model', inputTokens: 10, outputTokens: 0 }));
    expect(charge).toMatchObject({ priceId: v1.priceId, amount: 10n });
  });

  it('同一模型取生效时间最晚的已生效版本；历史扣费记录的价格版本和金额不变', async () => {
    const model = 'history-model';
    const [old] = await superuser.insertInto('model_prices').values({
      provider: 'qwen', model, input_price_per_mtok: '1000000', output_price_per_mtok: '0',
      effective_from: daysAgo(10), created_at: daysAgo(10), created_by: platformAdmin,
    }).returning('id').execute();
    const ctx = await newOrg();
    await credit(ctx.orgId, 1_000n);
    const before = await chargeUsage(appDb, ctx, usage({ provider: 'qwen', model, inputTokens: 10, outputTokens: 0 }));
    expect(before).toMatchObject({ priceId: old!.id, amount: 10n });

    const v2 = await addModelPrice(appDb, ctxAdmin, { orgId: null, provider: 'qwen', model, inputPricePerMtok: 3_000_000n, outputPricePerMtok: 0n, effectiveFrom: null, note: '涨价' });
    const after = await chargeUsage(appDb, ctx, usage({ provider: 'qwen', model, inputTokens: 10, outputTokens: 0 }));
    expect(after).toMatchObject({ priceId: v2.priceId, amount: 30n });

    const history = await superuser.selectFrom('billing_ledger').select(['price_id', 'amount']).where('id', '=', before.entryId).executeTakeFirstOrThrow();
    expect(history).toEqual({ price_id: old!.id, amount: '-10' });
  });

  it('不能新增生效时间在过去的版本（不能改写历史）', async () => {
    await expect(
      addModelPrice(appDb, ctxAdmin, { ...newPrice, inputPricePerMtok: 1n, outputPricePerMtok: 1n, effectiveFrom: daysAgo(1) }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'EFFECTIVE_FROM_IN_PAST' });
  });

  it('同一生效时间不能有两个版本', async () => {
    const effectiveFrom = new Date(Date.now() + 30 * DAY_MS);
    await addModelPrice(appDb, ctxAdmin, { ...newPrice, inputPricePerMtok: 1n, outputPricePerMtok: 1n, effectiveFrom });
    await expect(
      addModelPrice(appDb, ctxAdmin, { ...newPrice, inputPricePerMtok: 2n, outputPricePerMtok: 2n, effectiveFrom }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRICE_VERSION_EXISTS' });
  });

  it('只有平台管理员能新增价格；服务商只能是 deepseek、qwen', async () => {
    await expect(
      addModelPrice(appDb, ctxA, { ...newPrice, inputPricePerMtok: 1n, outputPricePerMtok: 1n, effectiveFrom: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      addModelPrice(appDb, ctxAdmin, { ...newPrice, provider: 'openai' as 'deepseek', inputPricePerMtok: 1n, outputPricePerMtok: 1n, effectiveFrom: null }),
    ).rejects.toThrow(/model_prices_provider_check/);
  });
});
