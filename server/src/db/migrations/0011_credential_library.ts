// 资信库（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.5）：取代桌面版 SQLite 的 credential_library_* 六张表。
// 资信库是组织级的“跨项目复用的素材”，组织内成员都可以查看和编辑（组织内共享，第 9 节第 2 项）。
//
// - credential_library_profile：企业基础信息、介绍、财务、开户行和水印配置，每个组织一行（主键 org_id，取代桌面版的 id = 1）；
// - credential_library_certificates / _employees / _projects / _other_materials：其他证书、人员、业绩、其他资料；
// - credential_library_images：图片的归属。原图是上传用途为 credential-image 的文件（files），本表只记 file_id，
//   取代桌面版的 relative_path；内容经 /api/files/:fileId/content 读取。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；created_by / updated_by 必须是当前用户；
//   org_id、created_by 和图片的归属列没有列级 UPDATE 授权，写入后不能改挂；
// - 图片只能挂本组织已上传、未删除、不属于任何项目的 credential-image 文件（INSERT 策略，files 自身的策略在子查询中同样生效），
//   每个文件只能挂一次；归属记录由复合外键 (org_id, <记录 id>) 保证属于本组织；归属类型与图片栏目由 CHECK 约束绑定；
// - 删除可见性：图片随文件的生命周期，所引用的文件已删除（进入回收站）时图片查不到、改不了，恢复文件即一起恢复；
//   应用角色没有图片的 DELETE 授权，删除图片就是删除文件。文件被清理任务物理删除时图片行随之级联删除；
// - 记录（证书、人员、业绩、其他资料）与桌面版相同物理删除，其图片行由外键级联删除；企业信息不授予 DELETE；
// - 每个组织每类记录最多 1000 条、图片最多 5000 张（触发器 credential_library_guard，CL001）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 单行文本（名称、编号、日期等）与长文本（介绍、经营范围、备注）的字数上限。 */
export const CREDENTIAL_SHORT_TEXT_MAX = 500;
export const CREDENTIAL_LONG_TEXT_MAX = 20_000;
/** 图片自定义名称的字数上限。 */
export const CREDENTIAL_IMAGE_NAME_MAX = 200;
/** 每个组织每类记录的条数上限、图片的张数上限。 */
export const CREDENTIAL_RECORDS_PER_ORG_MAX = 1000;
export const CREDENTIAL_IMAGES_PER_ORG_MAX = 5000;

export const CREDENTIAL_VALIDITY_MODES = ['', 'range', 'long-term'] as const;
export const CREDENTIAL_PROJECT_TYPES = ['', 'service', 'goods', 'construction'] as const;

/** 各归属类型允许的图片栏目，与桌面版 credentialLibraryService.cjs 的 importImageFieldKeys 相同。 */
export const CREDENTIAL_IMAGE_FIELDS = {
  profile: [
    'officeEnvironment',
    'businessLicense',
    'legalRepresentativeIdEmblem',
    'legalRepresentativeIdPortrait',
    'legalRepresentativeAuthorization',
    'authorizedRepresentativeIdEmblem',
    'authorizedRepresentativeIdPortrait',
    'basicDepositAccountInfo',
    'creditChinaReport',
    'governmentProcurementRecord',
    'enterpriseCreditReport',
    'dishonestEnforcementQuery',
    'taxCertificate',
    'auditReport',
    'socialSecurityCertificate',
    'bankAccountLicense',
  ],
  certificate: ['certificateImages'],
  employee: ['employeeSocialSecurity', 'employeeIdEmblem', 'employeeIdPortrait', 'laborContract', 'educationCertificate', 'driverLicense', 'skillCertificate'],
  project: ['projectContract', 'bidWinningNotice', 'projectAcceptanceCertificate', 'paymentInvoice'],
  other: ['otherMaterialImages'],
} as const;
export type CredentialOwnerType = keyof typeof CREDENTIAL_IMAGE_FIELDS;
export const CREDENTIAL_OWNER_TYPES = Object.keys(CREDENTIAL_IMAGE_FIELDS) as CredentialOwnerType[];

type TextKind = 'short' | 'long';

