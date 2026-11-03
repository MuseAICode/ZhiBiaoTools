// 模拟 LibreOffice 卡住（沙箱测试用）：在沙箱中运行真实的解析入口，期间不断对出现的 soffice.bin 发 SIGSTOP（冻结，不退出也不响应），
// 并把入口的转换上限经 ZHIBIAO_PARSE_OFFICE_TIMEOUT_MS 调小（只能调小；经 sandbox-runner 的接口无法设置，见 convert.mjs）。
// 脚本结束时按原样输出入口的结果行并以入口的退出码退出，另在标准错误写一行统计：是否冻结过、入口用时、仍活着（非僵尸）的
// LibreOffice 进程数。

/** 统计行的格式：frozen=yes|no ms=<入口用时> left=<仍活着的 soffice.bin / oosplash 数>。 */
export const STUCK_OFFICE_STATS = /^frozen=(yes|no) ms=(\d+) left=(\d+)$/m;

export function stuckOfficeScript(args: readonly string[], officeTimeoutMs: number): string {
  return `ZHIBIAO_PARSE_OFFICE_TIMEOUT_MS=${officeTimeoutMs} node /opt/parse/entry.mjs ${args.join(' ')} > /tmp/zhibiao-entry.out 2>/dev/null &
E=$!
start=$(date +%s%N)
frozen=0
while kill -0 "$E" 2>/dev/null; do
  for d in /proc/[0-9]*; do
    if [ "$(cat "$d/comm" 2>/dev/null)" = soffice.bin ] && kill -STOP "\${d#/proc/}" 2>/dev/null; then frozen=$((frozen + 1)); fi
  done
  sleep 0.05
done
wait "$E"; code=$?
end=$(date +%s%N)
left=0
for d in /proc/[0-9]*; do
  case "$(cat "$d/comm" 2>/dev/null)" in
    soffice.bin|oosplash) [ "$(sed -n 's/^State:[[:space:]]*\\([A-Z]\\).*/\\1/p' "$d/status" 2>/dev/null)" = Z ] || left=$((left + 1));;
  esac
done
echo "frozen=$([ "$frozen" -gt 0 ] && echo yes || echo no) ms=$(( (end - start) / 1000000 )) left=$left" >&2
cat /tmp/zhibiao-entry.out
exit "$code"`;
}

/** 整个解析命令卡住：入口一启动就被冻结，之后什么也不做，只能由沙箱命令的墙钟上限终止。 */
export function stuckEntryScript(args: readonly string[]): string {
  return `node /opt/parse/entry.mjs ${args.join(' ')} >/dev/null 2>&1 &
kill -STOP $!
sleep 100000`;
}
