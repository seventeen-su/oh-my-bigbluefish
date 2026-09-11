// layer 0（substrate/）：路径比较口径（**删除安全**与**根判定**共用的唯一裁决点）。
//
// 已知问题《路径大小写被无条件放大》修复：跨平台删除/越界判定此前在所有平台上无条件 `toLowerCase()`
// 比较，并用无分隔符边界的前缀匹配：
//   - 大小写敏感文件系统（Linux）上 `/srv/app/Workspace/x.md` 会被判为在 `/srv/app/workspace` 之内
//     → 读取声明根之外的文件并标记"可恢复"（制品索引）；
//   - 前缀匹配无分隔符边界 → 自定义 `initialBase=/tmp2/omb` 会被 `/tmp` 前缀命中 → **误删**另一份配置的目录
//     （线快照清理）。
//
// 本模块把两件事收敛成一条纪律：
//   1. **大小写口径按平台**：Windows / macOS（默认 APFS、HFS+ 大小写不敏感）→ 不敏感比较；其余（Linux
//      等大小写敏感文件系统）→ 敏感比较。不再在 Linux 上"无条件放大"大小写。
//   2. **边界按分隔符**：`under` 判定以分隔符为界（`/tmp` 不吃 `/tmp2/omb`），根自身单独判等。
//
// 层 DAG（CONVENTIONS §4）：仅 node: 内置（本模块是纯字符串判定，不需要任何 import）。

/**
 * 该平台的文件系统路径是否大小写不敏感（判定删除/越界安全时使用）。
 * macOS 缺省 APFS/HFS+ 为大小写不敏感（可有例外卷，但删除安全取"更保守=更不敏感"的一侧）；
 * 其余平台按大小写敏感处理（Linux 等），避免把不同目录判成同一个。
 */
export function pathCaseInsensitive(platform: string = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** 按平台口径归一化（大小写敏感平台原样返回；不敏感平台小写化） */
export function normalizeForCompare(p: string, platform: string = process.platform): string {
  return pathCaseInsensitive(platform) ? p.toLowerCase() : p;
}

/** 去尾分隔符（保留根：'/'、'\\'、'C:'、'C:\' 不裁成空串/裸盘符） */
function stripTrailingSeparators(p: string): string {
  let out = p;
  while (out.length > 1 && (out.endsWith('/') || out.endsWith('\\'))) {
    const next = out.slice(0, -1);
    // 保留 Windows 盘根（'C:\' → 'C:' 后会丢掉根语义）与已到根的情形
    if (/^[A-Za-z]:$/.test(next)) {
      return out;
    }
    out = next;
  }
  return out;
}

/**
 * `child` 是否等于 `root` 或在其**之下**（以分隔符为边界；大小写口径按平台）。
 * 入参应是已 resolve 的绝对路径（调用方各自 resolve——本函数不做 fs 访问）。
 * 边界纪律：`/tmp` 不吃 `/tmp2/omb`——前缀匹配必须落在分隔符上（或以根的分隔符结尾）。
 */
export function isPathUnder(child: string, root: string, platform: string = process.platform): boolean {
  const c = normalizeForCompare(stripTrailingSeparators(child), platform);
  const r = normalizeForCompare(stripTrailingSeparators(root), platform);
  if (c === r) {
    return true;
  }
  // 同时容忍另一种分隔符形态（Windows 上 git 可能写出 '/'——worktree 注册表里两种都见过）
  const seps = platform === 'win32' ? ['\\', '/'] : ['/'];
  return seps.some((s) => r.endsWith(s) || c.startsWith(`${r}${s}`));
}

/**
 * `p` 是否在临时目录 `tmp` 内（线快照清理用：判定残留 worktree 是否物化在系统临时目录）。
 * 与 isPathUnder 同一口径——修复"前缀无边界命中 /tmp2/omb"的误删面。
 */
export function isUnderTempDir(p: string, tmp: string, platform: string = process.platform): boolean {
  return isPathUnder(p, tmp, platform);
}
