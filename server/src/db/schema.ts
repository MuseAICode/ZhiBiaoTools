// Kysely 的表类型，与 migrations/ 中的 DDL 手工保持一致。
import type { ColumnType, Generated } from 'kysely';
import type { ArtifactKind } from '../artifacts/store.ts';
import type { FilePurpose } from '../files/policy.ts';
import type {
  CREDENTIAL_PROFILE_TEXT_COLUMNS,
  CREDENTIAL_RECORD_TABLES,
  CredentialOwnerType,
} from './migrations/0011_credential_library.ts';
import type {
  KNOWLEDGE_DOCUMENT_STATUSES,
  KNOWLEDGE_STEP_KEYS,
  KNOWLEDGE_STEP_STATUSES,
} from './migrations/0012_knowledge_base.ts';
import type { KNOWLEDGE_DISCARD_SOURCES } from './migrations/0013_knowledge_base_items.ts';
import type {
  DUPLICATE_CHECK_FILE_ROLES,
  DUPLICATE_CHECK_GROUP_TYPES,
  DUPLICATE_CHECK_OUTLINE_SOURCES,
  DUPLICATE_CHECK_RISKS,
  DUPLICATE_CHECK_SECTIONS,
  DUPLICATE_CHECK_STATUSES,
  DUPLICATE_CHECK_STEPS,
} from './migrations/0014_duplicate_check.ts';
import type {
  REJECTION_CHECK_DOCUMENT_ROLES,
  REJECTION_CHECK_DOCUMENT_STATUSES,
  REJECTION_CHECK_EXTRACTION_SOURCES,
  REJECTION_CHECK_FINDING_TYPES,
  REJECTION_CHECK_RESULT_TABS,
  REJECTION_CHECK_RESULT_TYPES,
  REJECTION_CHECK_RUN_STATUSES,
  REJECTION_CHECK_SEVERITIES,
  REJECTION_CHECK_STEPS,
} from './migrations/0016_rejection_check.ts';
import type {
  FEASIBILITY_OUTLINE_TEMPLATES,
  FEASIBILITY_PROJECT_TYPES,
  FEASIBILITY_REPORT_STEPS,
  FEASIBILITY_SOURCE_STATUSES,
} from './migrations/0017_feasibility_report.ts';
import type {
  TECHNICAL_PLAN_BID_ANALYSIS_MODES,
  TECHNICAL_PLAN_BID_ITEM_IDS,
  TECHNICAL_PLAN_BID_SECTION_MODES,
  TECHNICAL_PLAN_DOCUMENT_ROLES,
  TECHNICAL_PLAN_DOCUMENT_STATUSES,
  TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES,
  TECHNICAL_PLAN_GLOBAL_FACTS_MODES,
  TECHNICAL_PLAN_IMAGE_QUANTITIES,
  TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES,
  TECHNICAL_PLAN_OUTLINE_MODES,
  TECHNICAL_PLAN_RUN_STATUSES,
  TECHNICAL_PLAN_STEPS,
  TECHNICAL_PLAN_TABLE_REQUIREMENTS,
} from './migrations/0018_technical_plan.ts';
import type { TECHNICAL_PLAN_CONTENT_MODES } from './migrations/0019_technical_plan_outline.ts';
import type { JOB_EVENT_KINDS, JOB_STATUSES } from './migrations/0021_jobs.ts';
import type { AGENT_BUDGET_EXHAUSTED_REASONS } from './migrations/0033_agent_job_budgets.ts';
import type { AGENT_QUESTION_STATUSES } from './migrations/0039_agent_questions.ts';
import type { AGENT_MODEL_REJECTION_REASONS } from './migrations/0043_agent_model_rejections.ts';
import type { JOB_PAUSE_REASONS } from './migrations/0044_job_pause_selection.ts';
import type { ProjectKind } from '../projects/store.ts';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

export const ORGANIZATION_KINDS = ['personal', 'team'] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** sms_login 为第二版短信登录预留（docs/SERVER_DESIGN.md 第 3.1 节）。 */
export const AUTH_TOKEN_KINDS = ['email_verification', 'password_reset', 'sms_login'] as const;
export type AuthTokenKind = (typeof AUTH_TOKEN_KINDS)[number];

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  kind: OrganizationKind;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface UsersTable {
  id: Generated<string>;
  /** 小写归一化后存储。 */
  email: string;
  password_hash: string;
  email_verified_at: Timestamp | null;
  /** E.164 格式，第一版不写入。 */
  phone: string | null;
  phone_verified_at: Timestamp | null;
  status: ColumnType<UserStatus, UserStatus | undefined, UserStatus>;
  is_platform_admin: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface OrgMembershipsTable {
  org_id: string;
  user_id: string;
  role: MemberRole;
  created_at: CreatedAt;
}

export interface SessionsTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  /** SHA-256(令牌)，32 字节。 */
  token_hash: Buffer;
  created_at: CreatedAt;
  last_seen_at: ColumnType<Date, Date | string | undefined, Date | string>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  user_agent: string | null;
  ip_summary: string | null;
}

export interface AuthTokensTable {
  id: Generated<string>;
  user_id: string;
  kind: AuthTokenKind;
  token_hash: Buffer;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  attempt_count: ColumnType<number, number | undefined, number>;
  created_at: CreatedAt;
}

export interface InvitationsTable {
  id: Generated<string>;
  /** 受邀邮箱，小写归一化。 */
  email: string;
  /** SHA-256(邀请令牌)，32 字节。 */
  token_hash: Buffer;
  invited_by: string;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  consumed_by: string | null;
  created_at: CreatedAt;
}

/** 计费相关的服务商（docs/SERVER_DESIGN.md 第 10 节）。新增服务商需要新迁移放宽 CHECK 约束。 */
export const BILLING_PROVIDERS = ['deepseek', 'qwen'] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export const LEDGER_ENTRY_TYPES = ['recharge', 'grant', 'charge', 'reversal'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** PostgreSQL bigint：pg 驱动读出为十进制字符串（不转成 number，避免超过 2^53 时丢精度），由 src/billing/ 转成 BigInt。 */
type Int8 = ColumnType<string, never, never>;

/** 只读：余额只能经账本触发器修改（迁移 0003_billing）。 */
export interface OrgBalancesTable {
  org_id: ColumnType<string, never, never>;
  balance: Int8;
  updated_at: ColumnType<Date, never, never>;
}

/** 只追加：应用角色只能插入扣费，且只能写用量列；其余列由触发器填写。 */
export interface BillingLedgerTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  entry_type: ColumnType<LedgerEntryType, 'charge', never>;
  amount: Int8;
  balance_after: Int8;
  request_id: ColumnType<string | null, string, never>;
  provider: ColumnType<BillingProvider | null, BillingProvider, never>;
  model: ColumnType<string | null, string, never>;
  input_tokens: ColumnType<string | null, number, never>;
  output_tokens: ColumnType<string | null, number, never>;
  price_id: ColumnType<string | null, never, never>;
  reference: ColumnType<string | null, never, never>;
  note: ColumnType<string | null, never, never>;
  operator_user_id: ColumnType<string | null, never, never>;
  related_entry_id: ColumnType<string | null, never, never>;
  /** 结算冻结时由 ai_usage_settle 写入（迁移 0004_ai_gateway），应用角色不能写。 */
  usage_id: ColumnType<string | null, never, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * 只读：新增价格版本经 billing_admin_add_price。org_id 为空是平台默认价。
 * 上游成本单价（upstream_*_price_per_mtok，迁移 0004_ai_gateway）对应用角色不可见，不在此声明。
 */
export interface ModelPricesTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string | null, never, never>;
  provider: ColumnType<BillingProvider, never, never>;
  model: ColumnType<string, never, never>;
  input_price_per_mtok: Int8;
  output_price_per_mtok: Int8;
  effective_from: ColumnType<Date, never, never>;
  created_by: ColumnType<string, never, never>;
  note: ColumnType<string | null, never, never>;
  created_at: ColumnType<Date, never, never>;
}

