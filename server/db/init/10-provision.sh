#!/usr/bin/env bash
# 开发环境 PostgreSQL 首次初始化（数据卷为空时由官方镜像的 docker-entrypoint 执行一次）：
# 创建迁移角色（表属主）、应用角色、鉴权函数和计费函数的属主角色，以及业务库。角色属性与 server/tests/db/harness.ts 一致，修改时两边同步。
# 设计见 docs/SERVER_DESIGN.md 第 2.6、10 节：四个角色都不是超级用户、没有 BYPASSRLS；应用角色不拥有任何表。
# 密码从 Docker secrets 读取，经 psql 变量以字面量传入，不拼接进 SQL 文本。
set -euo pipefail

: "${APP_DB_NAME:?需要 APP_DB_NAME}"
owner_password="$(< /run/secrets/db_owner_password)"
app_password="$(< /run/secrets/db_app_password)"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v db_name="$APP_DB_NAME" \
  -v owner_password="$owner_password" \
  -v app_password="$app_password" <<'SQL'
CREATE ROLE bidtools_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'owner_password';
CREATE ROLE bidtools_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'app_password';
-- 登录前查询（SECURITY DEFINER 函数）的属主：不能登录；迁移角色只能 SET ROLE 成它，不继承它的权限。
CREATE ROLE bidtools_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT bidtools_auth TO bidtools_owner WITH INHERIT FALSE, SET TRUE;
-- 计费函数（管理员充值、冲正、定价）和账本触发器的属主，属性同 bidtools_auth。
CREATE ROLE bidtools_billing NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT bidtools_billing TO bidtools_owner WITH INHERIT FALSE, SET TRUE;
CREATE DATABASE :"db_name" OWNER bidtools_owner;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO bidtools_app;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$APP_DB_NAME" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO bidtools_app;
SQL
