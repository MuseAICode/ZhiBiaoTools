// 可研报告导出 Word 的请求（迁移 0030_feasibility_report_export、src/export/feasibilityRequestStore.ts，路线图 7.5c）的数据库测试：
// 1. 项目级表的隔离模板（describeProjectTable）；
// 2. 取快照：项目信息中的名称、所选模板规范化后的配置、导出选项（默认值、给出的值、文件编号为空时按桌面版规则生成）与项目信息、
//    只含导出用得到的字段的目录；之后对目录、正文、项目信息与模板的修改不影响已保存的快照；
// 3. 入队前就能确定的错误（没有目录、模板不存在或不可见、导出选项不合法、快照过大）直接拒绝、不保存；
// 4. RLS：本组织内可见、其他组织与项目删除后不可见，只能以自己的身份创建、只能挂在可研报告项目下；
// 5. 结果只能写一次，完成时清空目录；删除本项目的其他请求或只删一个。
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEASIBILITY_REPORT_EXPORT_OUTLINE_MAX_BYTES } from '../../src/db/migrations/0030_feasibility_report_export.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import {
  completeFeasibilityExportRequest,
  DEFAULT_FEASIBILITY_EXPORT_OPTIONS,
  defaultDocumentCode,
  deleteFeasibilityExportRequests,
  FEASIBILITY_EXPORT_OPTION_TEXT_MAX,
  findFeasibilityExportRequest,
  saveFeasibilityExportRequest,
} from '../../src/export/feasibilityRequestStore.ts';
import { saveOutline, saveProjectInfo } from '../../src/feasibilityReport/store.ts';
import { normalizeExportFormat } from '../../src/templates/exportFormat.ts';
import { syncSystemTemplates } from '../../src/templates/system.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable } from './projectTable.ts';

const TABLE = 'feasibility_report_export_requests';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let systemTemplateId: string;

async function newOrg(): Promise<TenantContext> {
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  return newMember(orgId, 'owner');
}

async function newMember(orgId: string, role: 'owner' | 'member' = 'member'): Promise<TenantContext> {
  const userId = randomUUID();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { orgId, userId, role };
}

async function newProject(ctx: TenantContext, kind = 'feasibility-report'): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: ctx.orgId, kind, name: '项目', created_by: ctx.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