export const USAGE_SOURCES = ['interactive', 'job'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const USAGE_STATUSES = ['pending', 'billed', 'unbilled'] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

/**
 * 只读：每次模型调用一行，status = 'pending' 的行同时是该调用的冻结（迁移 0004_ai_gateway）。
 * 写入只能经 ai_usage_begin / settle / fail；upstream_cost 对应用角色不可见，不在此声明。
 */
export interface UsageRecordsTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, never, never>;
  user_id: ColumnType<string, never, never>;
  request_id: ColumnType<string, never, never>;
  source: ColumnType<UsageSource, never, never>;
  job_id: ColumnType<string | null, never, never>;
  job_type: ColumnType<string | null, never, never>;
  provider: ColumnType<BillingProvider, never, never>;
  model: ColumnType<string, never, never>;
  price_id: ColumnType<string, never, never>;
  estimated_input_tokens: Int8;
  max_output_tokens: Int8;
  hold_amount: Int8;
  hold_expires_at: ColumnType<Date, never, never>;
  status: ColumnType<UsageStatus, never, never>;
  failure_reason: ColumnType<string | null, never, never>;
  input_tokens: ColumnType<string | null, never, never>;
  cached_input_tokens: ColumnType<string | null, never, never>;
  output_tokens: ColumnType<string | null, never, never>;
  usage_source: ColumnType<'provider' | 'estimated' | null, never, never>;
  amount: Int8;
  ledger_entry_id: ColumnType<string | null, never, never>;
  started_at: ColumnType<Date, never, never>;
  finished_at: ColumnType<Date | null, never, never>;
}

export const CREDENTIAL_KINDS = ['text_model'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** 只读：平台凭据的密文（迁移 0004_ai_gateway），写入经 ai_admin_put_credential，解密只在 src/ai/gateway.ts。 */
export interface ProviderCredentialsTable {
  id: ColumnType<string, never, never>;
  kind: ColumnType<CredentialKind, never, never>;
  provider: ColumnType<BillingProvider, never, never>;
  base_url: ColumnType<string, never, never>;
  ciphertext: ColumnType<Buffer, never, never>;
  iv: ColumnType<Buffer, never, never>;
  auth_tag: ColumnType<Buffer, never, never>;
  wrapped_dek: ColumnType<Buffer, never, never>;
  kek_version: ColumnType<number, never, never>;
  last4: ColumnType<string, never, never>;
  created_by: ColumnType<string, never, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * 只读：平台模型白名单（迁移 0005_platform_models）。只有登记且启用、并有生效价格的服务商 + 模型才能调用；
 * is_free 为 true 的模型生效价格必须为 0 / 0，为 false 时零价格视为未定价。写入经 ai_admin_register_model /
 * ai_admin_set_model_enabled。
 */
export interface PlatformModelsTable {
  id: ColumnType<string, never, never>;
  provider: ColumnType<BillingProvider, never, never>;
  model: ColumnType<string, never, never>;
  is_free: ColumnType<boolean, never, never>;
  enabled: ColumnType<boolean, never, never>;
  note: ColumnType<string | null, never, never>;
  created_by: ColumnType<string, never, never>;
  created_at: ColumnType<Date, never, never>;
  updated_by: ColumnType<string, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export const FILE_STATUSES = ['uploading', 'uploaded'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * 上传文件的元数据（迁移 0006_files）。storage_key 是生成列 'org/{org_id}/files/{id}'，不能写入；
 * 应用角色只能写入列级授权的列，配额和状态转换由触发器 files_guard 检查。
 */
export interface FilesTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  storage_key: ColumnType<string, never, never>;
  purpose: ColumnType<FilePurpose, FilePurpose, never>;
  display_name: ColumnType<string, string, never>;
  extension: ColumnType<string, string, never>;
  status: ColumnType<FileStatus, never, FileStatus>;
  mime: ColumnType<string | null, never, string>;
  /** bigint，pg 返回字符串。 */
  size_bytes: ColumnType<string | null, never, number>;
  sha256: ColumnType<Buffer | null, never, Buffer>;
  created_by: ColumnType<string, string, never>;
  created_at: ColumnType<Date, never, never>;
  uploaded_at: ColumnType<Date | null, never, never>;
  deleted_at: ColumnType<Date | null, never, Date | string | null>;
  deleted_by: ColumnType<string | null, never, string | null>;
  /** 所属项目（迁移 0007_projects），可空；复合外键 (org_id, project_id) 保证只能是本组织的项目。 */
  project_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * 项目（迁移 0007_projects）。kind、created_by 建好后不能改；只能软删除，updated_at 由触发器 projects_guard 维护。
 */
export interface ProjectsTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  kind: ColumnType<ProjectKind, ProjectKind, never>;
  name: ColumnType<string, string, string>;
  created_by: ColumnType<string, string, never>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
  deleted_at: ColumnType<Date | null, never, Date | string | null>;
  deleted_by: ColumnType<string | null, never, string | null>;
}

export const ARTIFACT_STATUSES = ['writing', 'ready'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/**
 * 生成产物的元数据（迁移 0008_artifacts）。storage_key 是生成列 'org/{org_id}/artifacts/{id}'，不能写入；
 * project_id、source_file_id 至少有一个，写入后不能改；完成（ready）后内容不能改，配额由触发器 artifacts_guard 检查。
 */
export interface ArtifactsTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  project_id: ColumnType<string | null, string | null | undefined, never>;
  source_file_id: ColumnType<string | null, string | null | undefined, never>;
  storage_key: ColumnType<string, never, never>;
  kind: ColumnType<ArtifactKind, ArtifactKind, never>;
  name: ColumnType<string, string, never>;
  mime: ColumnType<string, string, never>;
  status: ColumnType<ArtifactStatus, never, ArtifactStatus>;
  /** bigint，pg 返回字符串。 */
  size_bytes: ColumnType<string | null, never, number>;
  sha256: ColumnType<Buffer | null, never, Buffer>;
  created_by: ColumnType<string, string, never>;
  created_at: ColumnType<Date, never, never>;
  completed_at: ColumnType<Date | null, never, never>;
  /** 重新解析后被替换的时间（迁移 0023，触发器写入 now()）；之后由清理任务删除。 */
  superseded_at: ColumnType<Date | null, never, Date>;
  /** 样张输入的哈希（迁移 0027）：只有 template-preview 有，用于在组织内复用最近的结果。 */
  preview_sha256: ColumnType<Buffer | null, Buffer | null | undefined, never>;
}

/**
 * 样张请求（迁移 0027_template_preview）：校验、规范化之后的样张 HTML 与配置，任务参数只放 id。强制 RLS，应用角色只能看到、
 * 写入本组织中自己创建的请求；内容写入后不能改，artifact_id 只能由空设为一个值一次（TP001），completed_at 由触发器写入；
 * 创建 24 小时后由清理任务删除。
 */
export interface TemplatePreviewRequestsTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  created_by: ColumnType<string, string, never>;
  input_sha256: ColumnType<Buffer, Buffer, never>;
  html: ColumnType<string, string, never>;
  /** jsonb 对象（规范化后的 export_format），写入时传 JSON 文本。 */
  export_format: ColumnType<Record<string, unknown>, string, never>;
  artifact_id: ColumnType<string | null, never, string>;
  created_at: ColumnType<Date, never, never>;
  completed_at: ColumnType<Date | null, never, never>;
}

/**
 * 技术方案整本导出的请求（迁移 0029_technical_plan_export_requests）：入队时的快照与导出结果，挂在技术方案项目下，
 * 在本组织内可见。唯一的 UPDATE 是完成（写入结果、清空 outline），完成时间由触发器写入，之后不能再改（TX001）。
 */
export interface TechnicalPlanExportRequestsTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  project_id: ColumnType<string, string, never>;
  created_by: ColumnType<string, string, never>;
  project_name: ColumnType<string | null, string | null, never>;
  export_template_scope: ColumnType<TechnicalPlanExportTemplateScope, TechnicalPlanExportTemplateScope, never>;
  /** jsonb 对象（规范化后的 export_format），写入时传 JSON 文本。 */
  export_format: ColumnType<Record<string, unknown>, string, never>;
  /** jsonb 数组（快照中的目录），写入时传 JSON 文本；完成时清空。 */
  outline: ColumnType<unknown[] | null, string, null>;
  artifact_id: ColumnType<string | null, never, string>;
  /** jsonb 字符串数组，写入时传 JSON 文本。 */
  warnings: ColumnType<string[] | null, never, string>;
  message: ColumnType<string | null, never, string>;
  created_at: ColumnType<Date, never, never>;
  completed_at: ColumnType<Date | null, never, never>;
}

/**
 * 可研报告导出 Word 的请求（迁移 0030_feasibility_report_export）：入队时的快照与导出结果，挂在可研报告项目下，
 * 在本组织内可见。唯一的 UPDATE 是完成（写入结果、清空 outline），完成时间由触发器写入，之后不能再改（FX001）。
 */
export interface FeasibilityReportExportRequestsTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  project_id: ColumnType<string, string, never>;
  created_by: ColumnType<string, string, never>;
  project_name: ColumnType<string | null, string | null, never>;
  /** jsonb 对象（规范化后的 export_format），写入时传 JSON 文本。 */
  export_format: ColumnType<Record<string, unknown>, string, never>;
  /** jsonb 对象（导出选项与项目信息），写入时传 JSON 文本。 */
  options: ColumnType<Record<string, unknown>, string, never>;
  /** jsonb 数组（快照中的目录），写入时传 JSON 文本；完成时清空。 */
  outline: ColumnType<unknown[] | null, string, null>;
  artifact_id: ColumnType<string | null, never, string>;
  /** jsonb 字符串数组，写入时传 JSON 文本。 */
  warnings: ColumnType<string[] | null, never, string>;
  message: ColumnType<string | null, never, string>;
  created_at: ColumnType<Date, never, never>;
  completed_at: ColumnType<Date | null, never, never>;
}

