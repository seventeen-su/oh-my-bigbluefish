# OMB OOM 取证脚本：按需生成 Node heap snapshot
#
# 用法（在仓库根或任意目录）：
#   powershell -ExecutionPolicy Bypass -File scripts/heap-snapshot.ps1
#   powershell ... -File scripts/heap-snapshot.ps1 -HeapMB 2048 -DshPath D:\Program\deepseek-harness
#
# 说明：
# - `--heapsnapshot-near-heap-limit=1`：堆接近上限时自动写 `.heapsnapshot`；
# - `--max-old-space-size=2048`：把上限降到 2GB，让快照更早、更小（仍保留 20% 余量给 native/ONNX）；
# - 快照默认写到当前工作目录（脚本会切到 -DshPath）；单个文件可能接近 2GB，先确认磁盘空间；
# - 用 Chrome DevTools → Memory → Load 打开快照，按 Retained Size 排序看最大对象。
param(
  [int]$HeapMB = 2048,
  [string]$DshPath = 'D:\Program\deepseek-harness'
)

if (-not (Test-Path -LiteralPath $DshPath)) {
  Write-Error "DSH checkout 不存在：$DshPath（用 -DshPath 指定）"
  exit 1
}

$old = $env:NODE_OPTIONS
$env:NODE_OPTIONS = "--heapsnapshot-near-heap-limit=1 --max-old-space-size=$HeapMB"
Write-Host "NODE_OPTIONS=$env:NODE_OPTIONS"
Write-Host "启动 dsh web（$DshPath）；接近 ${HeapMB}MB 时会在该目录写出 .heapsnapshot"
Push-Location -LiteralPath $DshPath
try {
  pnpm dsh web
} finally {
  Pop-Location
  $env:NODE_OPTIONS = $old
}
