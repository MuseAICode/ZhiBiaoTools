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

export const migrations: Readonly<Record<string, Migration>> = Object.freeze({
  '0001_identity': identity,
  '0002_auth': auth,
  '0003_billing': billing,
  '0004_ai_gateway': aiGateway,
  '0005_platform_models': platformModels,
  '0006_files': files,
  '0007_projects': projects,
});
