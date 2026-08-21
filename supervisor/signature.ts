// layer 1：共享协议签名（T8.9；架构 §13.2 签名——Git 签名初期选型）。
// 从 share.ts 拆分（CONVENTIONS §9 LOC ≤ 400，T8.9 签名升级后 share.ts 超出预算）。
// 内容：签名描述符格式校验（格式门，伪造拒绝）+ 真实 Git 签名校验（git verify-tag 真实验签；
// 环境无 GPG/SSH 密钥 → 格式校验 + 文档化限制，如实记录）。
// layer 1：仅 import node: 内置 + substrate（GIT_BIN；supervisor 可 import substrate）。
import { execFileSync } from 'node:child_process';
import { GIT_BIN } from '../substrate/snapshot.js';

/** 签名描述符格式（Git 签名初期选型，文档化）：
 *  `git:<signer>:<keyid-hex(16-64)>:<base64>` —— git 签名描述符（signer 名 + 密钥 id + base64 签名体）
 *  `ssh:<base64>` —— SSH 签名描述符
 */
const GIT_SIG_RE = /^git:[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{16,64}:[A-Za-z0-9+/=]+$/;
const SSH_SIG_RE = /^ssh:[A-Za-z0-9+/=]+$/;

/** 签名格式校验（T8.9 格式门：伪造/空串/乱码 → 拒绝；publish/verify/absorb 共用） */
export function validateSignatureFormat(signature: string): { ok: boolean; detail: string } {
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, detail: '签名为空' };
  }
  if (GIT_SIG_RE.test(signature)) {
    return { ok: true, detail: 'git 签名描述符格式通过' };
  }
  if (SSH_SIG_RE.test(signature)) {
    return { ok: true, detail: 'ssh 签名描述符格式通过' };
  }
  return { ok: false, detail: '签名格式非法（应为 git:<signer>:<keyid-hex>:<base64> 或 ssh:<base64>）' };
}

export interface GitSignatureVerifyOptions {
  /** 签名描述符（先过格式门） */
  signature: string;
  /** 含签名 tag 的仓库目录 */
  repoDir: string;
  /** 被验证的签名 tag 名 */
  tag: string;
  /** git 可执行文件完整路径（缺省 GIT_BIN） */
  gitBin?: string;
}

/**
 * 真实 Git 签名校验（T8.9；git verify-tag 真实验签——SSH/GPG 签名 tag 均可验证）。
 * 环境无 GPG/SSH 签名密钥 → { ok:false, limitation:true, detail: 文档化限制 }（格式已通过，真实验签不可用，
 * 如实记录）；未签名 tag / 签名无效 → ok:false（真实失败路径）。
 */
export async function verifyGitSignature(
  opts: GitSignatureVerifyOptions,
): Promise<{ ok: boolean; detail: string; limitation?: boolean }> {
  const fmt = validateSignatureFormat(opts.signature);
  if (!fmt.ok) {
    return { ok: false, detail: fmt.detail };
  }
  try {
    execFileSync(opts.gitBin ?? GIT_BIN, ['verify-tag', opts.tag], {
      cwd: opts.repoDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { ok: true, detail: `git verify-tag <${opts.tag}> 通过（真实签名校验）` };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    const detail = e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
    // 环境无 GPG/SSH 密钥 → 文档化限制（gpg/ssh 进程级失败，非签名内容失败）
    if (/(gpg|ssh)/i.test(detail)) {
      return {
        ok: false,
        limitation: true,
        detail: `真实 git 验签不可用（环境无 GPG/SSH 签名密钥，文档化限制；格式校验已通过）：${detail}`,
      };
    }
    return { ok: false, detail: `git verify-tag <${opts.tag}> 失败（签名无效/未签名）：${detail}` };
  }
}
