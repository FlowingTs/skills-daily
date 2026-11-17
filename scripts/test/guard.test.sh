#!/usr/bin/env bash
# 幂等守卫的时间场景回归测试。
#
# 用法： bash scripts/test/guard.test.sh [目标日期]
#
# 守卫同时要满足四件事，任何一条改错都会导致「漏发」或「一天发两次」，
# 而这两种故障在 Actions 上都表现为 success，从外面看不出来，所以必须有回归测试：
#   1. 凌晨误跑过，早八点仍要正常发布
#   2. 早八点发完，半小时后的第二个窗口不能再发
#   3. GitHub cron 延迟到下午补跑，不能重复推送
#   4. cron-job.org 挂了导致当天没发，下午补跑要能兜住
set -u
cd "$(dirname "$0")/../.." || exit 1

TARGET="${1:-2026-11-16}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CASE="$TMP/case.json"
fail=0

run() {
  local label="$1" gen="$2" now="$3" expect="$4"
  if [ "$gen" = "none" ]; then
    rm -f "$CASE"
  else
    printf '{"generated_at":"%s"}' "$gen" > "$CASE"
  fi
  local out got
  out=$(GUARD_FILE="$CASE" GUARD_NOW="$now" REPORT_DATE="$TARGET" node scripts/guard.mjs 2>&1 | tail -1)
  got=$(echo "$out" | grep -o 'skip=[a-z]*' | cut -d= -f2)
  if [ "$got" = "$expect" ]; then
    printf '  PASS  %s\n' "$label"
  else
    printf '  FAIL  %s（期望 skip=%s，实际 skip=%s）\n' "$label" "$expect" "$got"
    fail=1
  fi
}

echo "守卫时间场景（北京时间，目标日 $TARGET）："
run "凌晨 02:00 误跑过，早上 08:07 正式发布" "2026-11-17T02:00" "2026-11-17T08:07:00+08:00" "false"
run "早上 08:15 发完，08:37 第二个定时窗口" "2026-11-17T08:15" "2026-11-17T08:37:00+08:00" "true"
run "早上 08:15 发完，下午 14:09 补跑" "2026-11-17T08:15" "2026-11-17T14:09:00+08:00" "true"
run "早上 08:15 发完，下午 15:13 补跑" "2026-11-17T08:15" "2026-11-17T15:13:00+08:00" "true"
run "昨天生成过，今天下午补跑（应补发）" "2026-11-16T08:15" "2026-11-17T14:09:00+08:00" "false"
run "今天还没生成，早上正常触发" "none" "2026-11-17T08:00:00+08:00" "false"

if [ "$fail" -eq 0 ]; then
  echo "全部通过"
else
  echo "有失败用例"
  exit 1
fi
