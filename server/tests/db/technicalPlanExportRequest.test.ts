// 技术方案整本导出的请求（迁移 0029_technical_plan_export_requests、src/export/documentRequestStore.ts，路线图 7.4f）的数据库测试：
// 1. 项目级表的隔离模板（describeProjectTable）；
// 2. 取快照：目录的项目名称、模板范围、所选模板规范化后的配置与只含组装所需字段的目录；组装结果与用完整目录组装的相同；
//    之后对目录、正文、模板的修改不影响已保存的快照；
// 3. 入队前就能确定的错误（没有目录、没有有效模板、标题超过六级、快照过大）直接拒绝、不保存；
// 4. RLS：本组织内可见、其他组织与项目删除后不可见，只能以自己的身份创建、只能挂在技术方案项目下；
// 5. 结果只能写一次，完成时清空目录；删除本项目的其他请求或只删一个。
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TECHNICAL_PLAN_EXPORT_OUTLINE_MAX_BYTES } from '../../src/db/migrations/0029_technical_plan_export_requests.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { assembleDocumentHtml } from '../../src/export/documentHtml.ts';
import {
  completeTechnicalPlanExportRequest,
  deleteTechnicalPlanExportRequests,
  findTechnicalPlanExportRequest,
  saveTechnicalPlanExportRequest,
} from '../../src/export/documentRequestStore.ts';
import { DEFAULT_EXPORT_TEMPLATE_KEY, loadTechnicalPlan, saveGenerationConfig, saveOutline } from '../../src/technicalPlan/store.ts';
import { normalizeExportFormat } from '../../src/templates/exportFormat.ts';
import { syncSystemTemplates } from '../../src/templates/system.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable } from './projectTable.ts';

const TABLE = 'technical_plan_export_requests';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let standardTemplateId: string;

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

async function newProject(ctx: TenantContext, kind = 'technical-plan'): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: ctx.orgId, kind, name: '项目', created_by: ctx.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

