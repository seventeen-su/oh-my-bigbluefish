#!/bin/bash
# 容器内：验证真实 Linux 下 OMB 的平台层（bwrap 通道 / 只读 / 路径口径 / 三线布局）
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /root/omb

echo "=== 平台指纹 ==="
node -e "console.log(process.platform, process.version)"

echo
echo "=== ① 平台提供者 + 受通道自检（source 布局直接跑 TS：用 tsx） ==="
cat > /root/omb/platform-probe.mts <<'EOF'
import { platformProvider, resetPlatformProviderCache } from './substrate/platform.js';
import { sandboxStatusAsync, sandboxStatus, runRestricted } from './substrate/sandbox.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

resetPlatformProviderCache();
const p = platformProvider();
console.log('caps:', JSON.stringify(p.caps, null, 2));

const st = await sandboxStatusAsync();
console.log('sandboxStatusAsync:', JSON.stringify(st, null, 2));
const sy = sandboxStatus();
console.log('sandboxStatus(sync).self_test_note:', sy.self_test_note);

// 只读机制（POSIX 权限位）真机验证：施加 → 写被拒 → 释放 → 写恢复
if (p.readOnly !== null) {
  const dir = mkdtempSync(join(tmpdir(), 'omb-ro-'));
  writeFileSync(join(dir, 'seed.txt'), 'seed');
  console.log('readOnly.isReadOnly(初始) =', p.readOnly.isReadOnly(dir));
  p.readOnly.apply(dir);
  console.log('readOnly.isReadOnly(施加后) =', p.readOnly.isReadOnly(dir));
  let denied = 'NO';
  try { writeFileSync(join(dir, 'x.txt'), 'x'); denied = 'WROTE(!)'; } catch (e) { denied = e.code; }
  console.log('施加后写探测 =', denied);
  p.readOnly.reset(dir);
  console.log('readOnly.isReadOnly(释放后) =', p.readOnly.isReadOnly(dir));
  rmSync(dir, { recursive: true, force: true });
}

// 真实受限执行（若通道可用）：脚本写候选目录必须被拒
if (st.available) {
  const root = mkdtempSync(join(tmpdir(), 'omb-exec-'));
  const cand = join(root, 'cand'); const out = join(root, 'out');
  mkdirSync(cand); mkdirSync(out);
  const script = join(cand, 'verify.cjs');
  writeFileSync(script, `
const fs=require('node:fs');const path=require('node:path');
const [candDir,outDir]=process.argv.slice(2);
let probe;try{fs.writeFileSync(path.join(candDir,'leak.txt'),'x');probe='LEAK'}catch(e){probe=e.code||String(e)}
fs.writeFileSync(process.env.OMB_SANDBOX_RESULT_FILE, JSON.stringify({probe, cwd: process.cwd()}));
`);
  const resultFile = join(out, 'result.json');
  try {
    const r = await runRestricted({
      script, args: [cand], cwd: cand, writableDirs: [out], resultFile, timeoutMs: 20000,
    });
    console.log('runRestricted 退出码 =', r.code, 'timedOut =', r.timedOut);
    console.log('结果文件 =', readFileSync(resultFile, 'utf8'));
  } catch (e) {
    console.log('runRestricted 抛错 =', (e as Error).message);
  }
  rmSync(root, { recursive: true, force: true });
} else {
  console.log('受限通道不可用 → 跳过真实执行验证（通道原因见上）');
}
EOF
pnpm exec tsx platform-probe.mts 2>&1 | tail -40
