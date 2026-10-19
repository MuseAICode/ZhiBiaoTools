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