/**
 * 组织设置（迁移 0009_settings），每个组织一行。所有成员可读，只有 owner / admin 能写（RLS）；
 * platform_model_id 必须指向已启用的平台模型（触发器 org_settings_guard，ST001）。updated_at 由触发器维护。
 */
export interface OrgSettingsTable {
  org_id: ColumnType<string, string, never>;
  platform_model_id: ColumnType<string | null, string | null | undefined, string | null>;
  concurrency_limit: ColumnType<number, number | undefined, number>;
  export_format: ColumnType<Record<string, unknown>, string | undefined, string>;
  updated_by: ColumnType<string, string, string>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 用户设置（迁移 0009_settings），每个组织的每个成员一行，只有本人可见、可写；成员关系删除后随之删除。 */
export interface UserSettingsTable {
  org_id: ColumnType<string, string, never>;
  user_id: ColumnType<string, string, never>;
  agent_auto_answer_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  ui_preferences: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 迁移 0010_export_templates。org_id 为空的是系统模板，只由迁移命令同步（src/templates/system.ts）。 */
export interface ExportTemplatesTable {
  id: Generated<string>;
  org_id: ColumnType<string | null, string | null, never>;
  system_key: ColumnType<string | null, string | null | undefined, string | null>;
  name: ColumnType<string, string, string>;
  config: ColumnType<Record<string, unknown>, string, string>;
  sort_order: ColumnType<number, number | undefined, number>;
  created_by: ColumnType<string | null, string | null | undefined, never>;
  updated_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 资信库的文本列（迁移 0011_credential_library）：不可空，默认空字符串，长度由 CHECK 约束限制。 */
type CredentialTextColumns<T> = { [K in keyof T]: ColumnType<string, string | undefined, string> };

/** 企业信息，每个组织一行。组织内成员都可以读写（RLS），updated_by 必须是当前用户；不能删除。 */
export type CredentialLibraryProfileTable = CredentialTextColumns<typeof CREDENTIAL_PROFILE_TEXT_COLUMNS> & {
  org_id: ColumnType<string, string, never>;
  watermark_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  updated_by: ColumnType<string, string, string>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
};

/** 资信库的记录表（证书、人员、业绩、其他资料）的公共列。 */
interface CredentialRecordColumns {
  id: Generated<string>;
  org_id: ColumnType<string, string, never>;
  created_by: ColumnType<string, string, never>;
  updated_by: ColumnType<string, string, string>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

type CredentialRecordTable<K extends keyof typeof CREDENTIAL_RECORD_TABLES> = CredentialTextColumns<
  (typeof CREDENTIAL_RECORD_TABLES)[K]['textColumns']
> &
  CredentialRecordColumns;

/**
 * 资信库图片（迁移 0011_credential_library）。原图是 credential-image 文件，所引用的文件已删除时行不可见（RLS）；
 * 归属列与 file_id 写入后不能改，应用角色不能删除行（删除图片即软删除文件）。
 */
export interface CredentialLibraryImagesTable {
  id: Generated<string>;
  org_id: ColumnType<string, string, never>;
  owner_type: ColumnType<CredentialOwnerType, CredentialOwnerType, never>;
  certificate_id: ColumnType<string | null, string | null | undefined, never>;
  employee_id: ColumnType<string | null, string | null | undefined, never>;
  credential_project_id: ColumnType<string | null, string | null | undefined, never>;
  material_id: ColumnType<string | null, string | null | undefined, never>;
  field_key: ColumnType<string, string, never>;
  file_id: ColumnType<string, string, never>;
  custom_name: ColumnType<string, string | undefined, string>;
  sort_order: ColumnType<number, number | undefined, number>;
  created_by: ColumnType<string, string, never>;
  created_at: ColumnType<Date, never, never>;
}

/** 知识库文件夹（迁移 0012_knowledge_base）。组织内成员都可以读写（RLS），updated_by 必须是当前用户。 */
export interface KnowledgeFoldersTable {
  id: Generated<string>;
  org_id: ColumnType<string, string, never>;
  name: ColumnType<string, string, string>;
  sort_order: ColumnType<number, number | undefined, number>;
  created_by: ColumnType<string, string, never>;
  updated_by: ColumnType<string, string, string>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];
export type KnowledgeStepKey = (typeof KNOWLEDGE_STEP_KEYS)[number];
export type KnowledgeStepStatus = (typeof KNOWLEDGE_STEP_STATUSES)[number];

type KnowledgeCount = ColumnType<number, never, number>;

/**
 * 知识库文档（迁移 0012_knowledge_base）。原件是 knowledge 文件，原件已删除时行不可见（RLS）；
 * file_id 写入后不能改，新文档一律是 pending，应用角色不能删除行（删除文档即软删除原件）。
 */
export interface KnowledgeDocumentsTable {
  id: Generated<string>;
  org_id: ColumnType<string, string, never>;
  folder_id: ColumnType<string, string, string>;
  file_id: ColumnType<string, string, never>;
  status: ColumnType<KnowledgeDocumentStatus, never, KnowledgeDocumentStatus>;
  progress: ColumnType<number, never, number>;
  message: ColumnType<string, never, string>;
  error: ColumnType<string | null, never, string | null>;
  item_count: KnowledgeCount;
  block_count: KnowledgeCount;
  filtered_block_count: KnowledgeCount;
  candidate_item_count: KnowledgeCount;
  discarded_block_count: KnowledgeCount;
  system_discarded_after_retry_count: KnowledgeCount;
  last_batch_size: ColumnType<number | null, never, number | null>;
  markdown_artifact_id: ColumnType<string | null, never, string | null>;
  parser_label: ColumnType<string | null, never, string | null>;
  sort_order: ColumnType<number, number | undefined, number>;
  created_by: ColumnType<string, string, never>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 知识库文档的处理步骤（迁移 0012_knowledge_base），随文档可见。 */
export interface KnowledgeDocumentStepsTable {
  org_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  step_key: ColumnType<KnowledgeStepKey, KnowledgeStepKey, never>;
  status: ColumnType<KnowledgeStepStatus, KnowledgeStepStatus | undefined, KnowledgeStepStatus>;
  result: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  started_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  updated_at: ColumnType<Date, never, never>;
}

/** 知识库文档准备的产物（迁移 0013_knowledge_base_items），随文档可见，整体替换，没有 UPDATE 授权（匹配批次除外）。 */
export interface KnowledgeBlocksTable {
  id: Generated<string>;
  org_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  block_id: ColumnType<string, string, never>;
  type: ColumnType<string, string, never>;
  heading_path: ColumnType<string[], string, never>;
  content: ColumnType<string, string, never>;
  content_chars: ColumnType<number, number, never>;
  is_filtered: ColumnType<boolean, boolean, never>;
  filter_reason: ColumnType<string | null, string | null, never>;
  sort_order: ColumnType<number, number, never>;
}

export interface KnowledgeCandidateItemsTable {
  id: Generated<string>;
  org_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  item_id: ColumnType<string, string, never>;
  title: ColumnType<string, string, never>;
  summary: ColumnType<string, string, never>;
  source: ColumnType<string | null, string | null, never>;
  sort_order: ColumnType<number, number, never>;
  created_at: ColumnType<Date, never, never>;
}

export interface KnowledgeItemsTable {
  id: Generated<string>;
  org_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  item_id: ColumnType<string, string, never>;
  title: ColumnType<string, string, never>;
  resume: ColumnType<string, string, never>;
  content: ColumnType<string, string, never>;
  source_file: ColumnType<string | null, string | null, never>;
  content_chars: ColumnType<number, number, never>;
  sort_order: ColumnType<number, number, never>;
  created_at: ColumnType<Date, never, never>;
}

export interface KnowledgeItemBlocksTable {
  org_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  item_id: ColumnType<string, string, never>;
  block_id: ColumnType<string, string, never>;
  sort_order: ColumnType<number, number, never>;
}

export type KnowledgeDiscardSource = (typeof KNOWLEDGE_DISCARD_SOURCES)[number];

export interface KnowledgeDiscardedGroupsTable {
  id: Generated<string>;
  org_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  source: ColumnType<KnowledgeDiscardSource, KnowledgeDiscardSource, never>;
  reason: ColumnType<string, string, never>;
  block_ids: ColumnType<string[], string, never>;
  sort_order: ColumnType<number, number, never>;
}

type KnowledgeReportCount = ColumnType<number, number, never>;

export interface KnowledgeReportsTable {
  document_id: ColumnType<string, string, never>;
  org_id: ColumnType<string, string, never>;
  total_blocks: KnowledgeReportCount;
  filtered_blocks_count: KnowledgeReportCount;
  candidate_items_count: KnowledgeReportCount;
  final_items_count: KnowledgeReportCount;
  matched_blocks_count: KnowledgeReportCount;
  discarded_blocks_count: KnowledgeReportCount;
  system_discarded_after_retry_count: KnowledgeReportCount;
  new_items_from_recovery_count: KnowledgeReportCount;
  recovery_attempt_count: KnowledgeReportCount;
  batch_size: KnowledgeReportCount;
  coverage_rate: KnowledgeReportCount;
  matched_rate: KnowledgeReportCount;
  created_at: ColumnType<Date, never, never>;
}

export interface KnowledgeMatchBatchesTable {
  org_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  batch_index: ColumnType<number, number, never>;
  status: ColumnType<KnowledgeStepStatus, KnowledgeStepStatus | undefined, KnowledgeStepStatus>;
  item_ids: ColumnType<unknown, string | undefined, string>;
  matches: ColumnType<unknown[] | null, string | null | undefined, string | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  started_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  updated_at: ColumnType<Date, never, never>;
}

export type DuplicateCheckStep = (typeof DUPLICATE_CHECK_STEPS)[number];
export type DuplicateCheckSection = (typeof DUPLICATE_CHECK_SECTIONS)[number];
export type DuplicateCheckStatus = (typeof DUPLICATE_CHECK_STATUSES)[number];
export type DuplicateCheckFileRole = (typeof DUPLICATE_CHECK_FILE_ROLES)[number];
export type DuplicateCheckOutlineSource = (typeof DUPLICATE_CHECK_OUTLINE_SOURCES)[number];
export type DuplicateCheckGroupType = (typeof DUPLICATE_CHECK_GROUP_TYPES)[number];
export type DuplicateCheckRisk = (typeof DUPLICATE_CHECK_RISKS)[number];

/** 写入后不能改的列（org_id、project_id、整体替换的结果列）。 */
type Fixed<T> = ColumnType<T, T, never>;
/** jsonb 列：读出是解析后的值，写入是 JSON 字符串。 */
type FixedJson<T> = ColumnType<T, string | undefined, never>;

/** 标书查重的页面状态（迁移 0014_duplicate_check），每个项目一行，不能删除。 */
export interface DuplicateCheckMetaTable {
  project_id: Fixed<string>;
  org_id: Fixed<string>;
  step: ColumnType<DuplicateCheckStep, DuplicateCheckStep | undefined, DuplicateCheckStep>;
  active_analysis_tab: ColumnType<DuplicateCheckSection, DuplicateCheckSection | undefined, DuplicateCheckSection>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 标书查重选中的文件（迁移 0014_duplicate_check），原件已删除或已不属于本项目时不可见（RLS）。 */
export interface DuplicateCheckFilesTable {
  file_id: Fixed<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  role: Fixed<DuplicateCheckFileRole>;
  sort_order: Fixed<number>;
  content_hash: ColumnType<string | null, never, string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface DuplicateCheckAnalysisSectionsTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  section: Fixed<DuplicateCheckSection>;
  status: ColumnType<DuplicateCheckStatus, DuplicateCheckStatus, DuplicateCheckStatus>;
  progress: ColumnType<number, number, number>;
  message: ColumnType<string, string, string>;
  signature: ColumnType<string | null, string | null, string | null>;
  stats: ColumnType<Record<string, unknown>, string, string>;
  started_at: ColumnType<Date | null, Date | null, Date | null>;
  updated_at: ColumnType<Date, never, never>;
}

/** 以下是四类分析的结果（迁移 0014_duplicate_check），整体替换，没有 UPDATE 授权。 */
export interface DuplicateCheckContentFilesTable {
  file_id: Fixed<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  status: Fixed<DuplicateCheckStatus>;
  content_artifact_id: Fixed<string | null>;
  content_length: Fixed<number>;
  parser_label: Fixed<string | null>;
  error: Fixed<string | null>;
  updated_at: ColumnType<Date, never, never>;
}

export interface DuplicateCheckMetadataItemsTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  file_id: Fixed<string>;
  key: Fixed<string>;
  label: Fixed<string>;
  value: Fixed<string>;
  normalized: Fixed<string | null>;
  date_day: Fixed<string | null>;
  comparable: Fixed<boolean>;
  date_comparable: Fixed<boolean>;
  sort_order: Fixed<number>;
}

export interface DuplicateCheckOutlineItemsTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  file_id: Fixed<string>;
  item_id: Fixed<string>;
  parent_item_id: Fixed<string | null>;
  level: Fixed<number>;
  number: Fixed<string | null>;
  title: Fixed<string>;
  normalized_title: Fixed<string>;
  path_titles: FixedJson<string[]>;
  normalized_path: Fixed<string>;
  source: Fixed<DuplicateCheckOutlineSource>;
  confidence: Fixed<number>;
  sort_order: Fixed<number>;
  from_tender: Fixed<boolean>;
  matched_tender_sentence: Fixed<string | null>;
}

export interface DuplicateCheckOutlineGroupsTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  group_id: Fixed<string>;
  type: Fixed<DuplicateCheckGroupType>;
  title: Fixed<string>;
  score: Fixed<number>;
  file_ids: FixedJson<string[]>;
  item_ids: FixedJson<Record<string, string[]>>;
  paths: FixedJson<Record<string, string[]>>;
  sort_order: Fixed<number>;
}

export interface DuplicateCheckOutlinePairwiseTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  file_a_id: Fixed<string>;
  file_b_id: Fixed<string>;
  score: Fixed<number>;
  title_overlap: Fixed<number>;
  path_overlap: Fixed<number>;
  order_similarity: Fixed<number>;
  shared_count: Fixed<number>;
  risk: Fixed<DuplicateCheckRisk>;
  sort_order: Fixed<number>;
}

export interface DuplicateCheckContentDuplicatesTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  duplicate_id: Fixed<string>;
  sentence: Fixed<string>;
  normalized: Fixed<string>;
  file_ids: FixedJson<string[]>;
  first_order: Fixed<number>;
}

export interface DuplicateCheckContentOccurrencesTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  duplicate_id: Fixed<string>;
  file_id: Fixed<string>;
  occurrence_count: Fixed<number>;
}

