#!/usr/bin/env bash
# 检查所有跟踪文件的内容和文件名中是否出现禁用词（原产品名称及其缩写）。本脚本自身除外。
# 用法：在仓库根目录运行 bash scripts/check-banned-words.sh；发现禁用词时以非 0 退出。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# pattern 不区分大小写；yb 缩写要求前面不是字母或数字，避免误伤 PyBuilder、KYBG 等无关词。
pattern='yibiao|易标|openbidkit|(^|[^a-z0-9])yb[-_]|data-yb'
# case_pattern 区分大小写，拦截 ybTableKeepNext 这类驼峰标识符。
case_pattern='(^|[^A-Za-z0-9])yb[A-Z]'
self='scripts/check-banned-words.sh'
status=0

content_hits=$( { git grep -n -I -i -E "$pattern" -- . ":(exclude)$self" || true; git grep -n -I -E "$case_pattern" -- . ":(exclude)$self" || true; } | sort -u)
if [ -n "$content_hits" ]; then
  echo "以下文件内容包含禁用词："
  echo "$content_hits"
  status=1
fi

files=$(git -c core.quotepath=off ls-files)
name_hits=$( { grep -i -E "$pattern" <<<"$files" || true; grep -E "$case_pattern" <<<"$files" || true; } | sort -u)
if [ -n "$name_hits" ]; then
  echo "以下文件名包含禁用词："
  echo "$name_hits"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "未发现禁用词。"
fi
exit "$status"
