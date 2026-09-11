#!/bin/bash
# 直接验证 bwrap 参数构造在真实 Linux 上的行为（定位自检失败原因）
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -uo pipefail

ROOT=$(mktemp -d /tmp/omb-bwrap-diag-XXXX)
ALLOWED="$ROOT/allowed"; DENIED="$ROOT/denied"; BADTMP="$ROOT/badtmp"
mkdir -p "$ALLOWED" "$DENIED" "$BADTMP"
cat > "$ROOT/probe.cjs" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const [allowed, denied, resultFile] = process.argv.slice(2);
const probe = (d) => { try { fs.writeFileSync(path.join(d, '.probe'), 'x'); return 'ALLOW'; } catch (e) { return (e && e.code) ? e.code : String(e); } };
fs.writeFileSync(resultFile, JSON.stringify({ allowed: probe(allowed), denied: probe(denied), tmpdirSeen: process.env.TMPDIR }));
EOF

echo "=== 变体 A：当前实现（--tmpfs /tmp，然后 --bind <hostTmpSubdir> <same>） ==="
# 模拟 os.tmpdir()=/tmp 时 sandbox-posix 的构造：tempDir = /tmp/omb-sandbox-XXXX（$BADTMP 就在 /tmp 下）
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --new-session --die-with-parent \
  --bind "$ALLOWED" "$ALLOWED" --bind "$BADTMP" "$BADTMP" \
  --chdir "$ALLOWED" --setenv OMB_SANDBOX_RESULT_FILE "$ALLOWED/r.json" --setenv TMPDIR "$BADTMP" \
  node "$ROOT/probe.cjs" "$ALLOWED" "$DENIED" "$ALLOWED/r.json"
echo "退出码=$?  结果文件存在=$([ -f "$ALLOWED/r.json" ] && echo yes || echo no)"
[ -f "$ALLOWED/r.json" ] && cat "$ALLOWED/r.json"; echo

echo
echo "=== 变体 B：去掉 --tmpfs /tmp ==="
rm -f "$ALLOWED/r.json"
bwrap --ro-bind / / --dev /dev --proc /proc \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --new-session --die-with-parent \
  --bind "$ALLOWED" "$ALLOWED" --bind "$BADTMP" "$BADTMP" \
  --chdir "$ALLOWED" --setenv OMB_SANDBOX_RESULT_FILE "$ALLOWED/r.json" --setenv TMPDIR "$BADTMP" \
  node "$ROOT/probe.cjs" "$ALLOWED" "$DENIED" "$ALLOWED/r.json"
echo "退出码=$?  结果文件存在=$([ -f "$ALLOWED/r.json" ] && echo yes || echo no)"
[ -f "$ALLOWED/r.json" ] && cat "$ALLOWED/r.json"; echo

echo
echo "=== 变体 C：把私有 temp 挂到命名空间内独立路径 /omb-tmp（宿主 temp 不进绑定源） ==="
rm -f "$ALLOWED/r.json"
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /omb-tmp \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --new-session --die-with-parent \
  --bind "$ALLOWED" "$ALLOWED" \
  --chdir "$ALLOWED" --setenv OMB_SANDBOX_RESULT_FILE "$ALLOWED/r.json" --setenv TMPDIR "/omb-tmp" \
  node "$ROOT/probe.cjs" "$ALLOWED" "$DENIED" "$ALLOWED/r.json"
echo "退出码=$?  结果文件存在=$([ -f "$ALLOWED/r.json" ] && echo yes || echo no)"
[ -f "$ALLOWED/r.json" ] && cat "$ALLOWED/r.json"; echo

echo
echo "=== 变体 D：不挂 /tmp（继承宿主 /tmp 只读），私有 temp 仍需可写 → 用 writableDirs 之一 ==="
rm -f "$ALLOWED/r.json"
bwrap --ro-bind / / --dev /dev --proc /proc \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --new-session --die-with-parent \
  --bind "$ALLOWED" "$ALLOWED" --bind "$BADTMP" "$BADTMP" \
  --chdir "$ALLOWED" --setenv OMB_SANDBOX_RESULT_FILE "$ALLOWED/r.json" --setenv TMPDIR "$BADTMP" \
  sh -c 'echo "  宿主 /tmp 在命名空间内可写？"; (touch /tmp/omb-host-write-probe && echo "  /tmp 可写(!)" || echo "  /tmp 不可写(预期)")'
echo "注意：变体 D 的 /tmp 是只读绑定（--ro-bind / / 的结果），故 BADTMP 绑定源存在且可写覆盖之"

echo
echo "=== 命名空间内 /tmp 与绑定源可见性检查 ==="
bwrap --ro-bind / / --tmpfs /tmp --unshare-user --unshare-pid sh -c 'ls -la /tmp | head -3; echo "---"; ls -d '"$BADTMP"' 2>&1 | head -2'
rm -rf "$ROOT"
