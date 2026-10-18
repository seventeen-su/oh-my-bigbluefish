/**
 * 密钥/凭据模式识别（3.7 Wave 2）。
 *
 * ## 为什么单列一个文件
 *
 * 两条写入路径都要在**落库之前**拒绝密钥：
 * - `omb_remember`（模型主动，`decideAdmission`）；
 * - 自主捕获（`capture.ts`，事件驱动，不经过准入）。
 *
 * 同一份模式表放在两处必然漂移（本项目"同一事实存两遍"已经付过代价），
 * 所以抽成一个零依赖纯函数模块。
 *
 * ## 判据是"形态"不是"语义"
 *
 * 只认已知凭据前缀/明文赋值形态（`sk-`、`AKIA`、`ghp_`、`glpat-`、`xox?-`、
 * OpenSSH/RSA 私钥块、`ssh-rsa AAAA…`、`password=`/`token=` 明文）。
 * **不做**熵检测（会误杀哈希、base64 工件、正常长标识符——本项目按哈希定位一切）。
 * 漏掉的凭据由用户显式 `omb_forget` 兜底；错杀一条「结论里带 `token=`」是可恢复的。
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI / Anthropic 风格
  /\bsk-[A-Za-z0-9_-]{16,}/,
  // AWS access key
  /\bAKIA[0-9A-Z]{16}\b/,
  // GitHub token（含 fine-grained / app / user / server）
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  // GitLab PAT
  /\bglpat-[\w-]{16,}/,
  // Slack token
  /\bxox[baprs]-[\w-]{10,}/,
  // 私钥块（RSA / EC / OPENSSH / PKCS8 都覆盖）
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // SSH 公钥行（不是密钥本体，但属于"不建议逐字存"的本机凭据面）
  /\bssh-(?:rsa|ed25519|dss)\s+AAAA[A-Za-z0-9+/=]{20,}/,
  // 明文赋值
  /\b(?:password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key)\b\s*[:=]\s*\S{6,}/i,
  // Bearer / Basic 认证头
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._+/=-]{20,}/i,
]

/** 文本是否含凭据形态。**空/非字符串一律 false**（调用方无需判断类型）。 */
export function hasSecret(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}
