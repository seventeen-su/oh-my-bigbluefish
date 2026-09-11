#!/bin/bash
# 从 Linux 测试日志抽取每个失败文件的首条原因（真机排障用）
LOG=${1:-/root/linux-run.log}
awk '
  /^ FAIL / {
    line=$0
    sub(/^ FAIL  /,"",line)
    split(line, parts, " > ")
    file=parts[1]
    if (!(file in first)) { first[file]=1; cur=file; print "\n--- " file }
    next
  }
  /^ *(AssertionError|Error|TypeError|ReferenceError|RangeError)/ {
    if (cur!="" && shown[cur] < 1) { print "    " substr($0,1,200); shown[cur]++ }
  }
' "$LOG"
