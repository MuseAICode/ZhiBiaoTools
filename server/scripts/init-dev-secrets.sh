#!/usr/bin/env bash
# 生成开发用 docker-compose.yml 所需的数据库密码、AI 网关主密钥、对象存储密钥、Redis 密码和沙箱服务令牌（随机值），已存在的文件不覆盖。
# 文件在 server/.dev-secrets/，已被 .gitignore 排除；只用于本机开发，生产环境的密钥另行管理。
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.dev-secrets"
mkdir -p "$dir"
chmod 700 "$dir"

# s3_secret_key：本地对象存储（SeaweedFS）的访问密钥，api 用它访问 bucket。
# redis_password：Redis（Valkey）ACL 用户 bidtools 的密码，见 server/redis/start-valkey.sh。
# sandbox_runner_token：worker 调用 sandbox-runner 的共享令牌（48 个十六进制字符，至少 32 个），见 src/sandbox/runnerApp.ts。
for name in postgres_password db_owner_password db_app_password s3_secret_key redis_password sandbox_runner_token; do
  file="$dir/$name"
  if [[ -s "$file" ]]; then
    echo "保留已有的 $name"
    continue
  fi
  (umask 022 && openssl rand -hex 24 > "$file")
  echo "已生成 $name"
done

# AI 网关的主密钥（KEK，docs/SERVER_DESIGN.md 第 4.2 节）：32 字节随机数的 base64。
# 丢失或更换后，已保存的平台凭据无法解密，需要平台管理员重新填写 Key。
kek="$dir/ai_kek"
if [[ -s "$kek" ]]; then
  echo "保留已有的 ai_kek"
else
  # 与上面的密码相同：目录已是 700，文件本身要让容器内的非 root 用户读得到。
  (umask 022 && openssl rand -base64 32 > "$kek")
  echo "已生成 ai_kek"
fi
