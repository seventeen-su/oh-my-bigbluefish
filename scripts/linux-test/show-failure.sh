#!/bin/bash
# 打印指定测试文件在 Linux 日志中的失败详情
LOG=/root/linux-run.log
PAT="$1"
awk -v pat="$PAT" '
  $0 ~ ("FAIL  " pat) { hit=1 }
  hit { print; n++ }
  n > 45 { exit }
' "$LOG"
