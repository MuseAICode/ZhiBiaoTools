// 路由层的项目归属校验（docs/SERVER_DESIGN.md 第 2.6、3.4 节）：带 projectId 的业务接口先经 requireProject
// 按 TenantContext 查出项目，再核对组织和 kind，通过后才把上下文往下传给模块的 Store。
//
// 查不到、属于别的组织、已删除、kind 不符一律返回同一个 404，不区分“不存在”和“无权限”，避免枚举。
// RLS 已保证查不到别的组织的项目，这里再显式核对 org_id，应用层和数据库层各管一层。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { findProject, type ProjectKind, type ProjectRecord } from './store.ts';

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** 路由参数 :projectId 的 schema；格式不对的直接 400，不查库。 */
export const PROJECT_ID_PARAMS = {
  type: 'object',
  properties: { projectId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['projectId'],
  additionalProperties: false,
} as const;

export function projectNotFound(): AppError {
  return new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
}

/**
 * 取出当前组织中未删除、kind 相符的项目，否则抛 404 PROJECT_NOT_FOUND。
 * kind 为 null 时不核对 kind（只用于 /api/projects 自身的通用接口）。
 */
export async function requireProject(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  kind: ProjectKind | null,
): Promise<ProjectRecord> {
  const project = await findProject(db, context, projectId.toLowerCase());
  if (!project || project.orgId !== context.orgId || (kind !== null && project.kind !== kind)) throw projectNotFound();
  return project;
}