export interface DuplicateCheckImageFilesTable {
  file_id: Fixed<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  status: Fixed<DuplicateCheckStatus>;
  image_count: Fixed<number>;
  unique_image_count: Fixed<number>;
  error: Fixed<string | null>;
  updated_at: ColumnType<Date, never, never>;
}

export interface DuplicateCheckDuplicateImagesTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  image_id: Fixed<string>;
  hash: Fixed<string>;
  preview_artifact_id: Fixed<string | null>;
  file_ids: FixedJson<string[]>;
  sort_order: Fixed<number>;
}

export interface DuplicateCheckImageOccurrencesTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  image_id: Fixed<string>;
  file_id: Fixed<string>;
  occurrence_count: Fixed<number>;
  locations: FixedJson<unknown[]>;
}

export type RejectionCheckStep = (typeof REJECTION_CHECK_STEPS)[number];
export type RejectionCheckResultTab = (typeof REJECTION_CHECK_RESULT_TABS)[number];
export type RejectionCheckResultType = (typeof REJECTION_CHECK_RESULT_TYPES)[number];
export type RejectionCheckDocumentRole = (typeof REJECTION_CHECK_DOCUMENT_ROLES)[number];
export type RejectionCheckDocumentStatus = (typeof REJECTION_CHECK_DOCUMENT_STATUSES)[number];
export type RejectionCheckRunStatus = (typeof REJECTION_CHECK_RUN_STATUSES)[number];
export type RejectionCheckExtractionSource = (typeof REJECTION_CHECK_EXTRACTION_SOURCES)[number];
export type RejectionCheckFindingType = (typeof REJECTION_CHECK_FINDING_TYPES)[number];
export type RejectionCheckSeverity = (typeof REJECTION_CHECK_SEVERITIES)[number];

