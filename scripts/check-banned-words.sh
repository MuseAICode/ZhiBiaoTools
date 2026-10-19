#!/usr/bin/env bash
# 检查所有跟踪文件的内容和文件名中是否出现禁用词（原产品名称）。本脚本自身除外。
# 用法：在仓库根目录运行 bash scripts/check-banned-words.sh；发现禁用词时以非 0 退出。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

pattern='yibiao|易标|openbidkit'
self='scripts/check-banned-words.sh'
status=0

if content_hits=$(git grep -n -I -i -E "$pattern" -- . ":(exclude)$self"); then
  echo "以下文件内容包含禁用词："
  echo "$content_hits"
  status=1
fi

if name_hits=$(git -c core.quotepath=off ls-files | grep -i -E "$pattern"); then
  echo "以下文件名包含禁用词："
  echo "$name_hits"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "未发现禁用词。"
fi
exit "$status"
