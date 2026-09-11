#!/bin/bash
# 在容器内安装 Node（默认 Node 24 LTS 最新版；与开发机 D 盘同 major，便于行为对齐）
set -euo pipefail
MAJOR="${1:-24}"
IDX=$(curl -fsSL https://nodejs.org/dist/index.tab)
# 选该 major 下最新的 LTS（lts 列非 '-'）；若都非 LTS 则取最新
V=$(printf '%s\n' "$IDX" | awk -F'\t' -v m="v$MAJOR." '$1 ~ ("^" m) && $10 != "-" {print $1}' | head -1)
if [ -z "$V" ]; then
  V=$(printf '%s\n' "$IDX" | awk -F'\t' -v m="v$MAJOR." '$1 ~ ("^" m) {print $1}' | head -1)
fi
echo "选中 Node: $V（major=$MAJOR）"
cd /tmp
curl -fsSL -o node.tar.xz "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
tar -xJf node.tar.xz -C /usr/local --strip-components=1
rm -f node.tar.xz
node --version
npm --version
echo "--- Node 权限模型自检（本仓 POSIX 兜底通道依赖它） ---"
T=$(mktemp -d)
printf "const fs=require('node:fs');const p=process.argv[2];let r;try{fs.writeFileSync(p+'/x','1');r='ALLOW'}catch(e){r=e.code}process.stdout.write('write='+r)\n" > "$T/p.cjs"
node --permission --allow-fs-read="$T" --allow-fs-write="$T" "$T/p.cjs" "$T"; echo
rm -rf "$T"
