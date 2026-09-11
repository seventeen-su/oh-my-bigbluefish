#!/bin/bash
# 在容器内跑指定测试文件并汇总（真机验证用）
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /root/omb
pnpm exec vitest run "$@" > /root/sub-run.log 2>&1
echo "退出码=$?"
grep -E '^ +(Test Files|Tests) ' /root/sub-run.log | tail -2
echo "--- 失败用例 ---"
grep -E '^ FAIL ' /root/sub-run.log | sed 's/^ FAIL  //' | head -30
