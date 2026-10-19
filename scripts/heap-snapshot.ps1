# OMB heap snapshot 取证脚本（v4.5.3）
#
# 两种模式，**数据不可混为一谈**：
#   -Mode repro（默认）：原始故障复现。保留现有 NODE_OPTIONS 里的堆参数，
#                        只追加 --heapsnapshot-near-heap-limit=1。
#   -Mode early：提前取证。主动把 --max-old-space-size 降到 -HeapMB，
#                让快照在进程耗尽前触发；它改变了原始故障条件，不能当作
#                原始 4GB OOM 的等价复现。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/heap-snapshot.ps1
#   powershell ... -Mode early -HeapMB 2048 -DshPath D:\Program\deepseek-harness
#   powershell ... -NoLaunch            # 只打印合并后的 NODE_OPTIONS 与检查结果
#
# 运行前会检查：快照目录剩余空间、NODE_OPTIONS 冲突、快照来源 PID 职责。
# 运行后会：核对新生成快照的 PID、打印职责判断、按 -Keep 清理更早快照。
# 快照含提示词/会话/路径等敏感字符串，属敏感诊断材料，不要提交或公开分享。
[CmdletBinding()]
param(
  [ValidateSet('repro', 'early')]
  [string]$Mode = 'repro',
  [int]$HeapMB = 2048,
  [string]$DshPath = 'D:\Program\deepseek-harness',
  [string]$SnapshotDir = '',
  [int]$Keep = 3,
  [int]$MinFreeGB = 4,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$startedAt = Get-Date

function Write-Warn([string]$Message) { Write-Host "⚠ $Message" -ForegroundColor Yellow }
function Write-Info([string]$Message) { Write-Host $Message }

function Split-NodeOptions([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return @() }
  $pattern = '"(?:[^"\\]|\\.)*"|\S+'
  return @([regex]::Matches($Value, $pattern) | ForEach-Object { $_.Value })
}

function Quote-NodeOption([string]$Token) {
  if ($Token -match '\s' -and -not $Token.StartsWith('"')) { return '"' + $Token + '"' }
  return $Token
}

function Get-FreeBytes([string]$Path) {
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::IsNullOrEmpty($root)) { return $null }
    $drive = [System.IO.DriveInfo]::new($root)
    if (-not $drive.IsReady) { return $null }
    return [double]$drive.AvailableFreeSpace
  } catch {
    return $null
  }
}

function Format-GB([double]$Bytes) {
  return ('{0:N1} GB' -f ($Bytes / 1GB))
}

function Resolve-SnapshotPid([string]$Name) {
  # Node 的自动快照名通常为 Heap.<date>.<time>.<pid>.<seq>.heapsnapshot，
  # 也见过不带 seq 的变体；两种都试，取不到就返回 $null（不猜）。
  $m = [regex]::Match($Name, '\.(\d+)\.\d+\.heapsnapshot$')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  $m = [regex]::Match($Name, '\.(\d+)\.heapsnapshot$')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return $null
}