async function newTemplate(ctx: TenantContext, config: Record<string, unknown>): Promise<string> {
  return (await superuser.insertInto('export_templates')
    .values({ org_id: ctx.orgId, name: '组织模板', config: JSON.stringify({ template_name: '组织模板', ...config }), created_by: ctx.userId, updated_by: ctx.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

const PROJECT_INFO = {
  projectName: '示例产业园', projectType: 'enterprise', industry: '制造业', constructionUnit: '示例公司', location: '某市',
  constructionContent: '厂房\n与配套', constructionPeriodYears: '3', operationPeriodYears: '15', totalInvestment: '1000', fundingSource: '自筹',
} as const;

/** 项目信息与一个有父节点正文、两个叶子（一个有正文）的目录。 */
async function fillProject(ctx: TenantContext) {
  const projectId = await newProject(ctx);
  await saveProjectInfo(appDb, ctx, projectId, PROJECT_INFO);
  await saveOutline(appDb, ctx, projectId, {
    reason: 'edit',
    outlineData: {
      project_name: '目录上的名称',
      outline: [
        {
          id: '1', title: '总论', description: '总论说明', content: '父节点的正文（不导出）',
          children: [
            { id: '1.1', title: '项目概况', description: '概况说明', content: '概况的正文\n\n![图](/api/artifacts/0b6f1f8e-3c1a-4d0e-9a51-0e2f7f9d1a01/content)' },
            { id: '1.2', title: '编制依据', description: '' },
          ],
        },
      ],
    },
  });
  return projectId;
}

function asApp<T>(context: TenantContext, work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
  return withTenant(appDb, context, work);
}

async function count(projectId: string): Promise<number> {
  return Number((await superuser.selectFrom(TABLE).select((eb) => eb.fn.countAll<string>().as('n')).where('project_id', '=', projectId).executeTakeFirstOrThrow()).n);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
    await syncSystemTemplates(owner);
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  appDb = connect<Database>(testDb.appConfig, 5);
  systemTemplateId = (await superuser.selectFrom('export_templates').select('id').where('org_id', 'is', null).executeTakeFirstOrThrow()).id;
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('隔离模板', () => {
  describeProjectTable(
    {
      table: TABLE,
      idColumn: 'id',
      projectKind: 'feasibility-report',
      async insert(trx, scope) {
        const row = await trx.insertInto(TABLE).values({
          org_id: scope.orgId,
          project_id: scope.projectId,
          created_by: scope.userId,
          export_format: '{}',
          options: '{}',
          outline: JSON.stringify([{ id: '1', title: '一' }]),
        }).returning('id').executeTakeFirstOrThrow();
        return row.id;
      },
      // 唯一的 UPDATE 是完成。
      update: { outline: null, artifact_id: randomUUID(), warnings: '[]', message: '完成' },
      onProjectDelete: 'cascade',
    },
    { admin: () => superuser, app: () => appDb },
  );
});

describe('取快照', () => {
  it('保存项目信息中的名称、所选模板规范化后的配置、导出选项与项目信息，目录只保留导出用得到的字段', async () => {
    const ctx = await newOrg();
    const projectId = await fillProject(ctx);
    const templateId = await newTemplate(ctx, { page: { orientation: 'landscape' } });
    const record = await saveFeasibilityExportRequest(appDb, ctx, projectId, {
      templateId,
      options: { includeCover: false, preparationUnit: '编制单位甲', documentCode: '  KYBG-000001  ' },
    });
    expect(record).toMatchObject({ projectId, createdBy: ctx.userId, projectName: '示例产业园', result: null, completedAt: null });
    expect(record.exportFormat).toEqual(normalizeExportFormat({ template_name: '组织模板', page: { orientation: 'landscape' } }));
    expect(record.options).toEqual({
      includeCover: false,
      includePreparationNotes: DEFAULT_FEASIBILITY_EXPORT_OPTIONS.includePreparationNotes,
      includeAppendixTables: DEFAULT_FEASIBILITY_EXPORT_OPTIONS.includeAppendixTables,
      preparationUnit: '编制单位甲',
      securityLevel: DEFAULT_FEASIBILITY_EXPORT_OPTIONS.securityLevel,
      documentCode: 'KYBG-000001',
      projectInfo: { ...PROJECT_INFO },
    });
    // 父节点的正文与各节的说明不导出，不在快照中。
    expect(record.outline).toEqual([
      {
        id: '1', title: '总论',
        children: [
          { id: '1.1', title: '项目概况', content: '概况的正文\n\n![图](/api/artifacts/0b6f1f8e-3c1a-4d0e-9a51-0e2f7f9d1a01/content)' },
          { id: '1.2', title: '编制依据' },
        ],
      },
    ]);
    expect(await findFeasibilityExportRequest(appDb, ctx, record.id)).toEqual(record);
  });

  it('选项都取默认值；文件编号为空时按桌面版规则生成（KYBG- 加时间戳后 6 位）；可以选系统模板', async () => {
    const ctx = await newOrg();
    const projectId = await fillProject(ctx);
    const now = new Date('2026-11-08T09:00:00.123Z');
    const record = await saveFeasibilityExportRequest(appDb, ctx, projectId, { templateId: systemTemplateId, options: { documentCode: '   ' } }, now);
    expect(record.options).toMatchObject({ ...DEFAULT_FEASIBILITY_EXPORT_OPTIONS, documentCode: defaultDocumentCode(now) });
    expect(defaultDocumentCode(now)).toBe(`KYBG-${now.getTime().toString().slice(-6)}`);
    expect(record.options.documentCode).toMatch(/^KYBG-\d{6}$/);
  });

  it('项目名称为空时快照中为 null；之后修改目录、正文、项目信息与模板不影响已保存的快照', async () => {
    const ctx = await newOrg();
    const projectId = await fillProject(ctx);
    const templateId = await newTemplate(ctx, {});
    const first = await saveFeasibilityExportRequest(appDb, ctx, projectId, { templateId, options: {} });
    await saveProjectInfo(appDb, ctx, projectId, { ...PROJECT_INFO, projectName: '改过的名称', location: '另一市' });
    await saveOutline(appDb, ctx, projectId, { reason: 'replace', outlineData: { outline: [{ id: '9', title: '新的目录', description: '' }] } });
    await superuser.updateTable('export_templates').set({ name: '改过的模板', config: JSON.stringify({ template_name: '改过的模板' }) }).where('id', '=', templateId).execute();
    const reread = (await findFeasibilityExportRequest(appDb, ctx, first.id))!;
    expect(reread.outline).toEqual(first.outline);
    expect(reread.options).toEqual(first.options);
    expect(reread.exportFormat).toEqual(first.exportFormat);
    expect(reread.projectName).toBe('示例产业园');

    await superuser.updateTable('feasibility_report_meta').set({ project_name: '' }).where('project_id', '=', projectId).execute();
    expect((await saveFeasibilityExportRequest(appDb, ctx, projectId, { templateId, options: {} })).projectName).toBeNull();
  });

  it('没有目录、模板不存在或属于其他组织、导出选项不合法时拒绝且不保存', async () => {
    const ctx = await newOrg();
    const outsider = await newOrg();
    const empty = await newProject(ctx);
    await expect(saveFeasibilityExportRequest(appDb, ctx, empty, { templateId: systemTemplateId, options: {} }))
      .rejects.toMatchObject({ statusCode: 400, code: 'EXPORT_EMPTY', message: '没有可导出的目录内容' });
    // 技术方案项目没有可研目录，同样按没有目录处理（路由先经 requireProject 返回 404）。
    await expect(saveFeasibilityExportRequest(appDb, ctx, await newProject(ctx, 'technical-plan'), { templateId: systemTemplateId, options: {} }))
      .rejects.toMatchObject({ code: 'EXPORT_EMPTY' });

    const projectId = await fillProject(ctx);
    const foreignTemplate = await newTemplate(outsider, {});
    for (const templateId of [randomUUID(), foreignTemplate, 'not-a-uuid']) {
      await expect(saveFeasibilityExportRequest(appDb, ctx, projectId, { templateId, options: {} }))
        .rejects.toMatchObject({ statusCode: 400, code: 'EXPORT_TEMPLATE_REQUIRED' });
    }
    for (const options of [
      { includeCover: 'yes' },
      { preparationUnit: 1 },
      { securityLevel: '密'.repeat(FEASIBILITY_EXPORT_OPTION_TEXT_MAX + 1) },
      { baseDir: '/etc' },
      null,
    ]) {
      await expect(saveFeasibilityExportRequest(appDb, ctx, projectId, { templateId: systemTemplateId, options: options as never }))
        .rejects.toMatchObject({ statusCode: 400, code: 'EXPORT_OPTIONS_INVALID' });
    }
    await expect(saveFeasibilityExportRequest(appDb, ctx, projectId, {
      templateId: systemTemplateId, options: { securityLevel: '密'.repeat(FEASIBILITY_EXPORT_OPTION_TEXT_MAX) },
    })).resolves.toMatchObject({ options: { securityLevel: '密'.repeat(FEASIBILITY_EXPORT_OPTION_TEXT_MAX) } });
    expect(await count(empty)).toBe(0);
    expect(await count(projectId)).toBe(1);
  });

  it('快照过大时 413 且不保存；数据库的 CHECK 同样挡住过大的目录', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    // 每节正文至多 50 万字（数据库 CHECK）：45 节、每节 50 万个三字节的汉字，合计约 67.5 MB，超过快照的 64 MiB。
    const leaves = Array.from({ length: 45 }, (_item, index) => ({ id: `${index + 1}`, title: `第 ${index + 1} 章`, description: '' }));
    await saveOutline(appDb, ctx, projectId, { reason: 'replace', outlineData: { outline: leaves } });
    const big = '正'.repeat(500_000);
    expect(leaves.length * Buffer.byteLength(big)).toBeGreaterThan(FEASIBILITY_REPORT_EXPORT_OUTLINE_MAX_BYTES);
    await superuser.updateTable('feasibility_report_outline_nodes').set({ content: big }).where('project_id', '=', projectId).execute();
    await expect(saveFeasibilityExportRequest(appDb, ctx, projectId, { templateId: systemTemplateId, options: {} }))
      .rejects.toMatchObject({ statusCode: 413, code: 'EXPORT_TOO_LARGE' });
    expect(await count(projectId)).toBe(0);
    await expect(asApp(ctx, (trx) => trx.insertInto(TABLE).values({
      org_id: ctx.orgId, project_id: projectId, created_by: ctx.userId, export_format: '{}', options: '{}',
      outline: JSON.stringify([{ id: '1', title: 'x', content: 'x'.repeat(FEASIBILITY_REPORT_EXPORT_OUTLINE_MAX_BYTES) }]),
    }).execute())).rejects.toMatchObject({ code: '23514' });
  });
});

describe('可见性与写入规则', () => {
  it('同组织的其他成员可见；其他组织、项目删除后不可见', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const outsider = await newOrg();
    const projectId = await fillProject(ctx);
    const record = await saveFeasibilityExportRequest(appDb, ctx, projectId, { templateId: systemTemplateId, options: {} });
    expect((await findFeasibilityExportRequest(appDb, colleague, record.id))?.id).toBe(record.id);
    expect(await findFeasibilityExportRequest(appDb, outsider, record.id)).toBeNull();
    await superuser.updateTable('projects').set({ deleted_at: new Date(), deleted_by: ctx.userId }).where('id', '=', projectId).execute();
    expect(await findFeasibilityExportRequest(appDb, ctx, record.id)).toBeNull();
  });

  it('只能以自己的身份创建、结果为空、只能挂在可研报告项目下', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const projectId = await newProject(ctx);
    const plan = await newProject(ctx, 'technical-plan');
    const row = (values: Record<string, unknown>) => ({
      org_id: ctx.orgId, project_id: projectId, created_by: ctx.userId, export_format: '{}', options: '{}',
      outline: JSON.stringify([{ id: '1', title: '一' }]), ...values,
    });
    await expect(asApp(ctx, (trx) => trx.insertInto(TABLE).values(row({ created_by: colleague.userId }) as never).execute())).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(ctx, (trx) => trx.insertInto(TABLE).values(row({ project_id: plan }) as never).execute())).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(ctx, (trx) => trx.insertInto(TABLE).values(row({ artifact_id: randomUUID() }) as never).execute())).rejects.toMatchObject({ code: '42501' });
    await asApp(ctx, (trx) => trx.insertInto(TABLE).values(row({}) as never).execute());
  });

  it('结果只能写一次：完成时清空目录、写入完成时间；不完整的结果被拒绝；完成后不能再改', async () => {
    const ctx = await newOrg();
    const projectId = await fillProject(ctx);
    const record = await saveFeasibilityExportRequest(appDb, ctx, projectId, { templateId: systemTemplateId, options: {} });
    const artifactId = randomUUID();
    await expect(asApp(ctx, (trx) => trx.updateTable(TABLE).set({ outline: null, artifact_id: artifactId } as never).where('id', '=', record.id).execute()))
      .rejects.toMatchObject({ code: '23514' });
    const done = (await completeFeasibilityExportRequest(appDb, ctx, record.id, { artifactId, warnings: ['图片无法导出：图，未找到可用图片数据'], message: '已导出' }))!;
    expect(done).toMatchObject({ outline: null, result: { artifactId, warnings: ['图片无法导出：图，未找到可用图片数据'], message: '已导出' } });
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(done.options).toEqual(record.options);
    expect(await completeFeasibilityExportRequest(appDb, ctx, record.id, { artifactId: randomUUID(), warnings: [], message: '再次' })).toBeNull();
    await expect(asApp(ctx, (trx) => trx.updateTable(TABLE).set({ message: '改' }).where('id', '=', record.id).execute()))
      .rejects.toMatchObject({ code: 'FX001' });
    await expect(completeFeasibilityExportRequest(appDb, ctx, record.id, { artifactId, warnings: [], message: '' })).rejects.toThrow(TypeError);
    await expect(completeFeasibilityExportRequest(appDb, ctx, record.id, { artifactId, warnings: [1 as never], message: 'x' })).rejects.toThrow(TypeError);
  });

  it('删除本项目的其他请求或只删一个，不影响其他项目', async () => {
    const ctx = await newOrg();
    const projectId = await fillProject(ctx);
    const other = await fillProject(ctx);
    const save = (id: string) => saveFeasibilityExportRequest(appDb, ctx, id, { templateId: systemTemplateId, options: {} });
    const a = await save(projectId);
    const b = await save(projectId);
    const c = await save(projectId);
    const elsewhere = await save(other);
    expect(await deleteFeasibilityExportRequests(appDb, ctx, projectId, { exceptId: c.id })).toBe(2);
    expect(await findFeasibilityExportRequest(appDb, ctx, a.id)).toBeNull();
    expect(await findFeasibilityExportRequest(appDb, ctx, b.id)).toBeNull();
    expect(await deleteFeasibilityExportRequests(appDb, ctx, projectId, { onlyId: c.id })).toBe(1);
    expect(await count(projectId)).toBe(0);
    expect(await findFeasibilityExportRequest(appDb, ctx, elsewhere.id)).not.toBeNull();
    await sql`SELECT 1`.execute(appDb);
  });
});
