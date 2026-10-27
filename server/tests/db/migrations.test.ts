import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../src/db/migrations/index.ts';
import { migrateDown, migrateDownAll, migrateToLatest } from '../../src/db/migrator.ts';
import { OWNER_ROLE } from '../../src/db/roles.ts';
import { SYSTEM_EXPORT_TEMPLATES } from '../../src/templates/systemTemplates.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const APPLICATION_TABLES = [
  'artifacts',
  'auth_tokens',
  'billing_ledger',
  'credential_library_certificates',
  'credential_library_employees',
  'credential_library_images',
  'credential_library_other_materials',
  'credential_library_profile',
  'credential_library_projects',
  'duplicate_check_analysis_sections',
  'duplicate_check_content_duplicates',
  'duplicate_check_content_files',
  'duplicate_check_content_occurrences',
  'duplicate_check_duplicate_images',
  'duplicate_check_files',
  'duplicate_check_image_files',
  'duplicate_check_image_occurrences',
  'duplicate_check_meta',
  'duplicate_check_metadata_items',
  'duplicate_check_outline_groups',
  'duplicate_check_outline_items',
  'duplicate_check_outline_pairwise',
  'export_templates',
  'feasibility_report_meta',
  'feasibility_report_outline_nodes',
  'feasibility_report_reference_docs',
  'feasibility_report_sources',
  'files',
  'invitations',
  'job_events',
  'jobs',
  'knowledge_blocks',
  'knowledge_candidate_items',
  'knowledge_discarded_groups',
  'knowledge_document_steps',
  'knowledge_documents',
  'knowledge_folders',
  'knowledge_item_blocks',
  'knowledge_items',
  'knowledge_match_batches',
  'knowledge_reports',
  'model_prices',
  'org_balances',
  'org_memberships',
  'org_settings',
  'organizations',
  'platform_models',
  'projects',
  'provider_credentials',
  'rejection_check_documents',
  'rejection_check_extraction',
  'rejection_check_logic_findings',
  'rejection_check_meta',
  'rejection_check_results',
  'rejection_check_risk_findings',
  'rejection_check_typo_findings',
  'sessions',
  'technical_plan_bid_items',
  'technical_plan_content_plans',
  'technical_plan_content_sections',
  'technical_plan_documents',
  'technical_plan_generation_bid_tasks',
  'technical_plan_generation_config',
  'technical_plan_generation_reference_docs',
  'technical_plan_global_fact_groups',
  'technical_plan_meta',
  'technical_plan_outline_nodes',
  'usage_records',
  'user_settings',
  'users',
];
const APP_FUNCTIONS = [
  'ai_admin_put_credential',
  'ai_admin_register_model',
  'ai_admin_set_model_enabled',
  'ai_model_check',
  'ai_model_price',
  'ai_platform_model_guard_update',
  'ai_usage_begin',
  'ai_usage_expire_holds',
  'ai_usage_fail',
  'ai_usage_guard_update',
  'ai_usage_settle',
  'app_current_org_id',
  'app_current_user_id',
  'app_touch_updated_at',
  'artifacts_guard',
  'auth_consume_invitation',
  'auth_issue_password_reset',
  'auth_login_lookup',
  'auth_reset_password',
  'auth_revoke_my_sessions',
  'auth_session_lookup',
  'billing_active_holds',
  // 0003 的 7 参数版本和 0004 带上游成本单价的 9 参数版本。
  'billing_admin_add_price',
  'billing_admin_add_price',
  'billing_admin_credit',
  'billing_admin_reverse',
  'billing_charge_amount',
  'billing_job_start_check',
  'billing_ledger_apply',
  'billing_reject_change',
  'billing_require_platform_admin',
  'billing_upstream_cost',
  'credential_library_guard',
  'export_templates_guard',
  'files_guard',
  'files_org_usage_bytes',
  'files_project_guard',
  'jobs_dispatch_candidates',
  'jobs_guard',
  'knowledge_base_guard',
  'org_settings_guard',
  'projects_guard',
];

