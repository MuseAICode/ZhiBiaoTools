#!/bin/sh
# 启动 Valkey（docker-compose.yml 的 redis 服务和 CI 共用，保证两处的 ACL 一致）：
# - 禁用 default 用户，只有应用用户 bidtools，密码取自 REDIS_PASSWORD_FILE（Docker secret），ACL 文件中只写密码的 SHA-256；
# - bidtools 可以访问全部键和频道（队列、事件推送、限流在第 6 步陆续接入），但不能执行 @admin 类命令
#   （CONFIG、ACL、DEBUG、SHUTDOWN、MONITOR、REPLICAOF 等）和清空库的命令；
# - 不持久化（docs/SERVER_DESIGN.md 第 8.4 节：队列可从 jobs 表重建，进度事件可丢），内存满时拒绝写入而不是淘汰键（BullMQ 的要求）。
set -eu

password_file="${REDIS_PASSWORD_FILE:-/run/secrets/redis_password}"
password="$(tr -d '[:space:]' < "$password_file")"
if [ -z "$password" ]; then
  echo "redis password file is empty" >&2
  exit 1
fi
hash="$(printf '%s' "$password" | sha256sum | cut -d ' ' -f 1)"
unset password

umask 077
printf 'user default off\nuser bidtools on #%s ~* &* +@all -@admin -flushall -flushdb -swapdb\n' "$hash" > /tmp/users.acl

exec valkey-server --aclfile /tmp/users.acl --bind 0.0.0.0 --port 6379 --dir /tmp \
  --save '' --appendonly no --maxmemory "${REDIS_MAXMEMORY:-256mb}" --maxmemory-policy noeviction
