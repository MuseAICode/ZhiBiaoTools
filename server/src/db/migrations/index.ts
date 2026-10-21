// 迁移清单：静态导入，开发（类型擦除直接运行 .ts）和编译产物（dist/*.js）都能用，不依赖目录扫描。
// 新迁移按编号追加；已合并的迁移不再修改。
import type { Migration } from 'kysely/migration';
import * as identity from './0001_identity.ts';
import * as auth from './0002_auth.ts';
import * as billing from './0003_billing.ts';
import * as aiGateway from './0004_ai_gateway.ts';
import * as platformModels from './0005_platform_models.ts';
import * as files from './0006_files.ts';
import * as projects from './0007_projects.ts';
import * as artifacts from './0008_artifacts.ts';
import * as settings from './0009_settings.ts';
import * as exportTemplates from './0010_export_templates.ts';
import * as credentialLibrary from './0011_credential_library.ts';
import * as knowledgeBase from './0012_knowledge_base.ts';
import * as knowledgeBaseItems from './0013_knowledge_base_items.ts';
import * as duplicateCheck from './0014_duplicate_check.ts';
import * as filesProjectImmutable from './0015_files_project_immutable.ts';

export const migrations: Readonly<Record<string, Migration>> = Object.freeze({
  '0001_identity': identity,
  '0002_auth': auth,
  '0003_billing': billing,
  '0004_ai_gateway': aiGateway,
  '0005_platform_models': platformModels,
  '0006_files': files,
  '0007_projects': projects,
  '0008_artifacts': artifacts,
  '0009_settings': settings,
  '0010_export_templates': exportTemplates,
  '0011_credential_library': credentialLibrary,
  '0012_knowledge_base': knowledgeBase,
  '0013_knowledge_base_items': knowledgeBaseItems,
  '0014_duplicate_check': duplicateCheck,
  '0015_files_project_immutable': filesProjectImmutable,
});
