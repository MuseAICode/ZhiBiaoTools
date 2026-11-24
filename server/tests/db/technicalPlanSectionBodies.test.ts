// AI 小节正文的存储（迁移 0046_technical_plan_section_bodies，src/technicalPlan/sectionBodies.ts，路线图第 8 步 8.10a）对真实数据库的测试：
// 两张新表的隔离模板（describeProjectTable，项目级）；配图只能引用同一项目已完成、未被替换的图片产物（Store 核对，触发器 TP046 兜底）；
// 整体替换时不再引用的配图标为已被替换（其他小节仍引用的不替换）；重置正文阶段、目录保存（delete / add-* / replace、不再是 ai-generate
// 叶子）、目录生成结果、清空等入口一并删除正文并替换配图；项目软删除后不可见；读取接口。
// 白名单本身（清洗与拒绝）的逐条用例见 tests/technicalPlan/sectionBodies.test.ts。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { ORG_STORAGE_QUOTA_BYTES } from '../../src/db/migrations/0006_files.ts';
import { MAX_ARTIFACT_BYTES } from '../../src/db/migrations/0008_artifacts.ts';
import { TECHNICAL_PLAN_SECTION_BODY_TABLES, TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES } from '../../src/db/migrations/0046_technical_plan_section_bodies.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE, STORAGE_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import {
  clearTechnicalPlan,
  getSectionBody,
  resetContentGeneration,
  saveGeneratedOutline,
  saveGlobalFacts,
  saveOutline,
  saveSectionBody,
} from '../../src/technicalPlan/store.ts';
import { SectionBodyRejectedError } from '../../src/technicalPlan/sectionBodies.ts';
import { RESTRICTED_HTML_BLOCK_MARKER } from '../../src/templates/restrictedHtml.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, type ProjectRowScope } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-59';

interface Member {
  userId: string;
  orgId: string;
  context: TenantContext;
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;

const memoryStore: ObjectStore = {
  async put(_key, body) {
    for await (const _chunk of body) void _chunk;
  },
  async get() {
    return { body: Readable.from([]), size: 0 };
  },
  async exists() {
    return true;
  },
  async delete() {},
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
});

afterAll(async () => {
  await database?.destroy();
  await testDb?.drop();
});

// ---- 数据 ----

async function newMember(orgId: string = randomUUID()): Promise<Member> {
  const userId = randomUUID();
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: `org-${orgId}`, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x', email_verified_at: new Date() }).execute();
  const role = existing ? 'member' : 'owner';
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, context: { orgId, userId, role } };
}