function Test-MainHostCommandLine([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $hasDsh = $CommandLine -match '(?i)(deepseek-harness|dsh|bin\.ts)'
  $hasWeb = $CommandLine -match '(?i)\bweb\b'
  return ($hasDsh -and $hasWeb)
}

if (-not (Test-Path -LiteralPath $DshPath)) {
  Write-Error "DSH checkout 不存在：$DshPath（用 -DshPath 指定）"
  exit 1
}
if ([string]::IsNullOrWhiteSpace($SnapshotDir)) {
  $SnapshotDir = Join-Path $DshPath '.omb\heap'
}
if ($Mode -eq 'early' -and ($HeapMB -lt 256)) {
  Write-Error "-Mode early 的 -HeapMB 过小（$HeapMB MB）：宿主可能启动即失败，得不到快照。"
  exit 1
}

try {
  New-Item -ItemType Directory -Force -Path $SnapshotDir | Out-Null
} catch {
  Write-Error "快照目录不可用：$SnapshotDir——$($_.Exception.Message)"
  exit 1
}

# ── 磁盘检查 ───────────────────────────────────────────────────────────────
$freeBytes = Get-FreeBytes $SnapshotDir
if ($null -eq $freeBytes) {
  Write-Warn "无法测量 $SnapshotDir 的剩余空间（不冒充 0）；写入可能因磁盘耗尽失败。"
  $minFreeBytes = [double]$MinFreeGB * 1GB
} else {
  Write-Info "快照目录：$SnapshotDir；剩余空间 $(Format-GB $freeBytes)（最低要求 $MinFreeGB GB）"
  if ($freeBytes -lt ([double]$MinFreeGB * 1GB)) {
    Write-Error "磁盘空间不足：可用 $(Format-GB $freeBytes) < $MinFreeGB GB。拒绝启动取证（写到一半耗尽磁盘会让故障更难恢复）。"
    exit 1
  }
}

# ── NODE_OPTIONS：保留兼容参数，显式处理冲突 ──────────────────────────────
$oldNodeOptions = $env:NODE_OPTIONS
$tokens = @(Split-NodeOptions $oldNodeOptions)
$kept = New-Object System.Collections.Generic.List[string]
$snapshotFlagSeen = $false
$heapFlags = New-Object System.Collections.Generic.List[string]

foreach ($token in $tokens) {
  if ($token -match '^--heapsnapshot-near-heap-limit(=|$)') {
    $snapshotFlagSeen = $true
    continue
  }
  if ($token -match '^--max-old-space-size(=|$)') {
    $heapFlags.Add($token) | Out-Null
    if ($Mode -eq 'repro') {
      $kept.Add($token) | Out-Null
    }
    continue
  }
  # 旧拼写也认（Node 仍接受下划线形式）
  if ($token -match '^--max_old_space_size(=|$)') {
    $heapFlags.Add($token) | Out-Null
    if ($Mode -eq 'repro') {
      $kept.Add($token) | Out-Null
    }
    continue
  }
  $kept.Add($token) | Out-Null
}

if ($heapFlags.Count -gt 0) {
  if ($Mode -eq 'repro') {
    Write-Info "NODE_OPTIONS 原有堆上限参数（repro 模式保留）：$($heapFlags -join ' ')"
  } else {
    Write-Warn "early 模式移除原有堆上限参数：$($heapFlags -join ' ')（替换为 --max-old-space-size=$HeapMB）"
  }
}
if ($snapshotFlagSeen) {
  Write-Warn 'NODE_OPTIONS 已含 --heapsnapshot-near-heap-limit，脚本将替换为 =1（同一项只保留一个）'
}

$kept.Add('--heapsnapshot-near-heap-limit=1') | Out-Null
if ($Mode -eq 'early') {
  $kept.Add("--max-old-space-size=$HeapMB") | Out-Null
}
$newNodeOptions = ($kept | ForEach-Object { Quote-NodeOption $_ }) -join ' '
$env:NODE_OPTIONS = $newNodeOptions

Write-Info "模式：$Mode"
if ($Mode -eq 'repro') {
  Write-Info '  → 原始故障复现：保留原有堆上限，只增加“接近堆上限时写快照”；数据可与原始故障对照。'
} else {
  Write-Warn "  → 提前取证：堆上限被改为 $HeapMB MB，改变了原始故障条件；不能当作原始 4GB OOM 的等价复现。"
}
Write-Info "NODE_OPTIONS（启动期间）：$newNodeOptions"
Write-Warn 'NODE_OPTIONS 会被子 Node 进程继承；快照可能来自子进程。写完会核对 PID 与职责。'
Write-Warn '快照含提示词、会话内容、路径等敏感字符串，属敏感诊断材料：不要提交到仓库、不要公开分享。'

if ($NoLaunch) {
  if ($null -eq $oldNodeOptions) { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
  else { $env:NODE_OPTIONS = $oldNodeOptions }
  Write-Info '-NoLaunch：只做检查与参数合并，不启动 dsh web。'
  exit 0
}

# ── 启动并取证 ─────────────────────────────────────────────────────────────
$launchError = $null
Push-Location -LiteralPath $DshPath
try {
  pnpm dsh web
  if ($LASTEXITCODE -ne 0) { $launchError = "pnpm dsh web 退出码 $LASTEXITCODE" }
} catch {
  $launchError = $_.Exception.Message
} finally {
  Pop-Location
  if ($null -eq $oldNodeOptions) { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
  else { $env:NODE_OPTIONS = $oldNodeOptions }
  Write-Info "已恢复 NODE_OPTIONS：$(if ($null -eq $oldNodeOptions) { '<未设置>' } else { $oldNodeOptions })"
}

if ($null -ne $launchError) {
  Write-Error "启动失败：$launchError"
  exit 1
}

# ── 核对新生成的快照：PID 与职责 ───────────────────────────────────────────
$newSnapshots = @(Get-ChildItem -LiteralPath $SnapshotDir -Filter '*.heapsnapshot' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge $startedAt.AddSeconds(-2) } |
  Sort-Object LastWriteTime)

if ($newSnapshots.Count -eq 0) {
  Write-Warn '本次运行没有生成新快照（可能未接近堆上限、或进程被系统直接终止）。'
  Write-Info '若是原始 OOM 但未触发 near-limit 快照，检查是否被 OOM killer/系统内存不足直接杀掉。'
} else {
  foreach ($snap in $newSnapshots) {
    $pidValue = Resolve-SnapshotPid $snap.Name
    Write-Info "新快照：$($snap.FullName)（$([math]::Round($snap.Length / 1MB, 0)) MB）"
    if ($null -eq $pidValue) {
      Write-Warn '无法从文件名解析 PID；不能确认快照属于哪个进程。'
      continue
    }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
      Write-Warn "快照 PID=$pidValue 的进程已退出（OOM/崩溃后常见），无法核对职责；只能按文件名与运行时段推断。"
      continue
    }
    Write-Info "  快照 PID=$pidValue，进程=$($proc.Name)"
    Write-Info "  CommandLine=$($proc.CommandLine)"
    if (Test-MainHostCommandLine $proc.CommandLine) {
      Write-Info '  ✓ 该 PID 看起来是 DSH 主宿主进程（命令行含 dsh/bin.ts 与 web）。'
    } else {
      Write-Warn '  该 PID 不是可识别的 DSH 主宿主进程：可能是子 Node 进程。子进程的 retained set 不能代表宿主内存。'
    }
  }
}

# ── 保留策略 ───────────────────────────────────────────────────────────────
$all = @(Get-ChildItem -LiteralPath $SnapshotDir -Filter '*.heapsnapshot' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending)
if ($all.Count -gt $Keep) {
  $toRemove = $all | Select-Object -Skip $Keep
  foreach ($file in $toRemove) {
    try {
      Remove-Item -LiteralPath $file.FullName -Force
      Write-Info "已删除更早快照：$($file.Name)"
    } catch {
      Write-Warn "删除旧快照失败：$($file.Name)——$($_.Exception.Message)"
    }
  }
}
Write-Info "快照保留：最近 $Keep 份（目录 $SnapshotDir）"