/** 各表的文本列（列名 → 长度类别），顺序即桌面版的列顺序。 */
export const CREDENTIAL_PROFILE_TEXT_COLUMNS = {
  company_name: 'short',
  unified_social_credit_code: 'short',
  phone: 'short',
  email: 'short',
  legal_representative: 'short',
  registered_capital: 'short',
  operating_period_start: 'short',
  operating_period_end: 'short',
  address: 'short',
  business_scope: 'long',
  industry: 'short',
  company_type: 'short',
  insured_employee_count: 'short',
  company_intro: 'long',
  tax_certificate_date: 'short',
  tax_certificate_note: 'long',
  audit_report_date: 'short',
  audit_report_note: 'long',
  social_security_certificate_date: 'short',
  social_security_certificate_note: 'long',
  bank_account_name: 'short',
  bank_account_number: 'short',
  bank_name: 'short',
  bank_routing_number: 'short',
  watermark_content: 'short',
} as const satisfies Record<string, TextKind>;

export const CREDENTIAL_RECORD_TABLES = {
  certificate: {
    table: 'credential_library_certificates',
    imageColumn: 'certificate_id',
    textColumns: { name: 'short', number: 'short', validity_mode: 'short', valid_from: 'short', valid_to: 'short' },
  },
  employee: {
    table: 'credential_library_employees',
    imageColumn: 'employee_id',
    textColumns: {
      name: 'short',
      id_number: 'short',
      position: 'short',
      professional_title: 'short',
      gender: 'short',
      phone: 'short',
      id_validity_mode: 'short',
      id_valid_from: 'short',
      id_valid_to: 'short',
      education: 'short',
      school: 'short',
      major: 'short',
      introduction: 'long',
    },
  },
  project: {
    table: 'credential_library_projects',
    // 不叫 project_id：与项目级表的 project_id（→ projects）区分，资信库的业绩不是项目。
    imageColumn: 'credential_project_id',
    textColumns: {
      project_name: 'short',
      project_number: 'short',
      customer_name: 'short',
      project_type: 'short',
      project_manager: 'short',
      contract_amount: 'short',
      start_date: 'short',
      end_date: 'short',
      project_status: 'short',
      introduction: 'long',
    },
  },
  other: {
    table: 'credential_library_other_materials',
    imageColumn: 'material_id',
    textColumns: { name: 'short', note: 'long' },
  },
} as const satisfies Record<Exclude<CredentialOwnerType, 'profile'>, { table: string; imageColumn: string; textColumns: Record<string, TextKind> }>;

const RECORD_TYPES = Object.keys(CREDENTIAL_RECORD_TABLES) as (keyof typeof CREDENTIAL_RECORD_TABLES)[];

function textColumns(columns: Record<string, TextKind>): RawBuilder<unknown> {
  return sql.join(
    Object.entries(columns).map(
      ([column, kind]) =>
        sql`${sql.id(column)} text NOT NULL DEFAULT '' CHECK (char_length(${sql.id(column)}) <= ${sql.lit(
          kind === 'long' ? CREDENTIAL_LONG_TEXT_MAX : CREDENTIAL_SHORT_TEXT_MAX,
        )})`,
    ),
  );
}

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

// 归属类型决定哪一个归属列有值（企业信息的图片四列都为空），以及允许的图片栏目。
const IMAGE_OWNER_SHAPE = sql.join(
  CREDENTIAL_OWNER_TYPES.map((ownerType) => {
    const set = RECORD_TYPES.map((type) =>
      type === ownerType
        ? sql`${sql.id(CREDENTIAL_RECORD_TABLES[type].imageColumn)} IS NOT NULL`
        : sql`${sql.id(CREDENTIAL_RECORD_TABLES[type].imageColumn)} IS NULL`,
    );
    return sql`(owner_type = ${sql.lit(ownerType)} AND field_key IN (${list(CREDENTIAL_IMAGE_FIELDS[ownerType])}) AND ${sql.join(set, sql` AND `)})`;
  }),
  sql` OR `,
);

// 图片所引用的文件已上传、未删除（files 的策略在子查询中同样生效：只看得到本组织、所属项目未删除的文件）。
const IMAGE_FILE_LIVE = sql`EXISTS (
  SELECT 1 FROM files f WHERE f.id = credential_library_images.file_id AND f.status = 'uploaded' AND f.deleted_at IS NULL)`;
// 新挂的图片另要求文件用途是资信库图片、不属于任何项目（资信库是组织级的）。
const IMAGE_FILE_ATTACHABLE = sql`EXISTS (
  SELECT 1 FROM files f WHERE f.id = credential_library_images.file_id AND f.status = 'uploaded' AND f.deleted_at IS NULL
    AND f.purpose = 'credential-image' AND f.project_id IS NULL)`;

const TENANT = sql`org_id = app_current_org_id()`;
const WRITER = sql`updated_by = app_current_user_id()`;