async function newProject(member: Member, kind = 'technical-plan'): Promise<string> {
  const row = await superuser.insertInto('projects').values({ org_id: member.orgId, kind, name: '技术方案', created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

/** 用超级用户登记一个产物（默认本项目已完成的图片）。 */
async function newImage(
  member: Member,
  projectId: string | null,
  options: { kind?: 'image' | 'markdown'; status?: 'ready' | 'writing'; superseded?: boolean; sourceFileId?: string } = {},
): Promise<string> {
  const kind = options.kind ?? 'image';
  const ready = (options.status ?? 'ready') === 'ready';
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      project_id: projectId,
      source_file_id: options.sourceFileId ?? null,
      kind,
      name: kind === 'image' ? 'image-001.png' : 'content.md',
      mime: kind === 'image' ? 'image/png' : 'text/markdown; charset=utf-8',
      status: ready ? 'ready' : 'writing',
      size_bytes: ready ? 10 : null,
      sha256: ready ? Buffer.alloc(32) : null,
      completed_at: ready ? new Date() : null,
      created_by: member.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (options.superseded) await superuser.updateTable('artifacts').set({ superseded_at: new Date() }).where('id', '=', row.id).execute();
  return row.id;
}

const superseded = async (artifactId: string) =>
  (await superuser.selectFrom('artifacts').select('superseded_at').where('id', '=', artifactId).executeTakeFirstOrThrow()).superseded_at !== null;

/** 两章四个节点的目录：[第一章, 1.1（AI）, 1.2（AI）, 第二章（人工）]。 */
function outlineOf(nodes: string[], modes: Partial<Record<number, string>> = {}) {
  return {
    project_name: '示例项目',
    project_overview: '概述',
    outline: [
      {
        id: nodes[0],
        title: '第一章',
        description: '',
        children: [
          { id: nodes[1], title: '1.1 节', description: '', content_mode: modes[1] ?? 'ai-generate' },
          { id: nodes[2], title: '1.2 节', description: '', content_mode: modes[2] ?? 'ai-generate' },
        ],
      },
      { id: nodes[3], title: '第二章', description: '', content_mode: modes[3] ?? 'manual-fill' },
    ],
  };
}

interface Plan {
  member: Member;
  projectId: string;
  nodes: string[];
}

async function newPlan(member?: Member): Promise<Plan> {
  const owner = member ?? (await newMember());
  const projectId = await newProject(owner);
  const nodes = Array.from({ length: 4 }, () => randomUUID());
  await saveGeneratedOutline(appDb, owner.context, projectId, { outlineData: outlineOf(nodes), wordControlSnapshot: null });
  return { member: owner, projectId, nodes };
}

const block = (html: string) => `${RESTRICTED_HTML_BLOCK_MARKER}\n${html}`;
const figure = (ref: string, id: string) =>
  `<figure id="${id}" data-app-generation="aiImage" data-app-size="wide" data-app-fit="contain"><template data-app-role="prompt">示意</template><img alt="示意" data-app-asset-ref="${ref}"></figure>`;
/** 一段正文加若干配图。 */
const bodyOf = (text: string, refs: string[] = []) => [block(`<p id="p1">${text}</p>`), ...refs.map((ref, index) => block(figure(ref, `f${index}`)))].join('\n');

const counts = async (projectId: string) => {
  const one = async (table: string) =>
    Number(((await superuser.selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).where('project_id', '=', projectId).executeTakeFirstOrThrow()) as { n: string }).n);
  return { bodies: await one('technical_plan_section_bodies'), images: await one('technical_plan_section_images') };
};

// ---- 隔离模板 ----

describe('隔离模板', () => {
  const env = { admin: () => superuser, app: () => appDb };
  const base = (scope: ProjectRowScope) => ({ org_id: scope.orgId, project_id: scope.projectId });

  async function nodeIn(trx: Transaction<any>, scope: ProjectRowScope): Promise<string> {
    const nodeId = randomUUID();
    await trx.insertInto('technical_plan_outline_nodes').values({ ...base(scope), node_id: nodeId, level: 1, title: '小节', content_mode: 'ai-generate' }).execute();
    return nodeId;
  }

  async function bodyIn(trx: Transaction<any>, scope: ProjectRowScope): Promise<string> {
    const nodeId = await nodeIn(trx, scope);
    await trx.insertInto('technical_plan_section_bodies').values({ ...base(scope), node_id: nodeId, html: bodyOf('正文') }).execute();
    return nodeId;
  }

  describeProjectTable(
    {
      table: 'technical_plan_section_bodies',
      idColumn: 'node_id',
      projectKind: 'technical-plan',
      insert: bodyIn,
      update: { html: bodyOf('改过的正文') },
      onProjectDelete: 'cascade',
      // 配额函数的属主（迁移 0046：正文计入组织存储配额），只有只读策略。
      definerRoles: [STORAGE_ROLE],
    },
    env,
  );

  describeProjectTable(
    {
      table: 'technical_plan_section_images',
      idColumn: 'artifact_id',
      projectKind: 'technical-plan',
      async insert(trx, scope) {
        const nodeId = await bodyIn(trx, scope);
        const artifact = await trx
          .insertInto('artifacts')
          .values({ ...base(scope), kind: 'image', name: 'image-001.png', mime: 'image/png', created_by: scope.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx.updateTable('artifacts').set({ status: 'ready', size_bytes: 10, sha256: Buffer.alloc(32) }).where('id', '=', artifact.id).execute();
        await trx.insertInto('technical_plan_section_images').values({ ...base(scope), node_id: nodeId, artifact_id: artifact.id }).execute();
        return artifact.id;
      },
      // 配图引用的产物属于项目，挡住项目的物理删除（清理任务先删产物，配图行随产物删除）。
      onProjectDelete: 'restrict',
    },
    env,
  );

  it('两张表都在迁移导出的清单中，应用角色只有登记的列权限', async () => {
    expect([...TECHNICAL_PLAN_SECTION_BODY_TABLES]).toEqual(['technical_plan_section_bodies', 'technical_plan_section_images']);
    const privileges = await sql<{ table_name: string; privilege_type: string; column_name: string }>`
      SELECT table_name, privilege_type, column_name FROM information_schema.column_privileges
      WHERE grantee = ${APP_ROLE} AND table_name IN ('technical_plan_section_bodies', 'technical_plan_section_images')
        AND privilege_type IN ('INSERT', 'UPDATE')
      ORDER BY table_name, privilege_type, column_name`.execute(superuser);
    expect(privileges.rows.map((row) => `${row.table_name}.${row.privilege_type}.${row.column_name}`)).toEqual([
      'technical_plan_section_bodies.INSERT.html',
      'technical_plan_section_bodies.INSERT.node_id',
      'technical_plan_section_bodies.INSERT.org_id',
      'technical_plan_section_bodies.INSERT.project_id',
      'technical_plan_section_bodies.UPDATE.html',
      'technical_plan_section_images.INSERT.artifact_id',
      'technical_plan_section_images.INSERT.node_id',
      'technical_plan_section_images.INSERT.org_id',
      'technical_plan_section_images.INSERT.project_id',
    ]);
  });
});

// ---- 写入与读取 ----

describe('saveSectionBody / getSectionBody', () => {
  it('写入规范化的正文与配图，读取按正文中的顺序返回引用', async () => {
    const { member, projectId, nodes } = await newPlan();
    const [a, b] = [await newImage(member, projectId), await newImage(member, projectId)];
    const saved = await saveSectionBody(appDb, member.context, projectId, nodes[1]!.toUpperCase(), bodyOf('正文<a href="http://example.invalid">链接</a>', [b, a, b]));
    expect(saved.html).not.toMatch(/href|example\.invalid|<a/);
    expect(saved.html).toMatch(/正文链接/);
    expect(saved.imageArtifactIds).toEqual([b, a]);
    const read = await getSectionBody(appDb, member.context, projectId, nodes[1]!);
    expect(read).toMatchObject({ nodeId: nodes[1], html: saved.html, imageArtifactIds: [b, a] });
    expect(await counts(projectId)).toEqual({ bodies: 1, images: 2 });
    expect(await getSectionBody(appDb, member.context, projectId, nodes[2]!)).toBeNull();
    expect(await getSectionBody(appDb, member.context, projectId, 'not-a-uuid')).toBeNull();
  });

  it('整体替换：本节不再引用、其他小节也没有引用的配图标为已被替换', async () => {
    const { member, projectId, nodes } = await newPlan();
    const [a, b, c] = [await newImage(member, projectId), await newImage(member, projectId), await newImage(member, projectId)];
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('一', [a, b]));
    await saveSectionBody(appDb, member.context, projectId, nodes[2]!, bodyOf('二', [b]));
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('一改', [a, c]));
    // b 仍被 1.2 引用，不替换；a 继续被引用。
    expect([await superseded(a), await superseded(b), await superseded(c)]).toEqual([false, false, false]);
    await saveSectionBody(appDb, member.context, projectId, nodes[2]!, bodyOf('二改'));
    expect([await superseded(a), await superseded(b), await superseded(c)]).toEqual([false, true, false]);
    // 已被替换的配图不能再引用。
    await expect(saveSectionBody(appDb, member.context, projectId, nodes[2]!, bodyOf('二', [b]))).rejects.toBeInstanceOf(SectionBodyRejectedError);
    expect(await counts(projectId)).toEqual({ bodies: 2, images: 2 });
  });

  it('配图必须是本项目已完成、未被替换的图片产物，否则整节拒绝、什么都不写', async () => {
    const { member, projectId, nodes } = await newPlan();
    const otherProject = await newProject(member);
    const stranger = await newMember();
    const strangerProject = await newProject(stranger);
    const fileId = (
      await superuser
        .insertInto('files')
        .values({ org_id: member.orgId, purpose: 'tender', display_name: 'a.docx', extension: 'docx', status: 'uploaded', mime: 'application/zip', size_bytes: 1, sha256: Buffer.alloc(32), uploaded_at: new Date(), created_by: member.userId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const bad = [
      await newImage(member, otherProject),
      await newImage(stranger, strangerProject),
      await newImage(member, projectId, { status: 'writing' }),
      await newImage(member, projectId, { superseded: true }),
      await newImage(member, projectId, { kind: 'markdown' }),
      await newImage(member, null, { sourceFileId: fileId }),
      randomUUID(),
    ];
    const good = await newImage(member, projectId);
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('原正文', [good]));
    for (const ref of bad) {
      const failure = saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('新正文', [good, ref]));
      await expect(failure).rejects.toBeInstanceOf(SectionBodyRejectedError);
      await expect(failure).rejects.toMatchObject({ issues: ['有 1 张配图不是本项目已生成的图片'] });
    }
    expect((await getSectionBody(appDb, member.context, projectId, nodes[1]!))?.html).toMatch(/原正文/);
    expect(await superseded(good)).toBe(false);
  });

  it('触发器兜底：绕过 Store 直接写配图行，不合规的产物被拒绝（TP046），合规的照常写入', async () => {
    const { member, projectId, nodes } = await newPlan();
    const otherProject = await newProject(member);
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('正文'));
    const insert = (artifactId: string) =>
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('technical_plan_section_images').values({ org_id: member.orgId, project_id: projectId, node_id: nodes[1]!, artifact_id: artifactId }).execute(),
      );
    for (const artifactId of [
      await newImage(member, otherProject),
      await newImage(member, projectId, { status: 'writing' }),
      await newImage(member, projectId, { superseded: true }),
      await newImage(member, projectId, { kind: 'markdown' }),
    ]) {
      await expect(insert(artifactId)).rejects.toMatchObject({ code: 'TP046' });
    }
    await insert(await newImage(member, projectId));
    // 应用角色不能改配图行（没有 UPDATE 授权），也不能改正文的归属列。
    await expect(
      withTenant(appDb, member.context, (trx) => (trx as unknown as Kysely<any>).updateTable('technical_plan_section_images').set({ node_id: nodes[2] }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(appDb, member.context, (trx) => (trx as unknown as Kysely<any>).updateTable('technical_plan_section_bodies').set({ node_id: nodes[2] }).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('只能写 ai-generate 叶子：不在目录中 404、父节点与其他处理方式 409', async () => {
    const { member, projectId, nodes } = await newPlan();
    await expect(saveSectionBody(appDb, member.context, projectId, randomUUID(), bodyOf('正文'))).rejects.toMatchObject({ statusCode: 404, code: 'TECHNICAL_PLAN_CHAPTER_NOT_FOUND' });
    for (const nodeId of [nodes[0]!, nodes[3]!]) {
      await expect(saveSectionBody(appDb, member.context, projectId, nodeId, bodyOf('正文'))).rejects.toMatchObject({ statusCode: 409, code: 'TECHNICAL_PLAN_SECTION_NOT_AI_GENERATED' });
    }
    await expect(saveSectionBody(appDb, member.context, projectId, 'x', bodyOf('正文'))).rejects.toBeInstanceOf(TypeError);
    // 白名单拒绝的正文不写库。
    await expect(saveSectionBody(appDb, member.context, projectId, nodes[1]!, block('<div>隐藏</div>'))).rejects.toMatchObject({ statusCode: 422 });
    expect(await counts(projectId)).toEqual({ bodies: 0, images: 0 });
  });

  it('其他组织的项目：读不到、写不进（RLS 下节点不可见，按不在目录中处理）', async () => {
    const { member, projectId, nodes } = await newPlan();
    const image = await newImage(member, projectId);
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('正文', [image]));
    const stranger = await newMember();
    expect(await getSectionBody(appDb, stranger.context, projectId, nodes[1]!)).toBeNull();
    await expect(saveSectionBody(appDb, stranger.context, projectId, nodes[1]!, bodyOf('篡改'))).rejects.toMatchObject({ statusCode: 404 });
    expect((await getSectionBody(appDb, member.context, projectId, nodes[1]!))?.html).toMatch(/正文/);
  });

  it('项目软删除后正文与配图行不可见，恢复项目即一起恢复', async () => {
    const { member, projectId, nodes } = await newPlan();
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('正文', [await newImage(member, projectId)]));
    const visible = () =>
      withTenant(appDb, member.context, async (trx) => ({
        bodies: (await trx.selectFrom('technical_plan_section_bodies').select('node_id').execute()).length,
        images: (await trx.selectFrom('technical_plan_section_images').select('node_id').execute()).length,
      }));
    expect(await visible()).toEqual({ bodies: 1, images: 1 });
    await superuser.updateTable('projects').set({ deleted_at: new Date(), deleted_by: member.userId }).where('id', '=', projectId).execute();
    expect(await visible()).toEqual({ bodies: 0, images: 0 });
    await withTenant(appDb, member.context, async (trx) => {
      expect(Number((await trx.deleteFrom('technical_plan_section_bodies').executeTakeFirst()).numDeletedRows)).toBe(0);
      expect(Number((await trx.updateTable('technical_plan_section_bodies').set({ html: bodyOf('改') }).executeTakeFirst()).numUpdatedRows)).toBe(0);
    });
    await superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).execute();
    expect(await visible()).toEqual({ bodies: 1, images: 1 });
  });
});

// ---- 组织存储配额与大小上限 ----

describe('组织存储配额与大小上限', () => {
  const usage = async (member: Member) =>
    BigInt((await withTenant(appDb, member.context, (trx) => sql<{ n: string }>`SELECT files_org_usage_bytes(${member.orgId}::uuid) AS n`.execute(trx))).rows[0]!.n);
  const htmlBytes = (html: string) => BigInt(Buffer.byteLength(html, 'utf8'));

  /** 用超级用户登记若干 100 MiB 的产物，把组织用量填到只剩 free 字节。 */
  async function fillQuota(member: Member, projectId: string, free: bigint) {
    let remaining = ORG_STORAGE_QUOTA_BYTES - (await usage(member)) - free;
    const rows = [];
    while (remaining > 0n) {
      const size = remaining > BigInt(MAX_ARTIFACT_BYTES) ? BigInt(MAX_ARTIFACT_BYTES) : remaining;
      rows.push({
        org_id: member.orgId, project_id: projectId, kind: 'image', name: 'image-001.png', mime: 'image/png', status: 'ready',
        size_bytes: size.toString(), sha256: Buffer.alloc(32), completed_at: new Date(), created_by: member.userId,
      });
      remaining -= size;
    }
    await superuser.insertInto('artifacts').values(rows).execute();
    expect(await usage(member)).toBe(ORG_STORAGE_QUOTA_BYTES - free);
  }

  it('正文按 UTF-8 字节计入组织配额：替换按新大小，清空后不再计入；项目软删除后恢复期内照常计入，超过恢复期不再计入', async () => {
    const { member, projectId, nodes } = await newPlan();
    const before = await usage(member);
    const first = await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('正文'.repeat(100)));
    expect(await usage(member)).toBe(before + htmlBytes(first.html));
    const second = await saveSectionBody(appDb, member.context, projectId, nodes[2]!, bodyOf('第二节'));
    const replaced = await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('短'));
    expect(await usage(member)).toBe(before + htmlBytes(replaced.html) + htmlBytes(second.html));
    // 其他组织的正文不计入本组织。
    const other = await newPlan();
    await saveSectionBody(appDb, other.member.context, other.projectId, other.nodes[1]!, bodyOf('其他组织'));
    expect(await usage(member)).toBe(before + htmlBytes(replaced.html) + htmlBytes(second.html));

    await superuser.updateTable('projects').set({ deleted_at: new Date(Date.now() - 6 * 24 * 3600_000), deleted_by: member.userId }).where('id', '=', projectId).execute();
    expect(await usage(member)).toBe(before + htmlBytes(replaced.html) + htmlBytes(second.html));
    await superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).execute();
    await resetContentGeneration(appDb, member.context, projectId);
    expect(await usage(member)).toBe(before);

    const expired = await newPlan(member);
    const body = await saveSectionBody(appDb, member.context, expired.projectId, expired.nodes[1]!, bodyOf('过期项目'));
    expect(await usage(member)).toBe(before + htmlBytes(body.html));
    await superuser.updateTable('projects').set({ deleted_at: new Date(Date.now() - 8 * 24 * 3600_000), deleted_by: member.userId }).where('id', '=', expired.projectId).execute();
    expect(await usage(member)).toBe(before);
  });

  it('超出配额时写入或改大被拒绝（413 STORAGE_QUOTA_EXCEEDED），原正文不变；不变或改小照常写入', async () => {
    const { member, projectId, nodes } = await newPlan();
    const original = await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('字'.repeat(100)));
    await fillQuota(member, await newProject(member), 200n);
    const grow = (extra: number) => bodyOf('字'.repeat(100) + 'x'.repeat(extra));
    // 改大 300 字节（超过剩余的 200 字节）与新写一节都被拒绝。
    await expect(saveSectionBody(appDb, member.context, projectId, nodes[1]!, grow(300))).rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
    await expect(saveSectionBody(appDb, member.context, projectId, nodes[2]!, bodyOf('字'.repeat(100)))).rejects.toMatchObject({ statusCode: 413 });
    expect((await getSectionBody(appDb, member.context, projectId, nodes[1]!))?.html).toBe(original.html);
    // 绕过 Store 直接写库同样被触发器拒绝（TP047）。
    await expect(
      withTenant(appDb, member.context, (trx) => trx.updateTable('technical_plan_section_bodies').set({ html: grow(300) }).where('node_id', '=', nodes[1]!).execute()),
    ).rejects.toMatchObject({ code: 'TP047' });
    // 改大 100 字节（在剩余额度内）、不变、改小都可以。
    const grown = await saveSectionBody(appDb, member.context, projectId, nodes[1]!, grow(100));
    expect(await usage(member)).toBe(ORG_STORAGE_QUOTA_BYTES - 200n + htmlBytes(grown.html) - htmlBytes(original.html));
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, grow(100));
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('短'));
  });

  it('单节至多 2 MiB：Store 拒绝（422），绕过 Store 直接写库被 CHECK 拒绝；恰好 2 MiB 的正文可以写入', async () => {
    const { member, projectId, nodes } = await newPlan();
    const paragraph = (index: number, chars: number) => block(`<p id="p${index}">${'x'.repeat(chars)}</p>`);
    const big = Array.from({ length: 2200 }, (_, index) => paragraph(index, 1000)).join('\n');
    await expect(saveSectionBody(appDb, member.context, projectId, nodes[1]!, big)).rejects.toMatchObject({ statusCode: 422, issues: ['正文超过 2 MiB'] });
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('technical_plan_section_bodies').values({ org_id: member.orgId, project_id: projectId, node_id: nodes[1]!, html: 'x'.repeat(TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES + 1) }).execute(),
      ),
    ).rejects.toThrow(/check constraint/);
    // 规范化后恰好 2 MiB。
    const head = bodyOf('开头');
    const fill = TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(`\n\n${block('<p id="tail"></p>')}`, 'utf8');
    const exact = `${head}\n\n${block(`<p id="tail">${'y'.repeat(fill)}</p>`)}`;
    const saved = await saveSectionBody(appDb, member.context, projectId, nodes[1]!, exact);
    expect(Buffer.byteLength(saved.html, 'utf8')).toBe(TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES);
  });

  it('bidtools_storage 对正文表只有配额要用的 3 列 SELECT，对配图表没有任何权限；配额函数的属主仍是它', async () => {
    const columns = await sql<{ column_name: string; privilege_type: string }>`
      SELECT column_name, privilege_type FROM information_schema.column_privileges
      WHERE table_name = 'technical_plan_section_bodies' AND grantee = ${STORAGE_ROLE} ORDER BY column_name`.execute(superuser);
    expect(columns.rows).toEqual([
      { column_name: 'html', privilege_type: 'SELECT' },
      { column_name: 'org_id', privilege_type: 'SELECT' },
      { column_name: 'project_id', privilege_type: 'SELECT' },
    ]);
    for (const table of ['technical_plan_section_bodies', 'technical_plan_section_images']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const { rows } = await sql<{ ok: boolean }>`SELECT has_table_privilege(${STORAGE_ROLE}, ${`public.${table}`}, ${privilege}) AS ok`.execute(superuser);
        expect(rows[0]!.ok, `${table} ${privilege}`).toBe(false);
      }
    }
    const owner = await sql<{ owner: string; secdef: boolean }>`
      SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS secdef FROM pg_proc WHERE proname = 'files_org_usage_bytes'`.execute(superuser);
    expect(owner.rows).toEqual([{ owner: STORAGE_ROLE, secdef: true }]);
  });
});

