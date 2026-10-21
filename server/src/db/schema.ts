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
}