/** 废标检查的页面状态（迁移 0016_rejection_check），每个项目一行，不能删除。 */
export interface RejectionCheckMetaTable {
  project_id: Fixed<string>;
  org_id: Fixed<string>;
  step: ColumnType<RejectionCheckStep, RejectionCheckStep | undefined, RejectionCheckStep>;
  active_document_tab: ColumnType<string, string | undefined, string>;
  active_result_tab: ColumnType<RejectionCheckResultTab, RejectionCheckResultTab | undefined, RejectionCheckResultTab>;
  active_check_result_tab: ColumnType<RejectionCheckResultType, RejectionCheckResultType | undefined, RejectionCheckResultType>;
  custom_check_items: ColumnType<string, string | undefined, string>;
  typo_check: ColumnType<boolean, boolean | undefined, boolean>;
  logic_check: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 废标检查导入的文档（迁移 0016_rejection_check），原件已删除或已不属于本项目时不可见（RLS），没有 DELETE 授权。 */
export interface RejectionCheckDocumentsTable {
  file_id: Fixed<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  role: Fixed<RejectionCheckDocumentRole>;
  sort_order: Fixed<number>;
  status: ColumnType<RejectionCheckDocumentStatus, never, RejectionCheckDocumentStatus>;
  markdown_artifact_id: ColumnType<string | null, never, string | null>;
  content_chars: ColumnType<number, never, number>;
  content_hash: ColumnType<string | null, never, string | null>;
  parser_label: ColumnType<string | null, never, string | null>;
  error: ColumnType<string | null, never, string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface RejectionCheckExtractionTable {
  project_id: Fixed<string>;
  org_id: Fixed<string>;
  status: ColumnType<RejectionCheckRunStatus, RejectionCheckRunStatus, RejectionCheckRunStatus>;
  content: ColumnType<string, string, string>;
  source: ColumnType<RejectionCheckExtractionSource | null, RejectionCheckExtractionSource | null, RejectionCheckExtractionSource | null>;
  tender_signature: ColumnType<string | null, string | null, string | null>;
  error: ColumnType<string | null, string | null, string | null>;
  updated_at: ColumnType<Date, never, never>;
}

export interface RejectionCheckResultsTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  result_type: Fixed<RejectionCheckResultType>;
  status: ColumnType<RejectionCheckRunStatus, RejectionCheckRunStatus, RejectionCheckRunStatus>;
  input_signature: ColumnType<string | null, string | null, string | null>;
  active_finding_id: ColumnType<string | null, string | null, string | null>;
  progress_message: ColumnType<string | null, string | null, string | null>;
  error: ColumnType<string | null, string | null, string | null>;
  updated_at: ColumnType<Date, never, never>;
}

/** 以下是三类检查的问题（迁移 0016_rejection_check），整体替换，没有 UPDATE 授权。 */
interface RejectionCheckFindingColumns {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  finding_id: Fixed<string>;
  bid_document_id: Fixed<string>;
  sort_order: Fixed<number>;
  created_at: ColumnType<Date, never, never>;
}

export interface RejectionCheckRiskFindingsTable extends RejectionCheckFindingColumns {
  type: Fixed<RejectionCheckFindingType>;
  severity: Fixed<RejectionCheckSeverity>;
  title: Fixed<string>;
  summary: Fixed<string>;
  requirement: Fixed<string>;
  bid_evidence: Fixed<string>;
  risk_reason: Fixed<string>;
  suggestion: Fixed<string>;
}

export interface RejectionCheckTypoFindingsTable extends RejectionCheckFindingColumns {
  wrong_text: Fixed<string>;
  correct_text: Fixed<string>;
  original_excerpt: Fixed<string>;
  reason: Fixed<string>;
  location_hint: Fixed<string | null>;
}

export interface RejectionCheckLogicFindingsTable extends RejectionCheckFindingColumns {
  title: Fixed<string>;
  original_text: Fixed<string>;
  location_hint: Fixed<string>;
  fallacy_reason: Fixed<string>;
  suggestion: Fixed<string>;
}

export type FeasibilityReportStep = (typeof FEASIBILITY_REPORT_STEPS)[number];
export type FeasibilityProjectType = (typeof FEASIBILITY_PROJECT_TYPES)[number];
export type FeasibilityOutlineTemplate = (typeof FEASIBILITY_OUTLINE_TEMPLATES)[number];
export type FeasibilitySourceStatus = (typeof FEASIBILITY_SOURCE_STATUSES)[number];

type Editable<T> = ColumnType<T, T | undefined, T>;

/** 可研报告的页面状态（迁移 0017_feasibility_report），每个项目一行，不能删除。 */
export interface FeasibilityReportMetaTable {
  project_id: Fixed<string>;
  org_id: Fixed<string>;
  step: Editable<FeasibilityReportStep>;
  project_name: Editable<string>;
  project_type: Editable<FeasibilityProjectType>;
  industry: Editable<string>;
  construction_unit: Editable<string>;
  location: Editable<string>;
  construction_content: Editable<string>;
  construction_period_years: Editable<string>;
  operation_period_years: Editable<string>;
  total_investment: Editable<string>;
  funding_source: Editable<string>;
  analysis_markdown: Editable<string>;
  outline_template: Editable<FeasibilityOutlineTemplate>;
  target_words: Editable<number>;
  key_parameters_markdown: Editable<string>;
  outline_project_name: Editable<string | null>;
  outline_project_overview: Editable<string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 可研资料（迁移 0017_feasibility_report），原件已删除或已不属于本项目时不可见（RLS），没有 DELETE 授权。 */
export interface FeasibilityReportSourcesTable {
  file_id: Fixed<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  sort_order: Editable<number>;
  status: ColumnType<FeasibilitySourceStatus, never, FeasibilitySourceStatus>;
  markdown_artifact_id: ColumnType<string | null, never, string | null>;
  content_chars: ColumnType<number, never, number>;
  content_hash: ColumnType<string | null, never, string | null>;
  parser_label: ColumnType<string | null, never, string | null>;
  error: ColumnType<string | null, never, string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 目录生成引用的知识库文档（迁移 0017_feasibility_report），整体替换，没有 UPDATE 授权。 */
export interface FeasibilityReportReferenceDocsTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  document_id: Fixed<string>;
  sort_order: ColumnType<number, number | undefined, never>;
  created_at: ColumnType<Date, never, never>;
}

/** 报告目录与正文（迁移 0017_feasibility_report），整体替换，只有 content 可以更新。 */
export interface FeasibilityReportOutlineNodesTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  node_id: Fixed<string>;
  parent_node_id: Fixed<string | null>;
  sort_order: ColumnType<number, number | undefined, never>;
  level: Fixed<number>;
  title: Fixed<string>;
  description: ColumnType<string, string | undefined, never>;
  knowledge_item_ids: ColumnType<string[] | null, string | null | undefined, never>;
  content: ColumnType<string, string | undefined, string>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export type TechnicalPlanStep = (typeof TECHNICAL_PLAN_STEPS)[number];
export type TechnicalPlanDocumentRole = (typeof TECHNICAL_PLAN_DOCUMENT_ROLES)[number];
export type TechnicalPlanDocumentStatus = (typeof TECHNICAL_PLAN_DOCUMENT_STATUSES)[number];
export type TechnicalPlanRunStatus = (typeof TECHNICAL_PLAN_RUN_STATUSES)[number];
export type TechnicalPlanBidAnalysisMode = (typeof TECHNICAL_PLAN_BID_ANALYSIS_MODES)[number];
export type TechnicalPlanBidSectionMode = (typeof TECHNICAL_PLAN_BID_SECTION_MODES)[number];
export type TechnicalPlanOutlineMode = (typeof TECHNICAL_PLAN_OUTLINE_MODES)[number];
export type TechnicalPlanOutlineExpansionMode = (typeof TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES)[number];
export type TechnicalPlanGlobalFactsMode = (typeof TECHNICAL_PLAN_GLOBAL_FACTS_MODES)[number];
export type TechnicalPlanExportTemplateScope = (typeof TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES)[number];
export type TechnicalPlanTableRequirement = (typeof TECHNICAL_PLAN_TABLE_REQUIREMENTS)[number];
export type TechnicalPlanImageQuantity = (typeof TECHNICAL_PLAN_IMAGE_QUANTITIES)[number];
export type TechnicalPlanBidItemId = (typeof TECHNICAL_PLAN_BID_ITEM_IDS)[number];
export type TechnicalPlanContentMode = (typeof TECHNICAL_PLAN_CONTENT_MODES)[number];

/** 目录的字数控制（与桌面版 Renderer 的 OutlineWordControlOptions 相同）。 */
export interface TechnicalPlanWordControl {
  minimumWords: number;
  maximumWords: number;
  sectionWords: number;
}

/** 多标段识别出的标段（与桌面版 Renderer 的 DetectedBidSection 相同）。 */
export interface TechnicalPlanBidSection {
  id: string;
  index: number;
  unit: string;
  title: string;
  headLine: string;
  description: string;
  includeRanges: { startLine: number; endLine: number; reason?: string }[];
  evidence: string[];
}

/** 技术方案的页面状态（迁移 0018_technical_plan），每个项目一行，不能删除。 */
export interface TechnicalPlanMetaTable {
  project_id: Fixed<string>;
  org_id: Fixed<string>;
  step: Editable<TechnicalPlanStep>;
  bid_sections: ColumnType<TechnicalPlanBidSection[] | null, string | null | undefined, string | null>;
  bid_section_extraction_status: Editable<TechnicalPlanRunStatus>;
  bid_section_extraction_error: Editable<string | null>;
  selected_section_id: Editable<string | null>;
  selected_section_title: Editable<string | null>;
  /** 以下三列见迁移 0019_technical_plan_outline。 */
  outline_project_name: Editable<string | null>;
  outline_project_overview: Editable<string | null>;
  outline_word_control_snapshot: ColumnType<TechnicalPlanWordControl | null, string | null | undefined, string | null>;
  /** 正文生成的运行进度，见迁移 0020_technical_plan_content。 */
  content_generation_runtime: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 招标文件与原方案（迁移 0018_technical_plan），原件已删除或已不属于本项目时不可见（RLS），没有 DELETE 授权。 */
export interface TechnicalPlanDocumentsTable {
  file_id: Fixed<string>;
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  role: Fixed<TechnicalPlanDocumentRole>;
  sort_order: Fixed<number>;
  status: ColumnType<TechnicalPlanDocumentStatus, never, TechnicalPlanDocumentStatus>;
  markdown_artifact_id: ColumnType<string | null, never, string | null>;
  content_chars: ColumnType<number, never, number>;
  content_hash: ColumnType<string | null, never, string | null>;
  parser_label: ColumnType<string | null, never, string | null>;
  error: ColumnType<string | null, never, string | null>;
  /** 疑似多标段检测摘要（迁移 0026，src/technicalPlan/bidSectionDetector.ts），由解析任务写入。 */
  bid_section_detection: ColumnType<Record<string, unknown> | null, never, string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 统一生成配置（迁移 0018_technical_plan），每个项目一行，不能删除。 */
export interface TechnicalPlanGenerationConfigTable {
  project_id: Fixed<string>;
  org_id: Fixed<string>;
  bid_analysis_mode: Editable<TechnicalPlanBidAnalysisMode>;
  bid_section_mode: Editable<TechnicalPlanBidSectionMode>;
  outline_mode: Editable<TechnicalPlanOutlineMode>;
  outline_expansion_mode: Editable<TechnicalPlanOutlineExpansionMode>;
  minimum_words: Editable<number>;
  maximum_words: Editable<number>;
  section_words: Editable<number>;
  global_facts_mode: Editable<TechnicalPlanGlobalFactsMode>;
  export_template_id: Editable<string | null>;
  export_template_scope: Editable<TechnicalPlanExportTemplateScope>;
  use_ai_images: Editable<boolean>;
  use_mermaid_images: Editable<boolean>;
  use_html_images: Editable<boolean>;
  html_image_types: Editable<string>;
  table_requirement: Editable<TechnicalPlanTableRequirement>;
  image_quantity: Editable<number>;
  html_image_optimization: Editable<boolean>;
  word_count_repair: Editable<boolean>;
  layout_check: Editable<boolean>;
  use_single_image_layout: Editable<boolean>;
  use_image_text_layout: Editable<boolean>;
  use_three_images_layout: Editable<boolean>;
  use_four_images_layout: Editable<boolean>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 目录与各节正文（迁移 0019_technical_plan_outline），节点 id 写入后不能改。 */
export interface TechnicalPlanOutlineNodesTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  node_id: Fixed<string>;
  parent_node_id: Editable<string | null>;
  sort_order: Editable<number>;
  level: Editable<number>;
  title: Editable<string>;
  description: Editable<string>;
  content_mode: Editable<TechnicalPlanContentMode | null>;
  content_mode_note: Editable<string | null>;
  source_requirement_id: Editable<string | null>;
  source_requirement_title: Editable<string | null>;
  knowledge_item_ids: ColumnType<string[] | null, string | null | undefined, string | null>;
  content: Editable<string>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 全局事实（迁移 0019_technical_plan_outline），整体替换，没有 UPDATE 授权。 */
export interface TechnicalPlanGlobalFactGroupsTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  group_id: Fixed<string>;
  title: Fixed<string>;
  content: Fixed<string>;
  sort_order: ColumnType<number, number | undefined, never>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, Date | string | undefined, never>;
}

/** 各节的正文生成状态（迁移 0020_technical_plan_content），随目录节点删除。 */
export interface TechnicalPlanContentSectionsTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  node_id: Fixed<string>;
  status: Editable<TechnicalPlanRunStatus>;
  error: Editable<string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 各节的正文编排（迁移 0020_technical_plan_content），随目录节点删除。 */
export interface TechnicalPlanContentPlansTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  node_id: Fixed<string>;
  plan_version: ColumnType<number, number, number>;
  plan: ColumnType<Record<string, unknown>, string, string>;
  table_requirement: Editable<TechnicalPlanTableRequirement | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** 选中的招标解析项（迁移 0018_technical_plan），整体替换，没有 UPDATE 授权。 */
export interface TechnicalPlanGenerationBidTasksTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  task_id: Fixed<TechnicalPlanBidItemId>;
  sort_order: ColumnType<number, number | undefined, never>;
  created_at: ColumnType<Date, never, never>;
}

/** 生成引用的知识库文档（迁移 0018_technical_plan），整体替换，没有 UPDATE 授权。 */
export interface TechnicalPlanGenerationReferenceDocsTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  document_id: Fixed<string>;
  sort_order: ColumnType<number, number | undefined, never>;
  created_at: ColumnType<Date, never, never>;
}

/** 招标解析项的结果（迁移 0018_technical_plan），由第 6 步的解析任务写入。 */
export interface TechnicalPlanBidItemsTable {
  org_id: Fixed<string>;
  project_id: Fixed<string>;
  item_id: Fixed<TechnicalPlanBidItemId>;
  label: Editable<string>;
  status: Editable<TechnicalPlanRunStatus>;
  content: Editable<string>;
  error: Editable<string | null>;
  sort_order: Editable<number>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobEventKind = (typeof JOB_EVENT_KINDS)[number];
export type JobPauseReason = (typeof JOB_PAUSE_REASONS)[number];

/** 任务（迁移 0021_jobs）：任务状态的唯一权威。jsonb 列写入时传 JSON 字符串。 */
export interface JobsTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  project_id: ColumnType<string | null, string | null | undefined, never>;
  user_id: Fixed<string>;
  type: Fixed<string>;
  lock_key: ColumnType<string | null, string | null | undefined, never>;
  status: Editable<JobStatus>;
  pause_requested: Editable<boolean>;
  progress: Editable<number>;
  params: FixedJson<Record<string, unknown>>;
  checkpoint: ColumnType<Record<string, unknown> | null, never, string | null>;
  error_code: ColumnType<string | null, never, string | null>;
  error_message: ColumnType<string | null, never, string | null>;
  attempt: ColumnType<number, never, number>;
  run_id: ColumnType<string | null, never, string | null>;
  lease_expires_at: ColumnType<Date | null, never, Date | string | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
  started_at: ColumnType<Date | null, never, Date | string | null>;
  finished_at: ColumnType<Date | null, never, Date | string | null>;
  /** 本任务已扣费的合计（计费单位，bigint 读出为字符串），只由 ai_usage_settle 累加（迁移 0022_job_billing）。 */
  billed_amount: ColumnType<string, never, never>;
  /** 暂停原因（迁移 0022_job_billing，0033 新增任务上限的两个原因），只在 paused 时可以有值。 */
  pause_reason: ColumnType<JobPauseReason | null, never, JobPauseReason | null>;
}

/** 任务事件（迁移 0021_jobs），只追加。 */
export interface JobEventsTable {
  id: ColumnType<string, never, never>;
  org_id: Fixed<string>;
  job_id: Fixed<string>;
  kind: Fixed<JobEventKind>;
  message: ColumnType<string | null, string | null | undefined, never>;
  data: ColumnType<Record<string, unknown> | null, string | null | undefined, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * 任务步骤的调用结果（迁移 0025_job_step_results）：与结算在同一事务中写入，续跑时同一步骤、同一请求直接取回，
 * 不再调用服务商、不再扣费。只追加（应用角色没有 UPDATE、DELETE），随任务记录删除。
 */
export interface JobStepToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface JobStepResultsTable {
  org_id: Fixed<string>;
  job_id: Fixed<string>;
  step_key: Fixed<string>;
  request_hash: Fixed<Buffer>;
  usage_id: Fixed<string>;
  content: Fixed<string>;
  reasoning_content: Fixed<string>;
  finish_reason: Fixed<string | null>;
  /** jsonb 数组（模型发起的工具调用，每项 {id, name, arguments}，迁移 0032），没有时为 NULL；写入时传 JSON 文本。 */
  tool_calls: ColumnType<JobStepToolCall[] | null, string | null | undefined, never>;
  input_tokens: ColumnType<string, number, never>;
  cached_input_tokens: ColumnType<string, number, never>;
  output_tokens: ColumnType<string, number, never>;
  usage_source: Fixed<'provider' | 'estimated'>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * Agent 任务令牌（迁移 0031_agent_job_tokens）：agent 沙箱访问平台的唯一凭据，库中只存哈希。
 * 应用角色读不到 token_hash（按令牌查身份只能经 agent_token_lookup），写入后只能作废一次（revoked_at 由触发器取 now()）。
 */
export interface AgentJobTokensTable {
  id: Generated<string>;
  org_id: Fixed<string>;
  job_id: Fixed<string>;
  run_id: Fixed<string>;
  token_hash: ColumnType<never, Buffer, never>;
  created_at: ColumnType<Date, never, never>;
  expires_at: ColumnType<Date, Date | string, never>;
  revoked_at: ColumnType<Date | null, never, Date | string>;
}

export type AgentBudgetExhaustedReason = (typeof AGENT_BUDGET_EXHAUSTED_REASONS)[number];

/**
 * Agent 任务的费用与轮数上限（迁移 0033_agent_job_budgets）：入队时写入；轮数只能逐次加 1，达到上限的原因只能设置一次；
 * 上限只能经“确认继续”（0034）各加一份、同时清除原因（触发器 AB001）。bigint 读出为字符串。
 */
export interface AgentJobBudgetsTable {
  org_id: Fixed<string>;
  job_id: Fixed<string>;
  cost_limit: ColumnType<string, string, string>;
  turn_limit: ColumnType<number, number, number>;
  turns_used: ColumnType<number, never, number>;
  exhausted_reason: ColumnType<AgentBudgetExhaustedReason | null, never, AgentBudgetExhaustedReason | null>;
  /** “一份”额度（迁移 0034_agent_job_budget_confirm）：写入时取入队时的上限，之后不能改；确认继续时上限各加一份。 */
  cost_step: ColumnType<string, never, never>;
  turn_step: ColumnType<number, never, never>;
  /** 已确认继续的次数（0034）。 */
  confirmations: ColumnType<number, never, number>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/**
 * Agent 任务上限按组织覆盖（迁移 0035_agent_job_limit_overrides，8.3c）：每个（组织, 任务类型）至多一行，入队时取覆盖值。
 * 应用角色只读本组织的行；写入只经平台管理员函数。bigint 读出为字符串。
 */
export interface AgentJobLimitOverridesTable {
  org_id: ColumnType<string, never, never>;
  job_type: ColumnType<string, never, never>;
  cost_limit: ColumnType<string, never, never>;
  turn_limit: ColumnType<number, never, never>;
  note: ColumnType<string | null, never, never>;
  created_by: ColumnType<string, never, never>;
  created_at: ColumnType<Date, never, never>;
  updated_by: ColumnType<string, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/**
 * Agent 任务的每次执行（迁移 0036_agent_job_runs，8.3d）：认领时写入，续租时推进 last_seen_at，结束时 ended_at = last_seen_at；
 * 每日 Agent 运行时长按此现算。时间取数据库时间，应用角色只能写入标识；结束后整行不能再改（触发器 AR001）。
 */
export interface AgentJobRunsTable {
  run_id: ColumnType<string, string, never>;
  org_id: ColumnType<string, string, never>;
  job_id: ColumnType<string, string, never>;
  started_at: ColumnType<Date, never, never>;
  last_seen_at: ColumnType<Date, never, Date>;
  ended_at: ColumnType<Date | null, never, Date | null>;
}

/**
 * Agent 业务工具的调用计数（迁移 0037_agent_tool_calls，8.4a）：每个 Agent 任务、每个工具一行，calls 跨执行累计，
 * window_* 是一分钟窗口的计数。只经 src/agent/tools.ts 的计数语句原子地加 1（触发器 AT101 检查只能逐次加 1），没有 DELETE。
 */
export interface AgentToolCallsTable {
  org_id: ColumnType<string, string, never>;
  job_id: ColumnType<string, string, never>;
  tool: ColumnType<string, string, never>;
  calls: ColumnType<number, never, number>;
  window_started_at: ColumnType<Date, never, Date>;
  window_calls: ColumnType<number, never, number>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * Agent 报告无法继续（迁移 0038_agent_failure_reports，8.4b）：每次执行至多一行（只记第一次），reason 是规范化后的纯文本。
 * 只能为本组织 running、run_id 相符的 Agent 任务写入，没有 UPDATE、DELETE。
 */
export interface AgentFailureReportsTable {
  org_id: ColumnType<string, string, never>;
  job_id: ColumnType<string, string, never>;
  run_id: ColumnType<string, string, never>;
  reason: ColumnType<string, string, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * Agent 当前阶段可用的业务工具（迁移 0042_agent_tool_scopes，8.6c1）：每次执行一行，执行者在每条提示词之前写入；
 * 工具调用的计数语句（src/agent/tools.ts）只放行其中的工具。只能为本组织 running、run_id 相符的 Agent 任务写入与更新，没有 DELETE。
 */
export interface AgentToolScopesTable {
  org_id: ColumnType<string, string, never>;
  job_id: ColumnType<string, string, never>;
  run_id: ColumnType<string, string, never>;
  tools: ColumnType<string[], string[], string[]>;
  updated_at: ColumnType<Date, never, Date>;
}

/**
 * Agent 的模型调用被平台拒绝的原因（迁移 0043_agent_model_rejections，8.6d3）：每次执行一行，reason 是最近一次的原因，
 * rejections 是本次执行被拒绝的次数。只能为本组织 running、run_id 相符的 Agent 任务写入与更新，没有 DELETE。
 */
export interface AgentModelRejectionsTable {
  org_id: ColumnType<string, string, never>;
  job_id: ColumnType<string, string, never>;
  run_id: ColumnType<string, string, never>;
  reason: ColumnType<AgentModelRejectionReason, AgentModelRejectionReason, AgentModelRejectionReason>;
  rejections: ColumnType<number, never, number>;
  updated_at: ColumnType<Date, never, Date>;
}

export type AgentModelRejectionReason = (typeof AGENT_MODEL_REJECTION_REASONS)[number];

export type AgentQuestionStatus = (typeof AGENT_QUESTION_STATUSES)[number];

/** Agent 问题的一个选项（服务端规范化后的纯文本）。 */
export interface AgentQuestionOption {
  label: string;
  description: string;
  custom: boolean;
}

/**
 * Agent 向用户提问（迁移 0039_agent_questions，8.4c1）：每个任务同时至多一个未关闭的问题（pending / answered）。
 * 状态的改法由触发器 AQ001 限定；answered_by、answered_at、consumed_at 与续跑接手时的 asked_at 由触发器填写；没有 DELETE。
 */
export interface AgentQuestionsTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  job_id: ColumnType<string, string, never>;
  run_id: ColumnType<string, string, string>;
  content_hash: ColumnType<Buffer, Buffer, never>;
  question: ColumnType<string, string, never>;
  options: ColumnType<AgentQuestionOption[], string, never>;
  status: ColumnType<AgentQuestionStatus, never, AgentQuestionStatus>;
  asked_at: ColumnType<Date, never, never>;
  answer_option: ColumnType<number | null, never, number>;
  answer_text: ColumnType<string | null, never, string | null>;
  answered_by: ColumnType<string | null, never, never>;
  answered_at: ColumnType<Date | null, never, never>;
  consumed_run_id: ColumnType<string | null, never, string>;
  consumed_at: ColumnType<Date | null, never, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * Agent 工作区快照（迁移 0040_agent_workspace_snapshots，8.5a）：每个项目、每类任务至多一个当前的快照（已完成、未被替换）。
 * storage_key 是生成列 'org/{org_id}/agent-workspaces/{id}'；完成后内容不能改、只能标为已被替换一次（AW003），配额由触发器检查（AW001）；
 * 应用角色只能删除写入中或已被替换的行。
 */
export interface AgentWorkspaceSnapshotsTable {
  id: ColumnType<string, never, never>;
  org_id: ColumnType<string, string, never>;
  project_id: ColumnType<string, string, never>;
  task_kind: ColumnType<string, string, never>;
  storage_key: ColumnType<string, never, never>;
  status: ColumnType<'writing' | 'ready', never, 'ready'>;
  /** bigint，pg 返回字符串。 */
  size_bytes: ColumnType<string | null, never, number>;
  file_count: ColumnType<number | null, never, number>;
  sha256: ColumnType<Buffer | null, never, Buffer>;
  created_by: ColumnType<string, string, never>;
  created_at: ColumnType<Date, never, never>;
  completed_at: ColumnType<Date | null, never, never>;
  /** 被新快照替换或被丢弃的时间（触发器写入 now()）；之后立即可由清理任务删除。 */
  superseded_at: ColumnType<Date | null, never, Date>;
}

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  org_memberships: OrgMembershipsTable;
  sessions: SessionsTable;
  auth_tokens: AuthTokensTable;
  invitations: InvitationsTable;
  org_balances: OrgBalancesTable;
  billing_ledger: BillingLedgerTable;
  model_prices: ModelPricesTable;
  usage_records: UsageRecordsTable;
  provider_credentials: ProviderCredentialsTable;
  platform_models: PlatformModelsTable;
  files: FilesTable;
  projects: ProjectsTable;
  artifacts: ArtifactsTable;
  template_preview_requests: TemplatePreviewRequestsTable;
  technical_plan_export_requests: TechnicalPlanExportRequestsTable;
  feasibility_report_export_requests: FeasibilityReportExportRequestsTable;
  org_settings: OrgSettingsTable;
  user_settings: UserSettingsTable;
  export_templates: ExportTemplatesTable;
  credential_library_profile: CredentialLibraryProfileTable;
  credential_library_certificates: CredentialRecordTable<'certificate'>;
  credential_library_employees: CredentialRecordTable<'employee'>;
  credential_library_projects: CredentialRecordTable<'project'>;
  credential_library_other_materials: CredentialRecordTable<'other'>;
  credential_library_images: CredentialLibraryImagesTable;
  knowledge_folders: KnowledgeFoldersTable;
  knowledge_documents: KnowledgeDocumentsTable;
  knowledge_document_steps: KnowledgeDocumentStepsTable;
  knowledge_blocks: KnowledgeBlocksTable;
  knowledge_candidate_items: KnowledgeCandidateItemsTable;
  knowledge_items: KnowledgeItemsTable;
  knowledge_item_blocks: KnowledgeItemBlocksTable;
  knowledge_discarded_groups: KnowledgeDiscardedGroupsTable;
  knowledge_reports: KnowledgeReportsTable;
  knowledge_match_batches: KnowledgeMatchBatchesTable;
  duplicate_check_meta: DuplicateCheckMetaTable;
  duplicate_check_files: DuplicateCheckFilesTable;
  duplicate_check_analysis_sections: DuplicateCheckAnalysisSectionsTable;
  duplicate_check_content_files: DuplicateCheckContentFilesTable;
  duplicate_check_metadata_items: DuplicateCheckMetadataItemsTable;
  duplicate_check_outline_items: DuplicateCheckOutlineItemsTable;
  duplicate_check_outline_groups: DuplicateCheckOutlineGroupsTable;
  duplicate_check_outline_pairwise: DuplicateCheckOutlinePairwiseTable;
  duplicate_check_content_duplicates: DuplicateCheckContentDuplicatesTable;
  duplicate_check_content_occurrences: DuplicateCheckContentOccurrencesTable;
  duplicate_check_image_files: DuplicateCheckImageFilesTable;
  duplicate_check_duplicate_images: DuplicateCheckDuplicateImagesTable;
  duplicate_check_image_occurrences: DuplicateCheckImageOccurrencesTable;
  rejection_check_meta: RejectionCheckMetaTable;
  rejection_check_documents: RejectionCheckDocumentsTable;
  rejection_check_extraction: RejectionCheckExtractionTable;
  rejection_check_results: RejectionCheckResultsTable;
  rejection_check_risk_findings: RejectionCheckRiskFindingsTable;
  rejection_check_typo_findings: RejectionCheckTypoFindingsTable;
  rejection_check_logic_findings: RejectionCheckLogicFindingsTable;
  feasibility_report_meta: FeasibilityReportMetaTable;
  feasibility_report_sources: FeasibilityReportSourcesTable;
  feasibility_report_reference_docs: FeasibilityReportReferenceDocsTable;
  feasibility_report_outline_nodes: FeasibilityReportOutlineNodesTable;
  technical_plan_meta: TechnicalPlanMetaTable;
  technical_plan_documents: TechnicalPlanDocumentsTable;
  technical_plan_generation_config: TechnicalPlanGenerationConfigTable;
  technical_plan_generation_bid_tasks: TechnicalPlanGenerationBidTasksTable;
  technical_plan_generation_reference_docs: TechnicalPlanGenerationReferenceDocsTable;
  technical_plan_bid_items: TechnicalPlanBidItemsTable;
  technical_plan_outline_nodes: TechnicalPlanOutlineNodesTable;
  technical_plan_global_fact_groups: TechnicalPlanGlobalFactGroupsTable;
  technical_plan_content_sections: TechnicalPlanContentSectionsTable;
  technical_plan_content_plans: TechnicalPlanContentPlansTable;
  jobs: JobsTable;
  job_events: JobEventsTable;
  job_step_results: JobStepResultsTable;
  agent_job_tokens: AgentJobTokensTable;
  agent_job_budgets: AgentJobBudgetsTable;
  agent_job_limit_overrides: AgentJobLimitOverridesTable;
  agent_job_runs: AgentJobRunsTable;
  agent_tool_calls: AgentToolCallsTable;
  agent_failure_reports: AgentFailureReportsTable;
  agent_questions: AgentQuestionsTable;
  agent_workspace_snapshots: AgentWorkspaceSnapshotsTable;
  agent_tool_scopes: AgentToolScopesTable;
  agent_model_rejections: AgentModelRejectionsTable;
}