// ---- 项目删除 ----

describe('项目删除', () => {
  it('超过恢复期：清理任务先删配图产物（配图行随之删除），再物理删除项目，正文随项目删除；恢复期内的项目不动', async () => {
    const { member, projectId, nodes } = await newPlan();
    const image = await newImage(member, projectId);
    await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('过期', [image]));
    const kept = await newPlan(member);
    const keptImage = await newImage(member, kept.projectId);
    await saveSectionBody(appDb, member.context, kept.projectId, kept.nodes[1]!, bodyOf('恢复期内', [keptImage]));
    await superuser.updateTable('projects').set({ deleted_at: new Date(Date.now() - 8 * 24 * 3600_000), deleted_by: member.userId }).where('id', '=', projectId).execute();
    await superuser.updateTable('projects').set({ deleted_at: new Date(Date.now() - 6 * 24 * 3600_000), deleted_by: member.userId }).where('id', '=', kept.projectId).execute();

    // 配图引用的产物挡住项目的物理删除：先删产物（清理任务删完对象后调用）。
    const purge = async () => (await sql<{ n: number }>`SELECT cleanup_delete_projects(1000) AS n`.execute(appDb)).rows[0]!.n;
    await purge();
    expect(await counts(projectId)).toEqual({ bodies: 1, images: 1 });
    const candidates = (await sql<{ id: string }>`SELECT id FROM cleanup_artifact_candidates(1000)`.execute(appDb)).rows.map((row) => row.id);
    expect(candidates).toContain(image);
    expect(candidates).not.toContain(keptImage);
    expect((await sql<{ ok: boolean }>`SELECT cleanup_delete_artifact(${image}::uuid) AS ok`.execute(appDb)).rows[0]!.ok).toBe(true);
    expect(await counts(projectId)).toEqual({ bodies: 1, images: 0 });
    expect(await purge()).toBeGreaterThanOrEqual(1);
    expect(await superuser.selectFrom('projects').select('id').where('id', '=', projectId).executeTakeFirst()).toBeUndefined();
    expect(await counts(projectId)).toEqual({ bodies: 0, images: 0 });
    // 恢复期内的项目、正文与配图都在。
    expect(await counts(kept.projectId)).toEqual({ bodies: 1, images: 1 });
    expect((await sql<{ ok: boolean }>`SELECT cleanup_delete_artifact(${keptImage}::uuid) AS ok`.execute(appDb)).rows[0]!.ok).toBe(false);
  });
});

