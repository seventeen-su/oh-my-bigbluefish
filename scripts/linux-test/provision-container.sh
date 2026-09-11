#!/bin/bash
# OMB Linux 真机测试容器准备脚本（在**宿主** root 下执行；用后删除容器，不污染宿主）
# 用途：为 Linux 适配提供真实 Linux 环境（bwrap + Node 权限模型 + POSIX 只读 + 三线布局）
#
# 环境无关：不绑定任何具体主机/地址/私钥；容器 ID 取 $CTID 或第一个参数，默认 9001。
# 调用方式见同目录 README.md（宿主经 ssh 别名给出，脚本本身只认 pct/pveam 是否可用）。
set -u
CTID="${CTID:-${1:-9001}}"
# 模板名按需覆盖（不同版本的模板文件名会变）：OMB_CT_TEMPLATE
TMPL="${OMB_CT_TEMPLATE:-local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst}"

echo "=== 0. 若已存在同名容器先清理（幂等） ==="
if pct status "$CTID" >/dev/null 2>&1; then
  pct stop "$CTID" --skiplock 1 >/dev/null 2>&1 || true
  sleep 2
  pct destroy "$CTID" --purge 1 >/dev/null 2>&1 || true
fi

echo "=== 1. 模板就绪 ==="
if ! pveam list local 2>/dev/null | grep -q "debian-13-standard"; then
  pveam download local "$(basename "$TMPL")"
fi

echo "=== 2. 创建非特权容器（nesting+keyctl：bwrap 需要用户命名空间） ==="
pct create "$CTID" "$TMPL" \
  --hostname omb-linux-test \
  --cores 6 --memory 8192 --swap 2048 \
  --rootfs local-zfs:16 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --onboot 0 \
  --description "OMB Linux 适配真机测试（临时；用后 pct destroy）"

echo "=== 3. 启动并等网络 ==="
pct start "$CTID"
for i in $(seq 1 60); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then
    echo "网络就绪（第 ${i} 次探测）"
    break
  fi
  sleep 2
done

echo "=== 4. 容器指纹 ==="
pct exec "$CTID" -- bash -lc 'cat /etc/os-release | head -3; uname -r; nproc; free -m | head -2'

echo "=== 5. 安装基础工具（git/curl/xz + bwrap + unzip） ==="
pct exec "$CTID" -- bash -lc 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git curl xz-utils bubblewrap unzip ca-certificates >/dev/null && echo "apt ok: $(bwrap --version)"'

echo "=== 6. 安装 Node 24（官方静态二进制，避免 apt 源版本偏旧） ==="
pct exec "$CTID" -- bash -lc '
set -e
V=$(curl -fsSL https://nodejs.org/dist/index.json | head -c 2000 | grep -o "\"version\":\"v24[^\"]*\"" | head -1 | cut -d\" -f4)
echo "选中的 Node 版本: $V"
cd /tmp
curl -fsSLO "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
tar -xJf "node-$V-linux-x64.tar.xz" -C /usr/local --strip-components=1
node --version && npm --version
'

echo "=== 7. 允许非特权用户命名空间（bwrap 在容器内的前置条件） ==="
pct exec "$CTID" -- bash -lc '
echo "unprivileged_userns_clone = $(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo n/a)"
echo "max_user_namespaces = $(cat /proc/sys/kernel/max_user_namespaces 2>/dev/null || echo n/a)"
sysctl -w kernel.unprivileged_userns_clone=1 2>/dev/null || true
# 若存在 apparmor 限制项则放开（Ubuntu 系特性，Debian 通常无此项）
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
echo "--- bwrap 冒烟 ---"
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-user --unshare-pid echo "bwrap OK"
'

echo "=== 8. 启用 pnpm（corepack） ==="
pct exec "$CTID" -- bash -lc 'corepack enable 2>/dev/null; corepack prepare pnpm@11.7.0 --activate 2>/dev/null; pnpm --version || echo "corepack 失败，用 npm 兜底"'

echo "=== 完成：容器 $CTID 已就绪 ==="
pct exec "$CTID" -- bash -lc 'ip -4 addr show eth0 | grep inet'
