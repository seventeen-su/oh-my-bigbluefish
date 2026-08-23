// 手动兜底：分享后初始化/修复三线布局与只读 ACL（`pnpm init-three-line`）。
// 独立于 DSH 运行（不加载 runtime，不依赖 DSH 进程），与插件启动自动初始化共用同一实现
//（substrate/bootstrap.ts ensureThreeLineLayout）。
// 退出码：0 = 布局就绪（ok/initialized/repaired）；1 = degraded（含修复失败）。
// CLI 风格仿 scripts/bench-report.ts：主逻辑在 main()，仅直接运行时执行（import 无副作用）。
import { pathToFileURL } from 'node:url';
import { ensureThreeLineLayout, defaultLayout } from '../substrate/bootstrap.js';

/** CLI 主逻辑（仅直接运行时执行；返回退出码，调用方设置 process.exitCode） */
export function main(): number {
  const r = ensureThreeLineLayout(defaultLayout());
  if (r.status === 'degraded') {
    console.error(`[init-three-line] 三线布局不可用（degraded）：${r.detail}`);
    return 1;
  }
  const label = r.status === 'initialized' ? '初始化完成' : r.status === 'repaired' ? '修复完成' : '检查通过';
  console.log(`[init-three-line] 三线布局${label}：${r.detail}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