async function newTemplate(ctx: TenantContext, config: Record<string, unknown>): Promise<string> {
  return (await superuser.insertInto('export_templates')
    .values({ org_id: ctx.orgId, name: '组织模板', config: JSON.stringify({ template_name: '组织模板', ...config }), created_by: ctx.userId, updated_by: ctx.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

/** 直接写节点正文（saveOutline 的 replace 会清空正文；父节点的正文只能这样写入，用来证明它不进快照）。 */
async function setContent(projectId: string, nodeId: string, content: string) {
  await superuser.updateTable('technical_plan_outline_nodes').set({ content }).where('project_id', '=', projectId).where('node_id', '=', nodeId).execute();
}

const IMAGE = `/api/artifacts/${randomUUID()}/content`;

interface Filled {
  projectId: string;
  ids: Record<'chapter' | 'manual' | 'ai' | 'pending' | 'other' | 'second' | 'empty', string>;
}

/** 一个有父节点正文、AI 小节正文、人工正文（含配图）、待处理提示的目录。 */
async function fillProject(ctx: TenantContext): Promise<Filled> {
  const projectId = await newProject(ctx);
  const ids = {
    chapter: randomUUID(), manual: randomUUID(), ai: randomUUID(), pending: randomUUID(), other: randomUUID(), second: randomUUID(), empty: randomUUID(),
  };
  await saveOutline(appDb, ctx, projectId, {
    reason: 'replace',
    outlineData: {
      project_name: '某某项目 <投标>',
      project_overview: '概述不进快照',
      outline: [
        {
          id: ids.chapter, title: '第一章', description: '父节点说明',
          children: [
            { id: ids.manual, title: '人工小节', description: '说明', content_mode: 'manual-fill', knowledge_item_ids: [randomUUID()] },
            { id: ids.ai, title: 'AI 小节', content_mode: 'ai-generate' },
            { id: ids.pending, title: '待填写', content_mode: 'template-fill' },
            { id: ids.other, title: '其他', content_mode: 'other', content_mode_note: '另行处理' },
          ],
        },
        { id: ids.second, title: '第二章', content_mode: 'ai-generate', children: [{ id: ids.empty, title: '空的 AI 小节', content_mode: 'ai-generate' }] },
      ],
    },
  });
  await setContent(projectId, ids.chapter, '父节点的正文不导出');
  await setContent(projectId, ids.manual, `人工正文 **加粗**\n\n![配图](${IMAGE})\n\n| a | b |\n|---|---|\n| 1 | 2 |`);
  await setContent(projectId, ids.ai, 'AI 小节的正文在第 8 步之前不导出');
  return { projectId, ids };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toMatchObject({ statusCode: status, code });
}

async function requestCount(projectId: string): Promise<number> {
  const row = await superuser.selectFrom(TABLE).select((eb: any) => eb.fn.countAll().as('n')).where('project_id', '=', projectId).executeTakeFirstOrThrow();
  return Number((row as { n: unknown }).n);
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
  standardTemplateId = (await superuser.selectFrom('export_templates').select('id').where('org_id', 'is', null)
    .where('system_key', '=', DEFAULT_EXPORT_TEMPLATE_KEY).executeTakeFirstOrThrow()).id;
  appDb = connect(testDb.appConfig) as Kysely<Database>;
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
      projectKind: 'technical-plan',
      async insert(trx, scope) {
        const row = await trx.insertInto(TABLE).values({
          org_id: scope.orgId,
          project_id: scope.projectId,
          created_by: scope.userId,
          export_template_scope: 'ai-only',
          export_format: '{}',
          outline: JSON.stringify([{ id: randomUUID(), title: '一' }]),
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
  it('保存目录的项目名称、模板范围、所选模板规范化后的配置，目录只保留组装用得到的字段', async () => {
    const ctx = await newOrg();
    const { projectId, ids } = await fillProject(ctx);
    const templateId = await newTemplate(ctx, { page: { orientation: 'landscape' } });
    await saveGenerationConfig(appDb, ctx, projectId, { exportTemplateId: templateId, exportTemplateScope: 'document' });
    const record = await saveTechnicalPlanExportRequest(appDb, ctx, projectId);

    const template = await superuser.selectFrom('export_templates').select('config').where('id', '=', templateId).executeTakeFirstOrThrow();
    expect(record).toMatchObject({ projectId, createdBy: ctx.userId, result: null, completedAt: null });
    expect(record.exportFormat).toEqual(normalizeExportFormat(template.config));
    expect(record.snapshot!.projectName).toBe('某某项目 <投标>');
    expect(record.snapshot!.exportTemplateScope).toBe('document');
    const stored = await superuser.selectFrom(TABLE).select(['outline', 'project_name', 'export_format']).where('id', '=', record.id).executeTakeFirstOrThrow();
    expect(stored.export_format).toEqual(normalizeExportFormat(template.config));
    expect(stored.outline).toEqual([
      {
        id: ids.chapter, title: '第一章',
        children: [
          { id: ids.manual, title: '人工小节', content_mode: 'manual-fill', content: expect.stringContaining('人工正文') },
          { id: ids.ai, title: 'AI 小节', content_mode: 'ai-generate' },
          { id: ids.pending, title: '待填写', content_mode: 'template-fill' },
          { id: ids.other, title: '其他', content_mode: 'other', content_mode_note: '另行处理' },
        ],
      },
      { id: ids.second, title: '第二章', children: [{ id: ids.empty, title: '空的 AI 小节', content_mode: 'ai-generate' }] },
    ]);
    // 读回的快照与 findTechnicalPlanExportRequest 相同。
    expect(await findTechnicalPlanExportRequest(appDb, ctx, record.id)).toEqual(record);
  });

  it('两种模板范围下，快照的组装结果与用完整目录组装的相同', async () => {
    const ctx = await newOrg();
    const { projectId } = await fillProject(ctx);
    for (const scope of ['ai-only', 'document'] as const) {
      await saveGenerationConfig(appDb, ctx, projectId, { exportTemplateScope: scope });
      const state = await loadTechnicalPlan(appDb, ctx, projectId);
      const record = await saveTechnicalPlanExportRequest(appDb, ctx, projectId);
      const full = assembleDocumentHtml({ projectName: state.outlineData!.project_name ?? null, exportTemplateScope: scope, outline: state.outlineData!.outline });
      const fromSnapshot = assembleDocumentHtml(record.snapshot!);
      expect(fromSnapshot).toEqual(full);
      expect(fromSnapshot.assetRefs).toHaveLength(1);
      expect(fromSnapshot.skippedCount).toBe(2);
      expect(fromSnapshot.html).not.toContain('父节点的正文');
      expect(fromSnapshot.html).not.toContain('AI 小节的正文');
    }
  });

  it('未选择模板时用默认的系统模板；之后修改目录、正文与模板不影响已保存的快照', async () => {
    const ctx = await newOrg();
    const { projectId, ids } = await fillProject(ctx);
    const templateId = await newTemplate(ctx, { page: { orientation: 'landscape' } });
    const defaultRecord = await saveTechnicalPlanExportRequest(appDb, ctx, projectId);
    const standard = await superuser.selectFrom('export_templates').select('config').where('id', '=', standardTemplateId).executeTakeFirstOrThrow();
    expect(defaultRecord.exportFormat).toEqual(normalizeExportFormat(standard.config));

    await saveGenerationConfig(appDb, ctx, projectId, { exportTemplateId: templateId });
    const record = await saveTechnicalPlanExportRequest(appDb, ctx, projectId);
    const before = await findTechnicalPlanExportRequest(appDb, ctx, record.id);
    await setContent(projectId, ids.manual, '改过的正文');
    await superuser.updateTable('export_templates').set({ name: '改过', config: JSON.stringify({ template_name: '改过', page: { orientation: 'portrait' } }) }).where('id', '=', templateId).execute();
    await saveOutline(appDb, ctx, projectId, { reason: 'replace', outlineData: { project_name: '新名称', outline: [{ id: randomUUID(), title: '新目录' }] } });
    expect(await findTechnicalPlanExportRequest(appDb, ctx, record.id)).toEqual(before);
    expect(before!.snapshot!.outline[0]!.children![0]!.content).toContain('人工正文');
  });

  it('没有目录、没有有效模板、标题超过六级时拒绝且不保存', async () => {
    const ctx = await newOrg();
    const empty = await newProject(ctx);
    await expectAppError(saveTechnicalPlanExportRequest(appDb, ctx, empty), 400, 'EXPORT_EMPTY');
    // 项目属于其他组织、不是技术方案项目：状态是空的，同样按没有目录处理（路由先经 requireProject 返回 404）。
    const other = await newOrg();
    await expectAppError(saveTechnicalPlanExportRequest(appDb, other, (await fillProject(ctx)).projectId), 400, 'EXPORT_EMPTY');
    await expectAppError(saveTechnicalPlanExportRequest(appDb, ctx, await newProject(ctx, 'duplicate-check')), 400, 'EXPORT_EMPTY');

    // 所选模板被删除（外键置空）。
    const { projectId } = await fillProject(ctx);
    const templateId = await newTemplate(ctx, {});
    await saveGenerationConfig(appDb, ctx, projectId, { exportTemplateId: templateId });
    await superuser.deleteFrom('export_templates').where('id', '=', templateId).execute();
    expect((await loadTechnicalPlan(appDb, ctx, projectId)).exportTemplateId).toBeNull();
    await expectAppError(saveTechnicalPlanExportRequest(appDb, ctx, projectId), 400, 'EXPORT_TEMPLATE_REQUIRED');
    expect(await requestCount(projectId)).toBe(0);

    // 七级标题：六级以内可以保存。
    const deep = await newProject(ctx);
    const chain = (depth: number): Record<string, unknown> => ({ id: randomUUID(), title: `第 ${depth} 级`, ...(depth < 7 ? { children: [chain(depth + 1)] } : {}) });
    await saveOutline(appDb, ctx, deep, { reason: 'replace', outlineData: { outline: [chain(1)] } });
    await expectAppError(saveTechnicalPlanExportRequest(appDb, ctx, deep), 400, 'EXPORT_HEADING_TOO_DEEP');
    expect(await requestCount(deep)).toBe(0);
    const six = await newProject(ctx);
    await saveOutline(appDb, ctx, six, { reason: 'replace', outlineData: { outline: [chain(2)] } });
    await saveTechnicalPlanExportRequest(appDb, ctx, six);
    expect(await requestCount(six)).toBe(1);
  });

  it('快照过大时 413 且不保存；数据库的 CHECK 同样挡住过大的目录', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    // 每节 50 万字（3 字节一个），45 节约 64.4 MiB。
    const nodes = Array.from({ length: 45 }, (_, index) => ({ id: randomUUID(), title: `第 ${index + 1} 节`, content_mode: 'manual-fill' }));
    await saveOutline(appDb, ctx, projectId, { reason: 'replace', outlineData: { outline: nodes } });
    await superuser.updateTable('technical_plan_outline_nodes').set({ content: sql`repeat('字', 500000)` }).where('project_id', '=', projectId).execute();
    await expectAppError(saveTechnicalPlanExportRequest(appDb, ctx, projectId), 413, 'EXPORT_TOO_LARGE');
    expect(await requestCount(projectId)).toBe(0);

    await expect(superuser.insertInto(TABLE).values({
      org_id: ctx.orgId, project_id: projectId, created_by: ctx.userId, export_template_scope: 'ai-only', export_format: '{}',
      outline: sql`jsonb_build_array(repeat('a', ${TECHNICAL_PLAN_EXPORT_OUTLINE_MAX_BYTES}))`,
    }).execute()).rejects.toMatchObject({ code: '23514' });
  });
});

describe('可见性与写入规则', () => {
  it('同组织的其他成员可见；其他组织、项目删除后不可见，删除项目后恢复即可见', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const other = await newOrg();
    const { projectId } = await fillProject(ctx);
    const record = await saveTechnicalPlanExportRequest(appDb, ctx, projectId);
    expect((await findTechnicalPlanExportRequest(appDb, colleague, record.id))?.id).toBe(record.id);
    expect(await findTechnicalPlanExportRequest(appDb, other, record.id)).toBeNull();
    expect(await completeTechnicalPlanExportRequest(appDb, other, record.id, { artifactId: randomUUID(), warnings: [], message: '完成' })).toBeNull();
    expect(await deleteTechnicalPlanExportRequests(appDb, other, projectId, { onlyId: record.id })).toBe(0);

    await superuser.updateTable('projects').set({ deleted_at: new Date(), deleted_by: ctx.userId }).where('id', '=', projectId).execute();
    expect(await findTechnicalPlanExportRequest(appDb, ctx, record.id)).toBeNull();
    expect(await completeTechnicalPlanExportRequest(appDb, ctx, record.id, { artifactId: randomUUID(), warnings: [], message: '完成' })).toBeNull();
    expect(await deleteTechnicalPlanExportRequests(appDb, ctx, projectId, { onlyId: record.id })).toBe(0);
    await superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).execute();
    expect((await findTechnicalPlanExportRequest(appDb, ctx, record.id))?.result).toBeNull();
  });

  it('只能以自己的身份创建、结果为空、只能挂在技术方案项目下', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const projectId = await newProject(ctx);
    const values = (overrides: Record<string, unknown> = {}) => ({
      org_id: ctx.orgId, project_id: projectId, created_by: ctx.userId, export_template_scope: 'ai-only' as const, export_format: '{}',
      outline: JSON.stringify([{ id: randomUUID(), title: '一' }]), ...overrides,
    });
    const insert = (overrides: Record<string, unknown> = {}) =>
      withTenant(appDb, ctx, (trx) => (trx as Kysely<any>).insertInto(TABLE).values(values(overrides)).execute());
    await insert();
    await expect(insert({ created_by: colleague.userId })).rejects.toMatchObject({ code: '42501' });
    await expect(insert({ project_id: await newProject(ctx, 'duplicate-check') })).rejects.toMatchObject({ code: '42501' });
    // 结果列没有 INSERT 授权。
    for (const column of ['artifact_id', 'warnings', 'message', 'completed_at']) {
      const extra = column === 'warnings' ? '[]' : column === 'completed_at' ? new Date() : column === 'message' ? '完成' : randomUUID();
      await expect(insert({ [column]: extra }), column).rejects.toThrow(/permission denied/);
    }
    // 目录不能为空、模板范围必须合法。
    await expect(insert({ outline: '[]' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ outline: null })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ export_template_scope: 'all' })).rejects.toMatchObject({ code: '23514' });
  });

  it('结果只能写一次：完成时清空目录、写入完成时间；不完整的结果被拒绝；完成后不能再改', async () => {
    const ctx = await newOrg();
    const { projectId } = await fillProject(ctx);
    const record = await saveTechnicalPlanExportRequest(appDb, ctx, projectId);
    const update = (set: Record<string, unknown>) =>
      withTenant(appDb, ctx, (trx) => (trx as Kysely<any>).updateTable(TABLE).set(set).where('id', '=', record.id).execute());
    await expect(update({ message: '只有消息' })).rejects.toMatchObject({ code: '23514' });
    await expect(update({ artifact_id: randomUUID(), warnings: '[]', message: '没清空目录' })).rejects.toMatchObject({ code: '23514' });
    await expect(update({ completed_at: new Date() })).rejects.toThrow(/permission denied/);
    await expect(update({ export_format: '{}' })).rejects.toThrow(/permission denied/);

    const artifactId = randomUUID();
    const warnings = ['小节 1.1 人工小节 有 1 张图片无法导出，已在原位置用文字标出：图片不存在'];
    const done = await completeTechnicalPlanExportRequest(appDb, ctx, record.id, { artifactId, warnings, message: 'Word 已导出。' });
    expect(done).toMatchObject({ id: record.id, snapshot: null, result: { artifactId, warnings, message: 'Word 已导出。' } });
    expect(done!.completedAt).toBeInstanceOf(Date);
    expect(done!.exportFormat).toEqual(record.exportFormat);
    const row = await superuser.selectFrom(TABLE).select(['outline', 'completed_at']).where('id', '=', record.id).executeTakeFirstOrThrow();
    expect(row.outline).toBeNull();

    expect(await completeTechnicalPlanExportRequest(appDb, ctx, record.id, { artifactId: randomUUID(), warnings: [], message: '再来一次' })).toBeNull();
    await expect(update({ outline: null, artifact_id: randomUUID(), warnings: '[]', message: '改结果' })).rejects.toMatchObject({ code: 'TX001' });
    expect((await findTechnicalPlanExportRequest(appDb, ctx, record.id))!.result).toEqual({ artifactId, warnings, message: 'Word 已导出。' });

    // 参数检查。
    const fresh = await saveTechnicalPlanExportRequest(appDb, ctx, projectId);
    await expect(completeTechnicalPlanExportRequest(appDb, ctx, fresh.id, { artifactId, warnings: [], message: '' })).rejects.toThrow(TypeError);
    await expect(completeTechnicalPlanExportRequest(appDb, ctx, fresh.id, { artifactId, warnings: [1 as unknown as string], message: '完成' })).rejects.toThrow(TypeError);
    expect((await findTechnicalPlanExportRequest(appDb, ctx, fresh.id))!.result).toBeNull();
  });

  it('删除本项目的其他请求或只删一个，不影响其他项目', async () => {
    const ctx = await newOrg();
    const { projectId } = await fillProject(ctx);
    const { projectId: otherProject } = await fillProject(ctx);
    const [first, second, third] = [
      await saveTechnicalPlanExportRequest(appDb, ctx, projectId),
      await saveTechnicalPlanExportRequest(appDb, ctx, projectId),
      await saveTechnicalPlanExportRequest(appDb, ctx, projectId),
    ];
    const elsewhere = await saveTechnicalPlanExportRequest(appDb, ctx, otherProject);
    await completeTechnicalPlanExportRequest(appDb, ctx, first!.id, { artifactId: randomUUID(), warnings: [], message: '完成' });

    expect(await deleteTechnicalPlanExportRequests(appDb, ctx, projectId, { exceptId: third!.id })).toBe(2);
    expect(await findTechnicalPlanExportRequest(appDb, ctx, first!.id)).toBeNull();
    expect(await findTechnicalPlanExportRequest(appDb, ctx, second!.id)).toBeNull();
    expect(await findTechnicalPlanExportRequest(appDb, ctx, third!.id)).not.toBeNull();
    expect(await findTechnicalPlanExportRequest(appDb, ctx, elsewhere.id)).not.toBeNull();
    // 指定的 id 不属于这个项目时不删除。
    expect(await deleteTechnicalPlanExportRequests(appDb, ctx, projectId, { onlyId: elsewhere.id })).toBe(0);
    expect(await deleteTechnicalPlanExportRequests(appDb, ctx, projectId, { onlyId: third!.id })).toBe(1);
    expect(await requestCount(projectId)).toBe(0);
    expect(await requestCount(otherProject)).toBe(1);
  });
});