let testDb: TestDatabase;
let owner: Kysely<unknown>;

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = connect(testDb.ownerConfig);
});

afterAll(async () => {
  await owner?.destroy();
  await testDb?.drop();
});

async function publicTables(): Promise<string[]> {
  const result = await sql<{ relname: string }>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`.execute(testDb.admin);
  return result.rows.map((row) => row.relname);
}

/** 业务表（迁移工具自己的表除外）。 */
async function applicationTables(): Promise<string[]> {
  return (await publicTables()).filter((name) => !name.startsWith('kysely_'));
}

async function appFunctions(): Promise<string[]> {
  const result = await sql<{ proname: string }>`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' ORDER BY p.proname`.execute(testDb.admin);
  return result.rows.map((row) => row.proname);
}

function expectSuccess(resultSet: Awaited<ReturnType<typeof migrateToLatest>>) {
  expect(resultSet.error).toBeUndefined();
  for (const result of resultSet.results ?? []) expect(result.status).toBe('Success');
  return (resultSet.results ?? []).map((result) => `${result.direction}:${result.migrationName}`);
}

describe('迁移升级与回滚', () => {
  it('空库迁移到最新：建出身份、租户与计费表，属主为迁移角色', async () => {
    expect(expectSuccess(await migrateToLatest(owner))).toEqual(Object.keys(migrations).map((name) => `Up:${name}`));
    expect(await applicationTables()).toEqual(APPLICATION_TABLES);
    expect(await appFunctions()).toEqual(APP_FUNCTIONS);

    const owners = await sql<{ owner: string }>`
      SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`.execute(testDb.admin);
    expect(owners.rows).toEqual([{ owner: OWNER_ROLE }]);
  });

  it('重复执行是空操作', async () => {
    expect(expectSuccess(await migrateToLatest(owner))).toEqual([]);
    expect(await applicationTables()).toEqual(APPLICATION_TABLES);
  });

  it('每张业务表都启用并强制 RLS，且至少有一条策略', async () => {
    // 防止以后新增的表漏开 RLS，或策略被误删（docs/SERVER_DESIGN.md 第 2.6 节）。
    const result = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'kysely\\_%'
      ORDER BY c.relname`.execute(testDb.admin);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      expect(row.policies, row.relname).toBeGreaterThan(0);
    }
  });

  it('逐个回滚到空库，再次升级仍然成功', async () => {
    const names = Object.keys(migrations);
    for (const name of [...names].reverse()) {
      expect(expectSuccess(await migrateDown(owner))).toEqual([`Down:${name}`]);
    }
    expect(await applicationTables()).toEqual([]);
    expect(await appFunctions()).toEqual([]);
    expect(expectSuccess(await migrateDown(owner))).toEqual([]);

    expect(expectSuccess(await migrateToLatest(owner))).toEqual(names.map((name) => `Up:${name}`));
    expect(await applicationTables()).toEqual(APPLICATION_TABLES);

    expectSuccess(await migrateDownAll(owner));
    expect(await applicationTables()).toEqual([]);
  });

  it('回滚 0005_platform_models 时恢复 0004 的 ai_usage_begin（不再引用白名单）', async () => {
    const source = async () =>
      (await sql<{ prosrc: string }>`SELECT prosrc FROM pg_proc WHERE proname = 'ai_usage_begin'`.execute(testDb.admin)).rows.map((row) => row.prosrc);
    expectSuccess(await migrateToLatest(owner));
    expect((await source())[0]).toContain('ai_model_price');
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0023_artifact_supersede']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0022_job_billing']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0021_jobs']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0020_technical_plan_content']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0019_technical_plan_outline']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0018_technical_plan']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0017_feasibility_report']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0016_rejection_check']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0015_files_project_immutable']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0014_duplicate_check']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0013_knowledge_base_items']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0012_knowledge_base']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0011_credential_library']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0010_export_templates']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0009_settings']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0008_artifacts']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0007_projects']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0006_files']);
    expect(expectSuccess(await migrateDown(owner))).toEqual(['Down:0005_platform_models']);
    const restored = await source();
    expect(restored).toHaveLength(1);
    expect(restored[0]).not.toContain('ai_model_price');
    expect(restored[0]).toContain('no price for model');
    expectSuccess(await migrateDownAll(owner));
  });

  it('迁移失败时整体回滚，不留下半成品', async () => {
    // 预先占用一个迁移要创建的函数名，让迁移在中途失败。
    await sql`CREATE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$`.execute(owner);
    try {
      const resultSet = await migrateToLatest(owner);
      expect(resultSet.error).toBeDefined();
      expect(await applicationTables()).toEqual([]);
      const executed = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(testDb.admin);
      expect(executed.rows).toEqual([]);
    } finally {
      await sql`DROP FUNCTION app_current_user_id()`.execute(owner);
    }
    expectSuccess(await migrateToLatest(owner));
  });
});

describe('迁移命令', () => {
  const entry = fileURLToPath(new URL('../../src/db/migrate.ts', import.meta.url));

  function runCli(args: string[], password = testDb.ownerConfig.password) {
    return spawnSync(process.execPath, [entry, ...args], {
      env: {
        PATH: process.env.PATH,
        DATABASE_HOST: testDb.ownerConfig.host,
        DATABASE_PORT: String(testDb.ownerConfig.port),
        DATABASE_NAME: testDb.name,
        MIGRATION_DATABASE_USER: testDb.ownerConfig.user,
        MIGRATION_DATABASE_PASSWORD: password,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  function lines(output: string) {
    return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('latest / down 可重复执行，输出结构化结果', async () => {
    await migrateDownAll(owner);

    const first = runCli(['latest']);
    expect(first.status, first.stderr).toBe(0);
    expect(lines(first.stdout)).toEqual([
      ...Object.keys(migrations).map((name) =>
        expect.objectContaining({ msg: 'migration', migration: name, direction: 'Up', status: 'Success' }),
      ),
      expect.objectContaining({ msg: 'system export templates synced', upserted: SYSTEM_EXPORT_TEMPLATES.length, removed: 0 }),
    ]);

    // 迁移到最新后每次都同步系统模板，重复执行不新增、不删除。
    const second = runCli(['latest']);
    expect(second.status, second.stderr).toBe(0);
    expect(lines(second.stdout)).toEqual([
      expect.objectContaining({ msg: 'already up to date' }),
      expect.objectContaining({ msg: 'system export templates synced', upserted: SYSTEM_EXPORT_TEMPLATES.length, removed: 0 }),
    ]);
    const system = await sql<{ n: number }>`SELECT count(*)::int AS n FROM export_templates WHERE org_id IS NULL`.execute(testDb.admin);
    expect(system.rows).toEqual([{ n: SYSTEM_EXPORT_TEMPLATES.length }]);

    const down = runCli(['down']);
    expect(down.status, down.stderr).toBe(0);
    expect(lines(down.stdout)).toEqual([expect.objectContaining({ direction: 'Down', status: 'Success' })]);

    expect(runCli(['latest']).status).toBe(0);
    expect(await applicationTables()).toEqual(APPLICATION_TABLES);
  });

  it('参数不合法时退出码为 1', () => {
    const result = runCli(['drop-everything']);
    expect(result.status).toBe(1);
    expect(lines(result.stderr)[0]).toMatchObject({ level: 'fatal' });
  });

  it('连接失败时退出码为 1，输出不含密码', () => {
    const result = runCli(['latest'], 'wrong-password-hunter2');
    expect(result.status).toBe(1);
    expect(lines(result.stderr).at(-1)).toMatchObject({ level: 'fatal', msg: 'migration failed' });
    expect(result.stderr + result.stdout).not.toContain('hunter2');
  });
});