function recordTable(type: keyof typeof CREDENTIAL_RECORD_TABLES): RawBuilder<unknown>[] {
  const { table, textColumns: columns } = CREDENTIAL_RECORD_TABLES[type];
  const t = sql.id(table);
  const checks: RawBuilder<unknown>[] = [];
  if (type === 'certificate') checks.push(sql`, CHECK (validity_mode IN (${list(CREDENTIAL_VALIDITY_MODES)}))`);
  if (type === 'employee') checks.push(sql`, CHECK (id_validity_mode IN (${list(CREDENTIAL_VALIDITY_MODES)}))`);
  if (type === 'project') checks.push(sql`, CHECK (project_type IN (${list(CREDENTIAL_PROJECT_TYPES)}))`);
  return [
    // created_by / updated_by 不设外键，与 projects.created_by 相同，不随用户删除而改动。
    sql`CREATE TABLE ${t} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          ${textColumns(columns)},
          created_by uuid NOT NULL,
          updated_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT ${sql.id(`${table}_org_id_id_key`)} UNIQUE (org_id, id)
          ${sql.join(checks, sql``)}
        )`,
    sql`CREATE INDEX ${sql.id(`${table}_org_id_updated_at_idx`)} ON ${t} (org_id, updated_at DESC)`,
    sql`CREATE TRIGGER ${sql.id(`${table}_touch`)} BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,
    sql`CREATE TRIGGER ${sql.id(`${table}_guard`)} BEFORE INSERT ON ${t}
          FOR EACH ROW EXECUTE FUNCTION credential_library_guard(${sql.lit(String(CREDENTIAL_RECORDS_PER_ORG_MAX))})`,
    sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY ${sql.id(`${table}_select_tenant`)} ON ${t} FOR SELECT TO ${app} USING (${TENANT})`,
    sql`CREATE POLICY ${sql.id(`${table}_insert_tenant`)} ON ${t} FOR INSERT TO ${app}
          WITH CHECK (${TENANT} AND created_by = app_current_user_id() AND ${WRITER})`,
    sql`CREATE POLICY ${sql.id(`${table}_update_tenant`)} ON ${t} FOR UPDATE TO ${app}
          USING (${TENANT}) WITH CHECK (${TENANT} AND ${WRITER})`,
    sql`CREATE POLICY ${sql.id(`${table}_delete_tenant`)} ON ${t} FOR DELETE TO ${app} USING (${TENANT})`,
    sql`GRANT SELECT, DELETE ON ${t} TO ${app}`,
    sql`GRANT INSERT (org_id, ${sql.join(Object.keys(columns).map((column) => sql.id(column)))}, created_by, updated_by) ON ${t} TO ${app}`,
    sql`GRANT UPDATE (${sql.join(Object.keys(columns).map((column) => sql.id(column)))}, updated_by) ON ${t} TO ${app}`,
  ];
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const profileColumns = Object.keys(CREDENTIAL_PROFILE_TEXT_COLUMNS).map((column) => sql.id(column));
  await run(db, [
    // 以调用者身份执行：应用角色在 RLS 下正好数到本组织（图片只数到文件仍可用的）。上限由触发器参数给出。
    // 同一组织同一张表的插入用事务级 advisory lock 串行，并发写入不会一起越过上限。
    sql`CREATE FUNCTION credential_library_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_count bigint;
          BEGIN
            PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(TG_TABLE_NAME || ':' || NEW.org_id::text, 0));
            EXECUTE format('SELECT count(*) FROM %I.%I WHERE org_id = $1', TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO v_count USING NEW.org_id;
            IF v_count >= TG_ARGV[0]::bigint THEN
              RAISE EXCEPTION 'too many rows in %', TG_TABLE_NAME USING ERRCODE = 'CL001';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION credential_library_guard() FROM PUBLIC`,

    sql`CREATE TABLE credential_library_profile (
          org_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
          ${textColumns(CREDENTIAL_PROFILE_TEXT_COLUMNS)},
          watermark_enabled boolean NOT NULL DEFAULT false,
          updated_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`,
    sql`CREATE TRIGGER credential_library_profile_touch BEFORE UPDATE ON credential_library_profile
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,
    sql`ALTER TABLE credential_library_profile ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE credential_library_profile FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY credential_library_profile_select_tenant ON credential_library_profile FOR SELECT TO ${app} USING (${TENANT})`,
    sql`CREATE POLICY credential_library_profile_insert_tenant ON credential_library_profile FOR INSERT TO ${app}
          WITH CHECK (${TENANT} AND ${WRITER})`,
    sql`CREATE POLICY credential_library_profile_update_tenant ON credential_library_profile FOR UPDATE TO ${app}
          USING (${TENANT}) WITH CHECK (${TENANT} AND ${WRITER})`,
    sql`GRANT SELECT ON credential_library_profile TO ${app}`,
    sql`GRANT INSERT (org_id, ${sql.join(profileColumns)}, watermark_enabled, updated_by) ON credential_library_profile TO ${app}`,
    sql`GRANT UPDATE (${sql.join(profileColumns)}, watermark_enabled, updated_by) ON credential_library_profile TO ${app}`,

    ...RECORD_TYPES.flatMap(recordTable),

    // 归属列各自以复合外键指向本组织的记录，记录删除时图片行级联删除；file_id 同样以复合外键指向本组织的文件，
    // 文件被清理任务物理删除时图片行级联删除（图片行本身不引用对象存储，没有孤儿对象）。
    sql`CREATE TABLE credential_library_images (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          owner_type text NOT NULL,
          ${sql.join(RECORD_TYPES.map((type) => sql`${sql.id(CREDENTIAL_RECORD_TABLES[type].imageColumn)} uuid`))},
          field_key text NOT NULL,
          file_id uuid NOT NULL,
          custom_name text NOT NULL DEFAULT '' CHECK (char_length(custom_name) <= ${sql.lit(CREDENTIAL_IMAGE_NAME_MAX)}),
          sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT credential_library_images_file_id_key UNIQUE (file_id),
          CONSTRAINT credential_library_images_file_fkey FOREIGN KEY (org_id, file_id) REFERENCES files (org_id, id) ON DELETE CASCADE,
          ${sql.join(
            RECORD_TYPES.map((type) => {
              const { table, imageColumn } = CREDENTIAL_RECORD_TABLES[type];
              return sql`CONSTRAINT ${sql.id(`credential_library_images_${imageColumn}_fkey`)} FOREIGN KEY (org_id, ${sql.id(imageColumn)})
                REFERENCES ${sql.id(table)} (org_id, id) ON DELETE CASCADE`;
            }),
          )},
          CONSTRAINT credential_library_images_owner_shape CHECK (${IMAGE_OWNER_SHAPE})
        )`,
    sql`CREATE INDEX credential_library_images_org_id_owner_idx ON credential_library_images (org_id, owner_type, field_key, sort_order)`,
    ...RECORD_TYPES.map((type) => {
      const column = CREDENTIAL_RECORD_TABLES[type].imageColumn;
      return sql`CREATE INDEX ${sql.id(`credential_library_images_${column}_idx`)} ON credential_library_images (org_id, ${sql.id(column)})
        WHERE ${sql.id(column)} IS NOT NULL`;
    }),
    sql`CREATE TRIGGER credential_library_images_guard BEFORE INSERT ON credential_library_images
          FOR EACH ROW EXECUTE FUNCTION credential_library_guard(${sql.lit(String(CREDENTIAL_IMAGES_PER_ORG_MAX))})`,
    sql`ALTER TABLE credential_library_images ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE credential_library_images FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY credential_library_images_select_tenant ON credential_library_images FOR SELECT TO ${app}
          USING (${TENANT} AND ${IMAGE_FILE_LIVE})`,
    sql`CREATE POLICY credential_library_images_insert_tenant ON credential_library_images FOR INSERT TO ${app}
          WITH CHECK (${TENANT} AND created_by = app_current_user_id() AND ${IMAGE_FILE_ATTACHABLE})`,
    sql`CREATE POLICY credential_library_images_update_tenant ON credential_library_images FOR UPDATE TO ${app}
          USING (${TENANT} AND ${IMAGE_FILE_LIVE}) WITH CHECK (${TENANT})`,
    // 不授予 DELETE：删除图片即软删除其文件（见文件头）。
    sql`GRANT SELECT ON credential_library_images TO ${app}`,
    sql`GRANT INSERT (org_id, owner_type, ${sql.join(
      RECORD_TYPES.map((type) => sql.id(CREDENTIAL_RECORD_TABLES[type].imageColumn)),
    )}, field_key, file_id, custom_name, sort_order, created_by) ON credential_library_images TO ${app}`,
    sql`GRANT UPDATE (custom_name, sort_order) ON credential_library_images TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE credential_library_images`,
    ...RECORD_TYPES.map((type) => sql`DROP TABLE ${sql.id(CREDENTIAL_RECORD_TABLES[type].table)}`),
    sql`DROP TABLE credential_library_profile`,
    sql`DROP FUNCTION credential_library_guard()`,
  ]);
}
