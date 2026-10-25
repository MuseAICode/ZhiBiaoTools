// 数据库角色名（docs/SERVER_DESIGN.md 第 2.6 节）。角色本身由数据库管理员创建（开发环境见
// server/db/init/），迁移只负责授权。
/** 表属主，只用于执行迁移。非超级用户、无 BYPASSRLS。 */
export const OWNER_ROLE = 'bidtools_owner';
/** 应用连接使用的角色：非表属主、非超级用户、无 BYPASSRLS，RLS 对它强制生效。 */
export const APP_ROLE = 'bidtools_app';
/**
 * 登录前查询（按邮箱查用户、按令牌查会话、找回密码、兑换邀请）的 SECURITY DEFINER 函数的属主。
 * NOLOGIN、非超级用户、无 BYPASSRLS；只有为它单独建的策略和列级授权，任何人都不能以它的身份登录。
 * 迁移角色是它的成员（SET 而非 INHERIT），只用于在迁移中以它的身份建删函数。
 */
export const AUTH_ROLE = 'bidtools_auth';
/**
 * 计费函数（管理员充值、冲正、新增价格版本；AI 网关的冻结、结算、写入平台凭据）和账本触发器的 SECURITY DEFINER 属主。
 * 与 bidtools_auth 相同：NOLOGIN、非超级用户、无 BYPASSRLS，只有为它单独建的策略和授权；
 * 对账本和价格表只有 SELECT、INSERT，余额只能经账本触发器修改。迁移角色以 SET（不继承）加入它。
 */
export const BILLING_ROLE = 'bidtools_billing';
/**
 * 存储配额函数 files_org_usage_bytes 的 SECURITY DEFINER 属主（迁移 0008）：配额要统计应用角色在 RLS 下看不到的行
 * （已删除项目下、仍在恢复期内的文件和产物）。与 bidtools_auth 相同：NOLOGIN、非超级用户、无 BYPASSRLS，
 * 只有为它单独建的只读策略和列级 SELECT 授权。迁移角色以 SET（不继承）加入它。
 */
export const STORAGE_ROLE = 'bidtools_storage';
/**
 * 任务对账函数 jobs_dispatch_candidates 的 SECURITY DEFINER 属主（迁移 0021）：worker 在 Redis（Valkey，不持久化）重启或被清空后
 * 要从 jobs 表找出所有组织中未结束的任务重新入队，这需要跨组织读取。函数只返回任务 id 和组织 id，之后每个任务的读写仍按
 * 该组织的上下文经 RLS 进行。与 bidtools_auth 相同：NOLOGIN、非超级用户、无 BYPASSRLS，只有为它单独建的只读策略和列级 SELECT 授权。
 * 迁移角色以 SET（不继承）加入它。
 */
export const JOBS_ROLE = 'bidtools_jobs';
