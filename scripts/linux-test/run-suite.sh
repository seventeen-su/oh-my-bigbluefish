#!/bin/bash
# 在容器内跑全量测试并汇总失败清单（Linux 真机基线）
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /root/omb
pnpm exec vitest run > /root/linux-run.log 2>&1
echo "退出码=$?"
echo "=== 汇总 ==="
grep -E '^ +(Test Files|Tests) ' /root/linux-run.log | tail -2
echo "=== 失败文件 ==="
grep -E '^ FAIL ' /root/linux-run.log | sed 's/ >.*//' | sort -u
echo "=== 失败数 ==="
grep -cE '^ FAIL ' /root/linux-run.log