// ---- 各清空入口 ----

describe('清空入口一并删除正文并替换配图', () => {
  async function filled() {
    const plan = await newPlan();
    const images = [await newImage(plan.member, plan.projectId), await newImage(plan.member, plan.projectId)];
    await saveSectionBody(appDb, plan.member.context, plan.projectId, plan.nodes[1]!, bodyOf('一', [images[0]!]));
    await saveSectionBody(appDb, plan.member.context, plan.projectId, plan.nodes[2]!, bodyOf('二', [images[1]!]));
    return { ...plan, images };
  }
  const allSuperseded = async (ids: string[]) => Promise.all(ids.map(superseded));

  it('重置正文阶段', async () => {
    const { member, projectId, images } = await filled();
    await resetContentGeneration(appDb, member.context, projectId);
    expect(await counts(projectId)).toEqual({ bodies: 0, images: 0 });
    expect(await allSuperseded(images)).toEqual([true, true]);
  });

  it('保存全局事实（清空正文阶段）', async () => {
    const { member, projectId, images } = await filled();
    await saveGlobalFacts(appDb, member.context, projectId, [{ id: 'team', title: '团队', content: '十人' }]);
    expect(await counts(projectId)).toEqual({ bodies: 0, images: 0 });
    expect(await allSuperseded(images)).toEqual([true, true]);
  });

  it('目录 sort / edit 不改正文；delete 删除的节点与 affectedNodeIds 中的节点删除正文，其余保留', async () => {
    const { member, projectId, nodes, images } = await filled();
    const outline = outlineOf(nodes);
    await saveOutline(appDb, member.context, projectId, { reason: 'edit', outlineData: { ...outline, outline: [{ ...outline.outline[0], title: '新标题' }, outline.outline[1]] } });
    await saveOutline(appDb, member.context, projectId, { reason: 'sort', outlineData: { ...outline, outline: [outline.outline[1], outline.outline[0]] } });
    expect(await counts(projectId)).toEqual({ bodies: 2, images: 2 });
    // 删除 1.2：其正文随之删除、配图被替换；1.1 保留。
    const withoutSecond = { ...outline, outline: [{ ...outline.outline[0], children: [outline.outline[0]!.children![0]] }, outline.outline[1]] };
    await saveOutline(appDb, member.context, projectId, { reason: 'delete', outlineData: withoutSecond, affectedNodeIds: [nodes[2]!] });
    expect(await counts(projectId)).toEqual({ bodies: 1, images: 1 });
    expect(await allSuperseded(images)).toEqual([false, true]);
    // add-child 时 affectedNodeIds 中的节点同样删除。
    await saveOutline(appDb, member.context, projectId, { reason: 'add-child', outlineData: outline, affectedNodeIds: [nodes[1]!] });
    expect(await counts(projectId)).toEqual({ bodies: 0, images: 0 });
    expect(await allSuperseded(images)).toEqual([true, true]);
  });

  it('不再是 ai-generate 叶子的节点（改为其他处理方式、叶子变成父节点）删除正文', async () => {
    const { member, projectId, nodes, images } = await filled();
    const changed = outlineOf(nodes, { 1: 'manual-fill' });
    await saveOutline(appDb, member.context, projectId, { reason: 'delete', outlineData: changed, affectedNodeIds: [] });
    expect(await counts(projectId)).toEqual({ bodies: 1, images: 1 });
    expect(await allSuperseded(images)).toEqual([true, false]);
    // 1.2 下加一个子节点：1.2 变成父节点。
    const child = randomUUID();
    const nested = outlineOf(nodes, { 1: 'manual-fill' });
    (nested.outline[0]!.children![1] as any).children = [{ id: child, title: '1.2.1', description: '', content_mode: 'ai-generate' }];
    await saveOutline(appDb, member.context, projectId, { reason: 'add-child', outlineData: nested, affectedNodeIds: [child] });
    expect(await counts(projectId)).toEqual({ bodies: 0, images: 0 });
    expect(await allSuperseded(images)).toEqual([true, true]);
  });

  it('目录 replace 与目录生成的结果清空全部正文', async () => {
    const first = await filled();
    await saveOutline(appDb, first.member.context, first.projectId, { reason: 'replace', outlineData: outlineOf(first.nodes) });
    expect(await counts(first.projectId)).toEqual({ bodies: 0, images: 0 });
    expect(await allSuperseded(first.images)).toEqual([true, true]);

    const second = await filled();
    await saveGeneratedOutline(appDb, second.member.context, second.projectId, { outlineData: outlineOf(second.nodes), wordControlSnapshot: null });
    expect(await counts(second.projectId)).toEqual({ bodies: 0, images: 0 });
    expect(await allSuperseded(second.images)).toEqual([true, true]);
  });

  it('清空技术方案', async () => {
    const { member, projectId, images } = await filled();
    await clearTechnicalPlan(appDb, member.context, projectId);
    expect(await counts(projectId)).toEqual({ bodies: 0, images: 0 });
    expect(await allSuperseded(images)).toEqual([true, true]);
  });
});

