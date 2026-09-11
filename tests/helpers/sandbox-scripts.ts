// 测试辅助：受限执行验证脚本的共用片段（**平台无关**）。
//
// 真机教训（2026-09，Debian 13）：多个测试里的候选验证脚本把"写被拒"硬编码为 Windows 错误码
// （`probe === 'EPERM' || probe === 'EACCES'`）→ 在 Linux 上 bwrap 的写拒绝码是 **EROFS**
// （只读挂载），脚本据此判自己"未通过验证"，于是这些用例在真机上把**正确行为**判成了失败。
//
// 写被拒的合法码（三者语义相同，只是通道不同）：
//   - `EPERM` / `EACCES`：Windows 受限令牌、Node 权限模型（EACCES / ERR_ACCESS_DENIED）；
//   - `EROFS`：bwrap 的只读挂载（Linux 首选通道）。
// 任何**非** `LEAK` 的结果都说明"写没成功"——但只有白名单里的码才算"被拒"（未知码可能是别的故障，
// 不该被当成通过）。`LEAK` 永远是不通过（沙盒语义失效）。

/** 写被拒的合法错误码（判"沙盒语义成立"） */
export const WRITE_DENIED_CODES = ['EPERM', 'EACCES', 'EROFS', 'ERR_ACCESS_DENIED'] as const;

/**
 * 生成候选验证脚本源码（受限子进程路径用）：尝试写候选目录（不在 writableDirs → 必须被拒），
 * 结果经 `OMB_SANDBOX_RESULT_FILE` 回传；`ok` 只在"写确实被拒"时为 true。
 */
export function restrictedVerifyScript(opts: { detail?: string } = {}): string {
  const detail = opts.detail ?? 'verify ok';
  return `const fs = require('node:fs');
const path = require('node:path');
const resultFile = process.env.OMB_SANDBOX_RESULT_FILE;
const candDir = process.argv[2];
let probe = 'NONE';
try {
  fs.writeFileSync(path.join(candDir, 'write-probe.txt'), 'x');
  probe = 'LEAK';
} catch (e) {
  probe = e && e.code ? e.code : String(e);
}
const DENIED = ${JSON.stringify([...WRITE_DENIED_CODES])};
const ok = DENIED.includes(probe);
fs.writeFileSync(resultFile, JSON.stringify({ ok, detail: '${detail}; write-denied=' + probe }));
`;
}

/** 断言辅助：从验证 detail 文本里取写拒绝码（排障/断言共用） */
export function deniedCodeOf(detail: string | undefined): string {
  const m = /write-denied=([A-Z_]+)/.exec(detail ?? '');
  return m?.[1] ?? 'UNKNOWN';
}
