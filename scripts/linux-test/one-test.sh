#!/bin/bash
# 跑单个测试文件并打印 G3-exec 判定细节（真机排障用）
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /root/omb
FILE="${1:-tests/m8/dynamic-runner.test.ts}"
FILTER="${2:-}"
if [ -n "$FILTER" ]; then
  pnpm exec vitest run "$FILE" -t "$FILTER" > /root/one.log 2>&1
else
  pnpm exec vitest run "$FILE" > /root/one.log 2>&1
fi
echo "退出码=$?"
grep -nE 'g3Exec|kind=|detail|Error|passed' /root/one.log | head -40
