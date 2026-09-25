/**
 * `git filter-branch --msg-filter` 用的过滤器：把提交信息压成简练单行。
 *
 * 从 stdin 读原始信息（首行是标题、其余是正文），向 stdout 写新信息。
 * 正文一并丢弃——目标形态就是"简练单行"，留着几百字的正文与目标相反。
 *
 * 单独成文件（而不是内联 `node -e`）：`--msg-filter` 每条提交都会 spawn 一次，
 * 内联脚本的引号转义在 Windows 上极易出错。
 */
import { readFileSync } from 'node:fs'
import { condense } from './condense-messages.mjs'

const raw = readFileSync(0, 'utf8')
const subject = raw.split('\n')[0] ?? ''
const next = condense(subject)
process.stdout.write(next === '' ? subject.trim() : next)