// ---- 接口（登录用到 Node 24 的 crypto.argon2，应用在本组用例中才创建） ----

describe('GET /api/projects/:projectId/technical-plan/chapters/:nodeId/body', () => {
  const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
    Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [key, 'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 }]),
  ) as unknown as AuthRateLimitSettings;
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(
      { ...testConfig, database: testDb.appConfig },
      { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} }, objectStore: memoryStore },
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  async function cookieOf(member: Member): Promise<string> {
    const hasher = await fastHasher();
    await superuser.updateTable('users').set({ password_hash: await hasher.hash(PASSWORD) }).where('id', '=', member.userId).execute();
    const email = (await superuser.selectFrom('users').select('email').where('id', '=', member.userId).executeTakeFirstOrThrow()).email;
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
    expect(response.statusCode, response.body).toBe(200);
    const header = response.headers['set-cookie'];
    return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
  }

  const get = (cookie: string | null, projectId: string, nodeId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/technical-plan/chapters/${nodeId}/body`,
      headers: { ...sameSiteHeaders, ...(cookie ? { cookie: `__Host-session=${cookie}` } : {}) },
    });

  it('返回规范化的正文与配图产物 id；没有正文 404；其他组织的项目 404；未登录 401；节点 id 不合法 400', async () => {
    const { member, projectId, nodes } = await newPlan();
    const image = await newImage(member, projectId);
    const saved = await saveSectionBody(appDb, member.context, projectId, nodes[1]!, bodyOf('正文', [image]));
    const cookie = await cookieOf(member);
    const response = await get(cookie, projectId, nodes[1]!);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ nodeId: nodes[1], html: saved.html, imageArtifactIds: [image], updatedAt: saved.updatedAt.toISOString() });

    const missing = await get(cookie, projectId, nodes[2]!);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('TECHNICAL_PLAN_SECTION_BODY_NOT_FOUND');

    const stranger = await newMember();
    expect((await get(await cookieOf(stranger), projectId, nodes[1]!)).statusCode).toBe(404);
    expect((await get(null, projectId, nodes[1]!)).statusCode).toBe(401);
    expect((await get(cookie, projectId, 'not-a-uuid')).statusCode).toBe(400);
    // 同组织的其他成员可读（与技术方案的其他内容相同）。
    const colleague = await newMember(member.orgId);
    expect((await get(await cookieOf(colleague), projectId, nodes[1]!)).statusCode).toBe(200);
  });
});
